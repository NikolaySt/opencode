/**
 * Maintenance Engine
 *
 * Keeps the memory store current by detecting staleness, expiring
 * old summaries, migrating embeddings on model changes, and
 * detecting contradictions between entries.
 *
 * Runs: hourly cron + after each sync + after each extraction.
 *
 * Five subsystems:
 * A. Staleness detection (referenced files changed/deleted)
 * B. Summary lifecycle (TTL, count cap, auto-promote)
 * C. Model migration (re-embed on config change)
 * D. Contradiction detection (semantic similarity between entries)
 * E. Orphan cleanup (deprecated entries, entity orphans)
 */

import fs from "fs"
import path from "path"
import { Log } from "../util/log"
import type { Store } from "./store"
import type { EmbeddingProvider } from "./embed"
import { cosine, deserialize, serialize } from "./embed"
import type { ResolvedConfig } from "./config"
import * as Metrics from "./metrics"

const log = Log.create({ service: "memory.maintain" })

export type MaintenanceReport = {
  staleDeprecated: number
  staleDisputed: number
  summariesDeleted: number
  promoted: number
  migrated: number
  cleanedUp: number
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

/** Extract file paths from text using a simple regex.
 *  Only returns paths that contain a directory separator (/) to avoid
 *  false positives from bare filenames like "handler.ts".
 */
function extractPaths(text: string): string[] {
  const paths: string[] = []
  const pattern = /(?:^|\s|['"`(])([a-zA-Z0-9_./-]{2,}(?:\.[a-zA-Z]{1,10}))/g
  for (const match of text.matchAll(pattern)) {
    const p = match[1]
    // Require at least one slash to be considered a file path reference.
    // Bare filenames (e.g. "handler.ts") are too ambiguous for staleness.
    if (p.includes("/")) {
      paths.push(p)
    }
  }
  return paths
}

// =========================================================================
// A. Staleness Detection
// =========================================================================

/**
 * Check session summary chunks for references to files that no longer
 * exist or have changed. Mark stale entries as deprecated/disputed.
 */
export function detectStale(store: Store, worktree: string): { deprecated: number; disputed: number } {
  const summaryChunks = store.chunksBySource("sessions")
  log.debug("detectStale: checking chunks", { count: summaryChunks.length, worktree })
  let deprecated = 0
  let disputed = 0

  for (const chunk of summaryChunks) {
    if (chunk.truth_state === "deprecated") continue

    const paths = extractPaths(chunk.text)
    if (paths.length === 0) continue

    log.debug("detectStale: checking paths", { chunkId: chunk.id, paths })
    let deletedCount = 0
    let changedCount = 0

    for (const p of paths) {
      const abs = path.isAbsolute(p) ? p : path.join(worktree, p)
      try {
        const stat = fs.statSync(abs)
        if (stat.mtimeMs > chunk.created_at) {
          changedCount++
        }
      } catch {
        // File doesn't exist or is inaccessible
        deletedCount++
      }
    }

    // If all referenced files are deleted, deprecate
    if (deletedCount > 0 && deletedCount === paths.length) {
      store.updateTruthState(chunk.id, "deprecated", 0.1)
      deprecated++
      continue
    }

    // If some referenced files changed, lower confidence and dispute.
    // Only penalize once — skip if already disputed with low confidence.
    if (changedCount > 0 && chunk.confidence > 0.2) {
      const newConfidence = Math.max(0.2, chunk.confidence - 0.3)
      if (newConfidence < 0.4 && chunk.truth_state !== "disputed") {
        store.updateTruthState(chunk.id, "disputed", newConfidence)
        disputed++
      } else if (newConfidence < chunk.confidence) {
        store.updateTruthState(chunk.id, chunk.truth_state, newConfidence)
      }
    }
  }

  if (deprecated > 0 || disputed > 0) {
    log.info("staleness detection complete", { deprecated, disputed })
  }
  return { deprecated, disputed }
}

// =========================================================================
// B. Summary Lifecycle
// =========================================================================

/**
 * Expire old summaries, enforce count cap, and optionally auto-promote
 * repeated knowledge.
 */
export async function manageSummaries(params: {
  store: Store
  provider: EmbeddingProvider
  projectID: string
  config: ResolvedConfig
}): Promise<{ deleted: number; promoted: number }> {
  const mc = params.config.maintenance
  let deleted = 0
  let promoted = 0

  // TTL expiry: candidate summaries older than threshold → deprecated
  if (mc.autoDeprecate) {
    const ttlMs = mc.summaryTTLDays * MS_PER_DAY
    log.debug("manageSummaries: TTL expiry check", { ttlDays: mc.summaryTTLDays })
    params.store.deprecateSummariesOlderThan(params.projectID, ttlMs)
  }

  // Count cap: if too many summaries, delete oldest deprecated first
  const count = params.store.countSummaries(params.projectID)
  log.debug("manageSummaries: count check", { count, max: mc.maxSummaries })
  if (count > mc.maxSummaries) {
    const excess = count - mc.maxSummaries
    const oldest = params.store.oldestSummaries(params.projectID, excess)
    for (const s of oldest) {
      params.store.deleteSummary(s.id)
    }
    deleted = oldest.length
    if (deleted > 0) {
      log.info("pruned excess summaries", { deleted })
    }
  }

  // Auto-promote: if enabled, find clusters of similar summaries
  if (params.config.extraction.autoPromote) {
    promoted = await autoPromote(params.store, params.provider, params.projectID)
  }
  return { deleted, promoted }
}

/**
 * Find clusters of 3+ semantically similar candidate summaries
 * and merge them into a single validated entry.
 */
async function autoPromote(store: Store, provider: EmbeddingProvider, projectID: string): Promise<number> {
  const candidates = store.recentSummaries(projectID, 200).filter((s) => s.truth_state === "candidate")
  log.debug("autoPromote: candidates", { count: candidates.length })
  if (candidates.length < 3) return 0

  // Embed all candidates
  const texts = candidates.map((c) => c.content)
  const embeddings = await provider.embed(texts)

  // Find clusters (greedy: first candidate that matches 2+ others)
  const used = new Set<number>()
  let promoted = 0

  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue
    const cluster = [i]
    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(j)) continue
      const sim = cosine(embeddings[i], embeddings[j])
      if (sim > 0.85) cluster.push(j)
    }

    if (cluster.length >= 3) {
      log.debug("autoPromote: found cluster", { size: cluster.length, anchor: candidates[i].id })
      // Merge: use the longest summary as the representative
      const sorted = cluster.toSorted((a, b) => candidates[b].content.length - candidates[a].content.length)
      const representative = candidates[sorted[0]]

      // Promote the representative (only if the chunk row exists)
      const chunkId = representative.id
      const exists = store.getChunk(chunkId)
      if (!exists) {
        log.warn("autoPromote: representative chunk not found, skipping", { chunkId })
        for (const idx of cluster) used.add(idx)
        continue
      }
      store.updateTruthState(chunkId, "validated", 1.0)
      store.touchValidated(chunkId)

      // Deprecate the others
      for (let k = 1; k < sorted.length; k++) {
        store.updateTruthState(candidates[sorted[k]].id, "deprecated", 0.1)
      }

      for (const idx of cluster) used.add(idx)
      promoted++
    }
  }

  if (promoted > 0) {
    log.info("auto-promoted summary clusters", { promoted })
  }
  return promoted
}

