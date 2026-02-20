/**
 * Memory Store
 *
 * SQLite database lifecycle management for the memory subsystem.
 * Uses bun:sqlite for zero-dependency synchronous SQLite access.
 *
 * Database is scoped per project at:
 *   {Global.Path.memory}/{projectID}.sqlite
 *
 * Design notes:
 * - WAL journal mode for concurrent read/write
 * - Embeddings stored as BLOBs (8 bytes/dim) not JSON strings
 * - FTS5 external-content mode backed by chunks table
 * - All chunk+FTS mutations wrapped in transactions
 */

import { Database } from "bun:sqlite"
import path from "path"
import { Global } from "../global"
import { SCHEMA_VERSION, MIGRATIONS } from "./schema"
import type { ChunkRow, EmbeddingCacheRow, EntityRow, FileRow, SummaryRow, TruthState, EntityKind } from "./schema"
import { Log } from "../util/log"
import * as Metrics from "./metrics"

const log = Log.create({ service: "memory.store" })

export type Store = ReturnType<typeof create>

export type ChunkFilter = {
  source?: string
  pathGlob?: string
  truthState?: TruthState | TruthState[]
  dateRange?: { from?: number; to?: number }
  embeddingModel?: string
  entity?: { kind: EntityKind; value: string }
}

