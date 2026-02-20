/**
 * Memory Schema
 *
 * SQL table definitions for the memory subsystem. Adapted from OpenClaw's
 * proven schema with extensions for truth states and session summaries.
 *
 * Tables:
 * - meta: Key-value store for index configuration
 * - files: Tracked source files with change detection
 * - chunks: Indexed text chunks with embeddings
 * - chunks_fts: FTS5 full-text search index (external content)
 * - embedding_cache: SHA-256 keyed embedding cache
 * - summaries: Session-extracted knowledge entries
 *
 * Migration strategy:
 * - Version 1 is the initial schema; all tables use CREATE IF NOT EXISTS
 * - Future versions append ALTER TABLE / new CREATE TABLE statements
 *   so existing data is never dropped.
 */

export const SCHEMA_VERSION = "2"

/**
 * Schema v1 — initial.
 *
 * The FTS5 table uses "external content" mode backed by the chunks table.
 * This means FTS rows are kept in sync manually (INSERT/DELETE) but the
 * FTS index doesn't duplicate the text column's storage. Deletions use
 * the special `chunks_fts` DELETE command with matching column values.
 */
export const MIGRATIONS: Record<string, string> = {
  "1": /* sql */ `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL DEFAULT x'',
      truth_state TEXT NOT NULL DEFAULT 'validated',
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);

    -- External-content FTS5: content is stored in chunks table.
    -- We keep text + metadata columns for search but mark
    -- non-searchable columns UNINDEXED. Sync is manual.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      content TEXT NOT NULL,
      truth_state TEXT NOT NULL DEFAULT 'candidate',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
  `,

  /**
   * Schema v2 — lifecycle extensions.
   *
   * Adds:
   * - embedding_model on chunks for model migration detection
   * - last_validated_at on chunks for staleness tracking
   * - entities table for structured entity-based search
   * - index on chunks.updated_at for date-range queries
   * - index on chunks.truth_state for state-based filtering
   */
  "2": /* sql */ `
    ALTER TABLE chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '';
    ALTER TABLE chunks ADD COLUMN last_validated_at INTEGER;

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(chunk_id, kind, value)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_kind_value ON entities(kind, value);
    CREATE INDEX IF NOT EXISTS idx_entities_chunk ON entities(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_updated ON chunks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_truth ON chunks(truth_state);
    CREATE INDEX IF NOT EXISTS idx_chunks_model ON chunks(embedding_model);
  `,
}

export type TruthState = "hypothesis" | "candidate" | "validated" | "deprecated" | "disputed"

export type EntityKind = "path" | "function" | "class" | "technology" | "concept"

export type FileRow = {
  path: string
  source: string
  hash: string
  mtime: number
  size: number
}

export type ChunkRow = {
  id: string
  path: string
  source: string
  start_line: number
  end_line: number
  hash: string
  text: string
  /** Buffer when writing, Uint8Array when read back from bun:sqlite */
  embedding: Buffer | Uint8Array
  truth_state: TruthState
  confidence: number
  created_at: number
  updated_at: number
  embedding_model: string
  last_validated_at: number | null
}

export type EntityRow = {
  id: number
  chunk_id: string
  kind: EntityKind
  value: string
}

export type EmbeddingCacheRow = {
  hash: string
  /** Buffer when writing, Uint8Array when read back from bun:sqlite */
  embedding: Buffer | Uint8Array
  model: string
  dims: number
  updated_at: number
}

export type SummaryRow = {
  id: string
  session_id: string
  project_id: string
  content: string
  truth_state: TruthState
  created_at: number
}