// =========================================================================
// C. Model Migration
// =========================================================================

const MIGRATION_BATCH = 50

/**
 * Re-embed chunks that were embedded with a different model.
 * Runs in batches to avoid blocking.
 */
export async function migrateEmbeddings(store: Store, provider: EmbeddingProvider): Promise<number> {
  const model = provider.model()
  const stale = store.chunksNeedingMigration(model, MIGRATION_BATCH)
  log.debug("migrateEmbeddings: checked", { model, staleCount: stale.length })
  if (stale.length === 0) return 0

  log.info("migrating embeddings", { count: stale.length, model })

  const texts = stale.map((c) => c.text)
  const embeddings = await provider.embed(texts)

  for (let i = 0; i < stale.length; i++) {
    const blob = serialize(embeddings[i])
    store.updateEmbedding(stale[i].id, blob, model)

    // Also update the embedding cache
    store.cacheEmbedding({
      hash: stale[i].hash,
      embedding: blob,
      model,
      dims: provider.dimensions(),
      updated_at: Date.now(),
    })
  }

  log.info("embedding migration batch complete", { migrated: stale.length })
  return stale.length
}

// =========================================================================
// D. Contradiction Detection
// =========================================================================

/**
 * After a new entry is stored, check for high-similarity existing entries
 * from different sources/dates. If found, mark the older one as disputed.
 */
