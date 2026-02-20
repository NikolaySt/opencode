/**
 * Memory File Sync
 *
 * Discovers, indexes, and maintains memory knowledge files.
 *
 * Knowledge sources:
 * - MEMORY.md / memory.md in the project root
 * - All .md files under memory/ directory
 * - Additional paths from config (files and directories)
 *
 * Change detection uses SHA-256 file hashes compared against
 * the files table. Only changed files are re-chunked and re-embedded.
 */

import path from "path"
import fs from "fs"
import { Log } from "../util/log"
import { chunk } from "./chunk"
import { serialize, deserialize } from "./embed"
import { extract as extractEntities } from "./entity"
import type { Store } from "./store"
import type { EmbeddingProvider } from "./embed"
import type { ChunkRow } from "./schema"

const log = Log.create({ service: "memory.sync" })

const MEMORY_FILES = ["MEMORY.md", "memory.md"]
const MEMORY_DIRS = ["memory"]
const MD_GLOB = new Bun.Glob("**/*.md")

export type SyncResult = {
  indexed: number
  removed: number
  unchanged: number
  errors: string[]
}

/**
 * Discover all knowledge files relative to the worktree.
 */
export function discover(worktree: string, extra?: string[]): string[] {
  const files: string[] = []
  const seen = new Set<string>()

  function add(filepath: string) {
    const resolved = path.resolve(filepath)
    if (seen.has(resolved)) return
    if (!fs.existsSync(resolved)) return
    seen.add(resolved)
    files.push(resolved)
  }

  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const match of MD_GLOB.scanSync({ cwd: dir, absolute: true, followSymlinks: true })) {
      add(match)
    }
  }

  // Check top-level memory files (stop after first match —
  // MEMORY.md and memory.md are the same file on case-insensitive FS)
  for (const name of MEMORY_FILES) {
    const p = path.join(worktree, name)
    if (fs.existsSync(p)) {
      add(p)
      break
    }
  }

  // Scan memory/ directories
  for (const dir of MEMORY_DIRS) {
    scanDir(path.join(worktree, dir))
  }

  // Extra configured paths — support both files and directories
  for (const p of extra ?? []) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(worktree, p)
    if (!fs.existsSync(resolved)) continue
    if (fs.statSync(resolved).isDirectory()) {
      scanDir(resolved)
    } else {
      add(resolved)
    }
  }

  return files
}

/**
 * Read file content and compute SHA-256 hash in a single I/O pass.
 */
async function readAndHash(filepath: string): Promise<{ content: string; hash: string }> {
  const content = await Bun.file(filepath).text()
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(content)
  return { content, hash: hasher.digest("hex") }
}

/**
 * Synchronize knowledge files with the memory store.
 *
 * Pipeline:
 * 1. Discover files
 * 2. Detect changes via hash comparison
 * 3. Chunk changed files
 * 4. Embed new chunks (using cache)
 * 5. Update store (upsertChunk handles FTS internally)
 * 6. Clean up stale entries
 */