export function create(projectID: string) {
  let db: Database | undefined

  function filepath() {
    return path.join(Global.Path.memory, `${projectID}.sqlite`)
  }

  function open() {
    if (db) return db
    db = new Database(filepath())
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate()
    log.info("opened memory database", { project: projectID, path: filepath() })
    return db
  }

  function get() {
    if (!db) throw new Error("memory store not opened — call open() first")
    return db
  }

  function migrate() {
    if (!db) return

    // Ensure meta table exists before querying it (bootstrap)
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null
    const current = parseInt(row?.value ?? "0", 10)
    const target = parseInt(SCHEMA_VERSION, 10)

    if (current >= target) return

    log.info("migrating memory schema", { from: current, to: target })

    // Run each migration in order, wrapped in a transaction for atomicity
    db.transaction(() => {
      for (let v = current + 1; v <= target; v++) {
        const sql = MIGRATIONS[String(v)]
        if (!sql) throw new Error(`missing migration for schema version ${v}`)
        db!.exec(sql)
      }
      db!.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION])
    })()
  }

  function close() {
    if (!db) return
    try {
      db.close()
    } catch {
      // already closed
    }
    db = undefined
    log.info("closed memory database", { project: projectID })
  }

  // =========================================================================
  // Meta
  // =========================================================================

  function getMeta(key: string): string | null {
    const row = get().query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
    return row?.value ?? null
  }

  function setMeta(key: string, value: string) {
    get().run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value])
  }

  // =========================================================================
  // Files
  // =========================================================================

  function getFile(p: string): FileRow | null {
    return get().query("SELECT * FROM files WHERE path = ?").get(p) as FileRow | null
  }

  function upsertFile(row: FileRow) {
    get().run("INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)", [
      row.path,
      row.source,
      row.hash,
      row.mtime,
      row.size,
    ])
  }

  function deleteFile(p: string) {
    get().run("DELETE FROM files WHERE path = ?", [p])
  }

  function allFiles(): FileRow[] {
    return get().query("SELECT * FROM files").all() as FileRow[]
  }

  // =========================================================================
  // Chunks + FTS (transactional)
  // =========================================================================

  function upsertChunk(row: ChunkRow) {
    const d = get()
    d.transaction(() => {
      // Remove old FTS entry if this chunk already exists
      const existing = d.query("SELECT rowid, text FROM chunks WHERE id = ?").get(row.id) as {
        rowid: number
        text: string
      } | null
      if (existing) {
        d.run("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)", [existing.rowid, existing.text])
      }

      d.run(
        `INSERT OR REPLACE INTO chunks
          (id, path, source, start_line, end_line, hash, text, embedding,
           truth_state, confidence, created_at, updated_at, embedding_model, last_validated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.path,
          row.source,
          row.start_line,
          row.end_line,
          row.hash,
          row.text,
          row.embedding,
          row.truth_state,
          row.confidence,
          row.created_at,
          row.updated_at,
          row.embedding_model,
          row.last_validated_at,
        ],
      )

      // Insert new FTS entry using the new rowid
      const inserted = d.query("SELECT rowid FROM chunks WHERE id = ?").get(row.id) as { rowid: number }
      d.run("INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)", [inserted.rowid, row.text])
    })()
  }

  function deleteChunksForPath(p: string) {
    const d = get()
    d.transaction(() => {
      // Get all rowids + texts for FTS cleanup in one query
      const rows = d.query("SELECT rowid, text FROM chunks WHERE path = ?").all(p) as Array<{
        rowid: number
        text: string
      }>
      for (const r of rows) {
        d.run("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)", [r.rowid, r.text])
      }
      // Also clean up entity tags
      d.run("DELETE FROM entities WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)", [p])
      d.run("DELETE FROM chunks WHERE path = ?", [p])
    })()
  }

  function deleteChunk(id: string) {
    const d = get()
    d.transaction(() => {
      const existing = d.query("SELECT rowid, text FROM chunks WHERE id = ?").get(id) as {
        rowid: number
        text: string
      } | null
      if (!existing) return
      d.run("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)", [existing.rowid, existing.text])
      d.run("DELETE FROM entities WHERE chunk_id = ?", [id])
      d.run("DELETE FROM chunks WHERE id = ?", [id])
    })()
  }

  function getChunk(id: string): ChunkRow | null {
    return get().query("SELECT * FROM chunks WHERE id = ?").get(id) as ChunkRow | null
  }

  function allChunks(): ChunkRow[] {
    return get().query("SELECT * FROM chunks").all() as ChunkRow[]
  }

  function chunksBySource(source: string): ChunkRow[] {
    return get().query("SELECT * FROM chunks WHERE source = ?").all(source) as ChunkRow[]
  }

  /**
   * Query chunks with composable SQL filters. Reduces candidate set
   * before vector search so brute-force cosine is run on fewer items.
   */
  function chunksByFilter(filter: ChunkFilter): ChunkRow[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.source) {
      conditions.push("c.source = ?")
      params.push(filter.source)
    }
    if (filter.pathGlob) {
      conditions.push("c.path GLOB ?")
      params.push(filter.pathGlob)
    }
    if (filter.truthState) {
      const states = Array.isArray(filter.truthState) ? filter.truthState : [filter.truthState]
      conditions.push(`c.truth_state IN (${states.map(() => "?").join(",")})`)
      params.push(...states)
    }
    if (filter.dateRange?.from !== undefined) {
      conditions.push("c.updated_at >= ?")
      params.push(filter.dateRange.from)
    }
    if (filter.dateRange?.to !== undefined) {
      conditions.push("c.updated_at <= ?")
      params.push(filter.dateRange.to)
    }
    if (filter.embeddingModel) {
      conditions.push("c.embedding_model = ?")
      params.push(filter.embeddingModel)
    }
    if (filter.entity) {
      const escaped = filter.entity.value.replace(/[%_]/g, (ch) => `\\${ch}`)
      conditions.push("c.id IN (SELECT chunk_id FROM entities WHERE kind = ? AND value LIKE ? ESCAPE '\\')")
      params.push(filter.entity.kind, `%${escaped}%`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    return get()
      .query(`SELECT c.* FROM chunks c ${where}`)
      .all(...(params as string[])) as ChunkRow[]
  }

  /**
   * Find chunks whose embedding_model doesn't match the current model.
   */
  function chunksNeedingMigration(model: string, limit: number): ChunkRow[] {
    return get()
      .query("SELECT * FROM chunks WHERE embedding_model != ? AND embedding != x'' LIMIT ?")
      .all(model, limit) as ChunkRow[]
  }

  /**
   * Update a chunk's truth_state (and optionally confidence).
   */
  function updateTruthState(id: string, state: TruthState, confidence?: number) {
    if (confidence !== undefined) {
      get().run("UPDATE chunks SET truth_state = ?, confidence = ?, updated_at = ? WHERE id = ?", [
        state,
        confidence,
        Date.now(),
        id,
      ])
    } else {
      get().run("UPDATE chunks SET truth_state = ?, updated_at = ? WHERE id = ?", [state, Date.now(), id])
    }
  }

  /**
   * Touch last_validated_at to mark a chunk as freshly validated.
   */
  function touchValidated(id: string) {
    get().run("UPDATE chunks SET last_validated_at = ? WHERE id = ?", [Date.now(), id])
  }

  /**
   * Update a chunk's embedding and model (for model migration).
   */
  function updateEmbedding(id: string, embedding: Buffer | Uint8Array, model: string) {
    get().run("UPDATE chunks SET embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ?", [
      embedding,
      model,
      Date.now(),
      id,
    ])
  }

  // =========================================================================
  // FTS search
  // =========================================================================

  function searchFts(query: string, limit: number): Array<{ id: string; rank: number }> {
    if (!query.trim()) return []
    // Tokenize, strip all non-alphanumeric/underscore/hyphen chars to prevent FTS5 syntax injection,
    // wrap each token in quotes, join with AND
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ""))
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(" AND ")
    if (!terms) return []
    // Join FTS results back to chunks to get chunk id
    return get()
      .query(
        `SELECT c.id, f.rank
         FROM chunks_fts f
         JOIN chunks c ON c.rowid = f.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY f.rank
         LIMIT ?`,
      )
      .all(terms, limit) as Array<{ id: string; rank: number }>
  }

  // =========================================================================
  // Entities
  // =========================================================================

  function upsertEntities(chunkId: string, entities: Array<{ kind: EntityKind; value: string }>) {
    const d = get()
    d.transaction(() => {
      d.run("DELETE FROM entities WHERE chunk_id = ?", [chunkId])
      for (const e of entities) {
        d.run("INSERT OR IGNORE INTO entities (chunk_id, kind, value) VALUES (?, ?, ?)", [chunkId, e.kind, e.value])
      }
    })()
  }

  function deleteEntitiesForChunk(chunkId: string) {
    get().run("DELETE FROM entities WHERE chunk_id = ?", [chunkId])
  }

  function entitiesForChunk(chunkId: string): EntityRow[] {
    return get().query("SELECT * FROM entities WHERE chunk_id = ?").all(chunkId) as EntityRow[]
  }

  function searchByEntity(kind: EntityKind, value: string, limit: number): ChunkRow[] {
    const escaped = value.replace(/[%_]/g, (ch) => `\\${ch}`)
    return get()
      .query(
        `SELECT c.* FROM chunks c
         JOIN entities e ON e.chunk_id = c.id
         WHERE e.kind = ? AND e.value LIKE ? ESCAPE '\\'
         LIMIT ?`,
      )
      .all(kind, `%${escaped}%`, limit) as ChunkRow[]
  }

  // =========================================================================
  // Embedding Cache
  // =========================================================================

  function getCachedEmbedding(hash: string): EmbeddingCacheRow | null {
    const row = get().query("SELECT * FROM embedding_cache WHERE hash = ?").get(hash) as EmbeddingCacheRow | null
    Metrics.record(row ? "embeddingCacheHits" : "embeddingCacheMisses")
    return row
  }

  function cacheEmbedding(row: EmbeddingCacheRow) {
    get().run(
      "INSERT OR REPLACE INTO embedding_cache (hash, embedding, model, dims, updated_at) VALUES (?, ?, ?, ?, ?)",
      [row.hash, row.embedding, row.model, row.dims, row.updated_at],
    )
  }

  // =========================================================================
  // Summaries
  // =========================================================================

  function upsertSummary(row: SummaryRow) {
    get().run(
      `INSERT OR REPLACE INTO summaries
        (id, session_id, project_id, content, truth_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.session_id, row.project_id, row.content, row.truth_state, row.created_at],
    )
  }

  function recentSummaries(pid: string, limit: number): SummaryRow[] {
    return get()
      .query("SELECT * FROM summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(pid, limit) as SummaryRow[]
  }

  function countSummaries(pid: string): number {
    return (get().query("SELECT COUNT(*) as count FROM summaries WHERE project_id = ?").get(pid) as { count: number })
      .count
  }

  function deprecateSummariesOlderThan(pid: string, ageMs: number) {
    const cutoff = Date.now() - ageMs
    get().run(
      "UPDATE summaries SET truth_state = 'deprecated' WHERE project_id = ? AND truth_state = 'candidate' AND created_at < ?",
      [pid, cutoff],
    )
  }

  function oldestSummaries(pid: string, limit: number): SummaryRow[] {
    return get()
      .query(
        "SELECT * FROM summaries WHERE project_id = ? AND truth_state IN ('deprecated', 'candidate') ORDER BY created_at ASC LIMIT ?",
      )
      .all(pid, limit) as SummaryRow[]
  }

  function deleteSummary(id: string) {
    const d = get()
    d.transaction(() => {
      // Also delete the corresponding chunk (if any)
      deleteChunk(id)
      d.run("DELETE FROM summaries WHERE id = ?", [id])
    })()
  }

  // =========================================================================
  // Maintenance
  // =========================================================================

  function gc() {
    if (!db) return
    // Optimize FTS index (lightweight merge of b-tree segments, not full rebuild)
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
    // Remove embedding cache entries that no longer correspond to any chunk
    db.exec("DELETE FROM embedding_cache WHERE hash NOT IN (SELECT hash FROM chunks)")
    // Remove entity tags for chunks that no longer exist
    db.exec("DELETE FROM entities WHERE chunk_id NOT IN (SELECT id FROM chunks)")
    log.info("garbage collection complete", { project: projectID })
  }

  function stats() {
    if (!db)
      return {
        files: 0,
        chunks: 0,
        summaries: 0,
        cacheEntries: 0,
        entities: 0,
        chunksByTruth: {} as Record<string, number>,
        chunksBySource: {} as Record<string, number>,
      }
    const files = (db.query("SELECT COUNT(*) as count FROM files").get() as { count: number }).count
    const chunks = (db.query("SELECT COUNT(*) as count FROM chunks").get() as { count: number }).count
    const summaries = (db.query("SELECT COUNT(*) as count FROM summaries").get() as { count: number }).count
    const cacheEntries = (db.query("SELECT COUNT(*) as count FROM embedding_cache").get() as { count: number }).count
    const entities = (db.query("SELECT COUNT(*) as count FROM entities").get() as { count: number }).count

    const truthRows = db
      .query("SELECT truth_state, COUNT(*) as count FROM chunks GROUP BY truth_state")
      .all() as Array<{ truth_state: string; count: number }>
    const chunksByTruth: Record<string, number> = {}
    for (const r of truthRows) chunksByTruth[r.truth_state] = r.count

    const sourceRows = db.query("SELECT source, COUNT(*) as count FROM chunks GROUP BY source").all() as Array<{
      source: string
      count: number
    }>
    const chunksBySource: Record<string, number> = {}
    for (const r of sourceRows) chunksBySource[r.source] = r.count

    return { files, chunks, summaries, cacheEntries, entities, chunksByTruth, chunksBySource }
  }

  // =========================================================================
  // Inspection helpers (for /memory diagnostic commands)
  // =========================================================================

  function allEntities(limit = 200, kind?: EntityKind): Array<EntityRow & { path: string; source: string }> {
    if (!db) return []
    const conditions: string[] = []
    const params: unknown[] = []
    if (kind) {
      conditions.push("e.kind = ?")
      params.push(kind)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    params.push(limit)
    return db
      .query(
        `SELECT e.*, c.path, c.source FROM entities e
         JOIN chunks c ON c.id = e.chunk_id
         ${where}
         ORDER BY e.kind, e.value
         LIMIT ?`,
      )
      .all(...(params as string[])) as Array<EntityRow & { path: string; source: string }>
  }

  function embeddingStats() {
    if (!db)
      return {
        total: 0,
        withEmbedding: 0,
        empty: 0,
        byModel: {} as Record<string, number>,
        cacheEntries: 0,
        cacheDims: 0,
      }
    const total = (db.query("SELECT COUNT(*) as count FROM chunks").get() as { count: number }).count
    const empty = (
      db.query("SELECT COUNT(*) as count FROM chunks WHERE embedding = x'' OR embedding IS NULL").get() as {
        count: number
      }
    ).count
    const modelRows = db
      .query("SELECT embedding_model, COUNT(*) as count FROM chunks WHERE embedding != x'' GROUP BY embedding_model")
      .all() as Array<{ embedding_model: string; count: number }>
    const byModel: Record<string, number> = {}
    for (const r of modelRows) byModel[r.embedding_model || "(unknown)"] = r.count
    const cacheEntries = (db.query("SELECT COUNT(*) as count FROM embedding_cache").get() as { count: number }).count
    const cacheRow = db.query("SELECT dims FROM embedding_cache LIMIT 1").get() as { dims: number } | null
    return { total, withEmbedding: total - empty, empty, byModel, cacheEntries, cacheDims: cacheRow?.dims ?? 0 }
  }

  function allSummaries(limit = 50): SummaryRow[] {
    if (!db) return []
    return db.query("SELECT * FROM summaries ORDER BY created_at DESC LIMIT ?").all(limit) as SummaryRow[]
  }

  return {
    open,
    get,
    close,
    gc,
    stats,
    getMeta,
    setMeta,
    getFile,
    upsertFile,
    deleteFile,
    allFiles,
    upsertChunk,
    deleteChunk,
    deleteChunksForPath,
    getChunk,
    allChunks,
    chunksBySource,
    chunksByFilter,
    chunksNeedingMigration,
    updateTruthState,
    touchValidated,
    updateEmbedding,
    searchFts,
    upsertEntities,
    deleteEntitiesForChunk,
    entitiesForChunk,
    searchByEntity,
    getCachedEmbedding,
    cacheEmbedding,
    upsertSummary,
    recentSummaries,
    countSummaries,
    deprecateSummariesOlderThan,
    oldestSummaries,
    deleteSummary,
    allEntities,
    embeddingStats,
    allSummaries,
  }
}
