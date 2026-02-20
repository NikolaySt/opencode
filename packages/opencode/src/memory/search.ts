/**
 * Hybrid Search
 *
 * Combines vector similarity search with FTS5 keyword search.
 * Adapted from OpenClaw's search pipeline with a fixed BM25
 * normalization formula.
 *
 * Pipeline:
 * 1. Apply SQL pre-filters (path, source, truth state, date, entity)
 * 2. Embed query text
 * 3. Brute-force cosine similarity against filtered embeddings
 * 4. FTS5 BM25 keyword search
 * 5. Weighted merge by chunk ID with truth + recency boost
 * 6. Filter by minimum score, limit results
 *
 * Performance: SQL pre-filtering reduces the candidate set before
 * brute-force vector search. For typical memory files (<1000 chunks)
 * the full pipeline is fast.
 */

import { Log } from "../util/log"
import type { Store } from "./store"
import type { ChunkFilter } from "./store"
import type { EmbeddingProvider } from "./embed"
import type { TruthState, EntityKind } from "./schema"
import { cosine, deserialize } from "./embed"
import * as Metrics from "./metrics"

const log = Log.create({ service: "memory.search" })

export type SearchResult = {
  id: string
  path: string
  startLine: number
  endLine: number
  text: string
  score: number
  source: string
  truthState: string
}

export type SearchOptions = {
  maxResults?: number
  minScore?: number
  source?: string
  vectorWeight?: number
  textWeight?: number
  pathGlob?: string
  entity?: { kind: EntityKind; value: string }
  dateRange?: { from?: number; to?: number }
  truthState?: TruthState | TruthState[]
  recencyBoost?: boolean
}

const TRUTH_WEIGHT: Record<string, number> = {
  validated: 1.0,
  candidate: 0.7,
  hypothesis: 0.4,
  deprecated: 0.1,
  disputed: 0.3,
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

/**
 * Convert FTS5 BM25 rank to a 0-1 score.
 *
 * FTS5 rank values are negative (more negative = better match).
 * We negate the rank so better matches produce higher input to
 * the normalization formula.
 *
 * Formula: score = negRank / (1 + negRank)
 * Examples: rank=-10 → score=0.909, rank=-1 → score=0.5, rank=0 → score=0
 */
function rankToScore(rank: number): number {
  const neg = -rank // flip sign: more negative rank → larger positive value
  if (neg <= 0) return 0
  return neg / (1 + neg)
}

/**
 * Recency boost: entries updated recently score higher.
 * Score decays over 90 days — entries older than 90d get ~50% boost.
 */
function recencyScore(updatedAt: number): number {
  const days = (Date.now() - updatedAt) / MS_PER_DAY
  return 1.0 / (1 + days / 90)
}

export async function search(params: {
  store: Store
  provider: EmbeddingProvider
  query: string
  options?: SearchOptions
}): Promise<SearchResult[]> {
  const started = Date.now()
  const opts = params.options ?? {}
  const maxResults = opts.maxResults ?? 8
  const minScore = opts.minScore ?? 0.2
  const vectorWeight = opts.vectorWeight ?? 0.7
  const textWeight = opts.textWeight ?? 0.3
  const useRecency = opts.recencyBoost !== false

  // Step 1: Build SQL pre-filter
  const filter: ChunkFilter = {}
  if (opts.source) filter.source = opts.source
  if (opts.pathGlob) filter.pathGlob = opts.pathGlob
  if (opts.truthState) filter.truthState = opts.truthState
  if (opts.dateRange) filter.dateRange = opts.dateRange
  if (opts.entity) filter.entity = opts.entity

  const hasFilter = Object.keys(filter).length > 0

  log.debug("search: starting", { query: params.query.slice(0, 80), hasFilter, vectorWeight, textWeight })

  // Step 2: Embed query
  log.debug("search: embedding query")
  const [queryEmbedding] = await params.provider.embed([params.query])
  if (!queryEmbedding) return []
  log.debug("search: query embedded")

  // Step 3: Vector search (brute-force cosine similarity on filtered set)
  const candidates = hasFilter ? params.store.chunksByFilter(filter) : params.store.allChunks()
  log.debug("search: candidates loaded", { count: candidates.length, filtered: hasFilter })

  // Build ID-to-index map for O(1) lookup by text-only FTS matches
  const idToIdx = new Map<string, number>()
  const vectorScores = new Map<string, { score: number; chunkIdx: number }>()
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    idToIdx.set(c.id, i)
    const embedding = deserialize(c.embedding)
    if (embedding.length === 0) continue
    const score = cosine(queryEmbedding, embedding)
    if (score > 0) {
      vectorScores.set(c.id, { score, chunkIdx: i })
    }
  }

  // Step 4: Keyword search (FTS5)
  const ftsResults = params.store.searchFts(params.query, maxResults * 3)
  log.debug("search: FTS results", { count: ftsResults.length })
  const textScores = new Map<string, number>()
  for (const r of ftsResults) {
    textScores.set(r.id, rankToScore(r.rank))
  }

  // Step 5: Hybrid merge with truth weight + recency boost
  const merged = new Map<string, { score: number; chunkIdx: number }>()

  for (const [id, entry] of vectorScores) {
    const c = candidates[entry.chunkIdx]
    const vs = entry.score * vectorWeight
    const ts = (textScores.get(id) ?? 0) * textWeight
    const tw = TRUTH_WEIGHT[c.truth_state] ?? 0.5
    const rb = useRecency ? recencyScore(c.updated_at) : 1.0
    merged.set(id, { score: (vs + ts) * tw * rb, chunkIdx: entry.chunkIdx })
  }

  // Add text-only matches not found in vector results (only if in filtered set)
  for (const [id, score] of textScores) {
    if (merged.has(id)) continue
    const idx = idToIdx.get(id)
    if (idx === undefined) continue
    const c = candidates[idx]
    const tw = TRUTH_WEIGHT[c.truth_state] ?? 0.5
    const rb = useRecency ? recencyScore(c.updated_at) : 1.0
    merged.set(id, { score: score * textWeight * tw * rb, chunkIdx: idx })
  }

  log.debug("search: merged candidates", {
    total: merged.size,
    vectorOnly: vectorScores.size,
    textOnly: textScores.size,
  })

  // Step 6: Filter, sort, and format
  const results = [...merged.entries()]
    .filter(([, e]) => e.score >= minScore)
    .toSorted(([, a], [, b]) => b.score - a.score)
    .slice(0, maxResults)
    .map(([id, e]) => {
      const c = candidates[e.chunkIdx]
      return {
        id,
        path: c.path,
        startLine: c.start_line,
        endLine: c.end_line,
        text: c.text,
        score: e.score,
        source: c.source,
        truthState: c.truth_state,
      }
    })

  const elapsed = Date.now() - started
  Metrics.record("searches")
  Metrics.record("searchLatencyMs", elapsed)
  Metrics.record(results.length > 0 ? "searchHits" : "searchMisses")

  log.info("search complete", {
    query: params.query.slice(0, 80),
    candidates: candidates.length,
    vectorCandidates: vectorScores.size,
    textCandidates: textScores.size,
    results: results.length,
    latencyMs: elapsed,
  })

  return results
}