export function detectContradictions(store: Store, newChunkId: string) {
  const newChunk = store.getChunk(newChunkId)
  if (!newChunk) return

  const newEmbedding = deserialize(newChunk.embedding)
  if (newEmbedding.length === 0) return

  const allChunks = store.allChunks()
  log.debug("detectContradictions: comparing", { newChunkId, candidates: allChunks.length })
  let disputes = 0

  for (const existing of allChunks) {
    if (existing.id === newChunkId) continue
    if (existing.truth_state === "deprecated") continue
    // Only check different sources or significantly different dates
    if (existing.source === newChunk.source && Math.abs(existing.created_at - newChunk.created_at) < MS_PER_DAY) {
      continue
    }

    const existingEmbedding = deserialize(existing.embedding)
    if (existingEmbedding.length === 0) continue

    const sim = cosine(newEmbedding, existingEmbedding)
    if (sim > 0.85) {
      // High similarity from different context — potential contradiction
      // Mark the older entry as disputed
      if (existing.created_at < newChunk.created_at) {
        store.updateTruthState(existing.id, "disputed", Math.max(0.2, existing.confidence - 0.2))
        disputes++
      }
    }
  }

  if (disputes > 0) {
    log.info("contradiction detection complete", { newChunk: newChunkId, disputes })
  }
}

// =========================================================================
// E. Orphan Cleanup
// =========================================================================

/**
 * Hard-delete deprecated entries older than the configured threshold.
 */
export function cleanupDeprecated(store: Store, maxAgeDays: number): number {
  const cutoff = Date.now() - maxAgeDays * MS_PER_DAY
  const deprecated = store.chunksByFilter({ truthState: "deprecated" })
  log.debug("cleanupDeprecated: checking", { count: deprecated.length, maxAgeDays })
  let deleted = 0

  for (const chunk of deprecated) {
    if (chunk.updated_at < cutoff) {
      store.deleteChunk(chunk.id)
      deleted++
    }
  }

  if (deleted > 0) {
    log.info("cleaned up deprecated entries", { deleted })
  }
  return deleted
}

// =========================================================================
// Orchestrator
// =========================================================================

/**
 * Run all maintenance tasks. Called by the hourly cron job.
 */
export async function run(params: {
  store: Store
  provider: EmbeddingProvider
  worktree: string
  projectID: string
  config: ResolvedConfig
}): Promise<MaintenanceReport> {
  const mc = params.config.maintenance
  const report: MaintenanceReport = {
    staleDeprecated: 0,
    staleDisputed: 0,
    summariesDeleted: 0,
    promoted: 0,
    migrated: 0,
    cleanedUp: 0,
  }

  log.debug("maintain: run starting", {
    autoDeprecate: mc.autoDeprecate,
    autoPromote: params.config.extraction.autoPromote,
  })

  // A. Staleness detection
  if (mc.autoDeprecate) {
    try {
      log.debug("maintain: detectStale starting")
      const stale = detectStale(params.store, params.worktree)
      report.staleDeprecated = stale.deprecated
      report.staleDisputed = stale.disputed
      log.debug("maintain: detectStale complete")
    } catch (err) {
      log.warn("staleness detection failed", { error: String(err) })
    }
  }

  // B. Summary lifecycle
  try {
    log.debug("maintain: manageSummaries starting")
    const summaryResult = await manageSummaries({
      store: params.store,
      provider: params.provider,
      projectID: params.projectID,
      config: params.config,
    })
    report.summariesDeleted = summaryResult.deleted
    report.promoted = summaryResult.promoted
    log.debug("maintain: manageSummaries complete")
  } catch (err) {
    log.warn("summary management failed", { error: String(err) })
  }

  // C. Model migration
  try {
    log.debug("maintain: migrateEmbeddings starting")
    report.migrated = await migrateEmbeddings(params.store, params.provider)
    log.debug("maintain: migrateEmbeddings complete")
  } catch (err) {
    log.warn("embedding migration failed", { error: String(err) })
  }

  // D. Contradiction detection is run per-entry (after extraction), not in bulk

  // E. Orphan cleanup
  try {
    log.debug("maintain: cleanupDeprecated starting")
    report.cleanedUp = cleanupDeprecated(params.store, mc.deprecatedCleanupDays)
    log.debug("maintain: cleanupDeprecated complete")
  } catch (err) {
    log.warn("deprecated cleanup failed", { error: String(err) })
  }

  // Standard GC (FTS optimize, cache prune, entity orphans)
  log.debug("maintain: gc starting")
  params.store.gc()

  // Record metrics
  Metrics.record("maintenanceRuns")
  Metrics.record("maintenanceStaleDeprecated", report.staleDeprecated)
  Metrics.record("maintenanceStaleDisputed", report.staleDisputed)
  Metrics.record("maintenanceSummariesDeleted", report.summariesDeleted)
  Metrics.record("maintenancePromoted", report.promoted)
  Metrics.record("maintenanceMigrated", report.migrated)
  Metrics.record("maintenanceCleanedUp", report.cleanedUp)

  log.debug("maintain: run complete", report)
  return report
}