export async function sync(params: {
  store: Store
  provider: EmbeddingProvider
  worktree: string
  extra?: string[]
  entityMode?: "regex" | "llm"
  generate?: (prompt: string) => Promise<string>
  ignoredEntities?: Set<string>
}): Promise<SyncResult> {
  const result: SyncResult = { indexed: 0, removed: 0, unchanged: 0, errors: [] }
  const files = discover(params.worktree, params.extra)
  const tracked = new Set<string>()

  log.debug("sync: starting", { files: files.length, worktree: params.worktree, entityMode: params.entityMode })

  for (const filepath of files) {
    tracked.add(filepath)
    try {
      const { content, hash } = await readAndHash(filepath)
      const existing = params.store.getFile(filepath)

      // Skip unchanged files
      if (existing && existing.hash === hash) {
        result.unchanged++
        log.debug("sync: file unchanged", { path: filepath })
        continue
      }

      log.info("sync: indexing file", { path: filepath, contentLength: content.length })

      const chunks = chunk(content)

      // Remove old chunks for this file (also cleans FTS)
      params.store.deleteChunksForPath(filepath)

      // Determine which chunks need new embeddings
      const needsEmbedding: Array<{ idx: number; text: string }> = []
      const cachedEmbeddings: Array<{ idx: number; embedding: number[] }> = []

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]
        const cached = params.store.getCachedEmbedding(c.hash)
        if (cached) {
          cachedEmbeddings.push({ idx: i, embedding: deserialize(cached.embedding) })
        } else {
          needsEmbedding.push({ idx: i, text: c.text })
        }
      }

      // Embed uncached chunks in batch
      let newEmbeddings: number[][] = []
      if (needsEmbedding.length > 0) {
        log.debug("sync: embedding chunks", {
          path: filepath,
          count: needsEmbedding.length,
          cached: cachedEmbeddings.length,
        })
        newEmbeddings = await params.provider.embed(needsEmbedding.map((n) => n.text))
        log.debug("sync: embedding complete", { path: filepath, count: newEmbeddings.length })
        // Cache the new embeddings
        for (let i = 0; i < needsEmbedding.length; i++) {
          const c = chunks[needsEmbedding[i].idx]
          params.store.cacheEmbedding({
            hash: c.hash,
            embedding: serialize(newEmbeddings[i]),
            model: params.provider.model(),
            dims: params.provider.dimensions(),
            updated_at: Date.now(),
          })
        }
      }

      // Build full embedding array in order
      const embeddings = new Array<number[]>(chunks.length)
      for (const ce of cachedEmbeddings) embeddings[ce.idx] = ce.embedding
      for (let i = 0; i < needsEmbedding.length; i++) {
        if (i < newEmbeddings.length) {
          embeddings[needsEmbedding[i].idx] = newEmbeddings[i]
        }
      }

      const now = Date.now()
      // Normalize to forward slashes for cross-platform chunk ID stability
      const relative = path.relative(params.worktree, filepath).replace(/\\/g, "/")

      // Insert chunks (upsertChunk handles FTS internally in a transaction)
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]
        const id = `${relative}:${c.startLine}-${c.endLine}`
        const vec = embeddings[i] ?? []
        const row: ChunkRow = {
          id,
          path: filepath,
          source: "memory",
          start_line: c.startLine,
          end_line: c.endLine,
          hash: c.hash,
          text: c.text,
          embedding: serialize(vec),
          truth_state: "validated",
          confidence: 1.0,
          created_at: existing ? existing.mtime : now,
          updated_at: now,
          embedding_model: params.provider.model(),
          last_validated_at: now,
        }
        params.store.upsertChunk(row)

        // Extract and store entity tags (per-chunk error isolation)
        try {
          const entities = await extractEntities(
            c.text,
            params.entityMode ?? "regex",
            params.generate,
            params.ignoredEntities,
          )
          if (entities.length > 0) {
            log.debug("sync: entities extracted", { chunkId: id, count: entities.length })
            params.store.upsertEntities(id, entities)
          }
        } catch (entityErr) {
          log.warn("sync: entity extraction failed for chunk", { chunkId: id, error: String(entityErr) })
        }
      }

      // Update file tracking
      const stat = fs.statSync(filepath)
      params.store.upsertFile({
        path: filepath,
        source: "memory",
        hash,
        mtime: stat.mtimeMs ? Math.floor(stat.mtimeMs) : now,
        size: stat.size,
      })

      result.indexed++
    } catch (err) {
      const msg = `failed to index ${filepath}: ${String(err)}`
      log.error(msg)
      result.errors.push(msg)
    }
  }

  // Clean up stale files
  const allFiles = params.store.allFiles()
  log.debug("sync: checking for stale files", { tracked: tracked.size, stored: allFiles.length })
  for (const row of allFiles) {
    if (row.source !== "memory") continue
    if (!tracked.has(row.path)) {
      log.info("removing stale file", { path: row.path })
      params.store.deleteChunksForPath(row.path)
      params.store.deleteFile(row.path)
      result.removed++
    }
  }

  log.info("sync complete", result)
  return result
}
