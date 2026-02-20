# Memory System Architecture

Comprehensive technical reference for the OpenCode memory subsystem — a built-in plugin that provides persistent cross-session memory via SQLite-backed RAG (Retrieval-Augmented Generation) with hybrid vector + keyword search and full lifecycle management.

**Status**: Phase 1 (basic memory) and Phase 2 (full lifecycle) are complete and tested. Context-aware injection budget scaling added. 429 tests pass across 14 test files (1000 expect() calls).

---

## Table of Contents

- [Overview](#overview)
- [Design Decisions](#design-decisions)
- [Module Map](#module-map)
- [Data Model](#data-model)
  - [SQLite Schema](#sqlite-schema)
  - [Entity Relationships](#entity-relationships)
  - [Truth States](#truth-states)
- [Core Pipelines](#core-pipelines)
  - [Indexing Pipeline](#indexing-pipeline)
  - [Search Pipeline](#search-pipeline)
  - [Injection Pipeline](#injection-pipeline)
  - [Extraction Pipeline](#extraction-pipeline)
  - [Maintenance Pipeline](#maintenance-pipeline)
- [Plugin Wiring](#plugin-wiring)
  - [Registration Lifecycle](#registration-lifecycle)
  - [Hooks](#hooks)
  - [Tools](#tools)
  - [Services and Cron](#services-and-cron)
  - [Chat Commands](#chat-commands)
- [Embedding System](#embedding-system)
  - [Provider Abstraction](#provider-abstraction)
  - [BLOB Serialization](#blob-serialization)
  - [Embedding Cache](#embedding-cache)
- [Entity Extraction](#entity-extraction)
  - [Regex Mode](#regex-mode)
  - [LLM Mode](#llm-mode)
- [Model Resolution](#model-resolution)
- [File Watcher](#file-watcher)
- [Configuration](#configuration)
- [Bugs Found and Fixed](#bugs-found-and-fixed)
- [Cross-Platform Considerations](#cross-platform-considerations)
- [Testing](#testing)
- [Future Phases](#future-phases)

---

## Overview

The memory system gives OpenCode agents persistent recall across sessions. When an agent starts, it receives injected context from previous sessions and project knowledge files. During a session, agents can call `memory_search` and `memory_get` tools to query the knowledge base. When a session ends, its key decisions are extracted and stored for future retrieval. A continuous maintenance engine keeps the knowledge base fresh by detecting staleness, expiring old entries, migrating embeddings, and detecting contradictions.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Agent Session                             │
│                                                                  │
│   ┌──────────────┐    ┌───────────────┐    ┌─────────────────┐  │
│   │ agent.start   │───▶│ inject.ts     │───▶│ prependContext  │  │
│   │ hook          │    │ (build)       │    │ in system msg   │  │
│   └──────────────┘    └───────────────┘    └─────────────────┘  │
│                                                                  │
│   ┌──────────────┐    ┌───────────────┐    ┌─────────────────┐  │
│   │ Agent calls   │───▶│ search.ts     │───▶│ Formatted       │  │
│   │ memory_search │    │ (hybrid)      │    │ results         │  │
│   └──────────────┘    └───────────────┘    └─────────────────┘  │
│                                                                  │
│   ┌──────────────┐    ┌───────────────┐    ┌─────────────────┐  │
│   │ session       │───▶│ extract.ts    │───▶│ Summary stored  │  │
│   │ .archived     │    │ + entity.ts   │    │ + entities      │  │
│   └──────────────┘    └───────────────┘    └─────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
        │                       │                       │
        │            ┌──────────▼──────────┐            │
        │            │   SQLite Database   │            │
        │            │   (per project)     │            │
        │            │                     │            │
        │            │  files              │            │
        │            │  chunks + FTS5      │            │
        │            │  entities           │            │
        │            │  embedding_cache    │            │
        │            │  summaries          │            │
        │            │  meta               │            │
        │            └──────────┬──────────┘            │
        │                       │                       │
        │            ┌──────────▼──────────┐            │
        └───────────▶│  maintain.ts        │◀───────────┘
                     │  (hourly cron)      │
                     │                     │
                     │  A. Staleness       │
                     │  B. Summary TTL     │
                     │  C. Model migration │
                     │  D. Contradictions  │
                     │  E. Orphan cleanup  │
                     └─────────────────────┘
```

---

## Design Decisions

| Decision                       | Rationale                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Built-in plugin, not core**  | Uses the `"memory"` exclusive slot. Users can disable or replace it without touching core. The plugin API provides hooks, tools, services, cron — everything needed.                 |
| **`bun:sqlite` storage**       | Zero-dependency, synchronous SQLite built into Bun. WAL mode for concurrent reads. No native module compilation.                                                                     |
| **Embeddings as BLOBs**        | 8 bytes/dim (float64) vs ~18 chars/dim in JSON. ~4x storage reduction. Serialized via `DataView` for cross-platform correctness.                                                     |
| **FTS5 external-content mode** | FTS index doesn't duplicate the `text` column storage. Sync is manual (insert/delete in transactions) but saves ~50% disk space.                                                     |
| **Brute-force vector search**  | For typical memory files (<1000 chunks), in-memory cosine similarity is fast enough. No sqlite-vec dependency required.                                                              |
| **SHA-256 change detection**   | File and chunk hashes enable skip-unchanged-files and embedding cache hits. Only changed content is re-embedded.                                                                     |
| **Forward-slash chunk IDs**    | `path.relative` returns backslashes on Windows. Chunk IDs normalize to `/` for cross-platform database portability.                                                                  |
| **Configurable LLM model**     | Memory LLM calls (extraction, entity) use a 3-tier model resolution independent of the main agent model, defaulting to a cheap/small model.                                          |
| **Aggressive auto-deprecate**  | Summaries referencing deleted/changed files are auto-deprecated. TTL expiry, contradiction detection, and orphan cleanup run continuously.                                           |
| **Context-aware injection**    | Memory estimates remaining context budget before injecting. Scales down or skips injection when the session is near the model's context limit. Prevents "prompt is too long" errors. |

---

## Module Map

```
packages/opencode/src/memory/
├── index.ts          Plugin entry: definition + register() wiring
├── schema.ts         SQL table DDL (v1 + v2 migrations), row types
├── store.ts          SQLite lifecycle, CRUD, FTS, entities, GC
├── chunk.ts          Markdown chunking with heading preservation
├── config.ts         MemoryConfig / ResolvedConfig types, resolve()
├── embed.ts          Provider interface, registry, cosine, BLOB serde
├── embed-openai.ts   OpenAI embedding provider (retry, batching)
├── entity.ts         Regex + LLM entity extraction, dispatcher
├── sync.ts           File discovery, change detection, index pipeline
├── search.ts         Hybrid vector + FTS5 search with composable filters
├── tools.ts          memory_search and memory_get tool definitions
├── inject.ts         Priority-based context injection builder
├── extract.ts        Session summary extraction (title or LLM mode)
├── maintain.ts       Maintenance engine (5 subsystems + orchestrator)
└── watcher.ts        Instance-scoped fs.watch with debounce
```

### Modified Core Files

| File                  | Change                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/global/index.ts` | Added `Global.Path.memory` (`~/.local/share/opencode/memory/`) and directory creation at startup                                   |
| `src/plugin/index.ts` | Bundled memory plugin loading block. Loads before discovery candidates, participates in slot resolution. Uses `origin: "bundled"`. |

---

## Data Model

### SQLite Schema

One database per project, stored at `~/.local/share/opencode/memory/{projectID}.sqlite`. The `projectID` is `Instance.project.id` — the git root commit hash, falling back to `"global"` for non-git directories.

Schema version is currently **v2** with two migrations applied in sequence.

```
┌──────────────────────────────────────────────────────────────────┐
│                    meta                                           │
│  ┌──────────────┬────────────────────────────────────────────┐   │
│  │ key (PK)     │ value                                      │   │
│  ├──────────────┼────────────────────────────────────────────┤   │
│  │ schema_ver…  │ "2"                                        │   │
│  └──────────────┴────────────────────────────────────────────┘   │
│                                                                  │
│                    files                                          │
│  ┌──────────────┬────────┬──────┬───────┬──────────┐            │
│  │ path (PK)    │ source │ hash │ mtime │ size     │            │
│  └──────────────┴────────┴──────┴───────┴──────────┘            │
│                       │                                           │
│          ┌────────────┘                                           │
│          │ 1:N                                                    │
│          ▼                                                        │
│                    chunks                                         │
│  ┌────────────┬──────┬────────┬───────────┬───────────┐         │
│  │ id (PK)    │ path │ source │ start_line│ end_line  │         │
│  ├────────────┼──────┼────────┼───────────┼───────────┤         │
│  │ hash       │ text │ embedding (BLOB)   │ truth_st… │         │
│  ├────────────┼──────┼────────────────────┼───────────┤         │
│  │ confidence │ created_at │ updated_at   │           │         │
│  ├────────────┼────────────┼──────────────┤  (v2)     │         │
│  │ embedding_model          │ last_validated_at       │         │
│  └────────────┴─────────────┴─────────────────────────┘         │
│          │                                                        │
│          │ external-content                                       │
│          ▼                                                        │
│                chunks_fts (FTS5)                                  │
│  ┌──────────────────────────────────────────────────┐            │
│  │  text  (content='chunks', content_rowid='rowid') │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                  │
│          │ 1:N                                                    │
│          ▼                                                        │
│                entities (v2)                                      │
│  ┌──────────┬──────────┬──────┬───────────────────┐             │
│  │ id (PK)  │ chunk_id │ kind │ value             │             │
│  │ AUTO     │          │      │ UNIQUE(chunk,k,v) │             │
│  └──────────┴──────────┴──────┴───────────────────┘             │
│                                                                  │
│                embedding_cache                                    │
│  ┌──────────┬────────────────┬───────┬──────┬─────────┐         │
│  │ hash(PK) │ embedding(BLOB)│ model │ dims │upd_at   │         │
│  └──────────┴────────────────┴───────┴──────┴─────────┘         │
│                                                                  │
│                summaries                                          │
│  ┌──────────┬────────────┬────────────┬─────────┬─────┐         │
│  │ id (PK)  │ session_id │ project_id │ content │tr…  │         │
│  ├──────────┼────────────┼────────────┼─────────┼─────┤         │
│  │ created_at                                         │         │
│  └────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────┘
```

#### Full DDL

**Schema v1** — initial tables:

```sql
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
```

**Schema v2** — lifecycle extensions:

```sql
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
```

#### Migration Strategy

Migrations are stored in a versioned dictionary (`MIGRATIONS["1"]`, `MIGRATIONS["2"]`, etc.) in `schema.ts`. The `meta` table tracks the current `schema_version`. On startup, `store.migrate()` runs all unapplied migrations in order. Future versions append `ALTER TABLE` / new `CREATE TABLE` statements — existing data is never dropped.

### Entity Relationships

```
files 1───N chunks
  │              │
  │ path         │ id = "{relative_path}:{startLine}-{endLine}"
  │ hash         │ path (absolute)
  │              │ hash (SHA-256 of chunk text)
  │              │ embedding (BLOB, 8 bytes/dim)
  │              │ embedding_model (tracks which model generated the embedding)
  │              │ last_validated_at (timestamp of last freshness check)
  │              │
  │              ├──── chunks_fts (external-content, synced via transactions)
  │              │
  │              └──── entities (1:N, UNIQUE on chunk_id+kind+value)
  │                    │ kind: "path" | "function" | "class" | "technology" | "concept"
  │                    │ value: the extracted entity string
  │
embedding_cache
  │ hash = chunk.hash (SHA-256 of chunk text)
  │ embedding (BLOB)
  │ model, dims — for cache invalidation on model change
  │
summaries
  │ id = "summary:{sessionID}"
  │ session_id, project_id
  │ content (extracted knowledge text)
  │ truth_state (candidate → validated | deprecated | disputed)
  │ Also indexed as a chunk with source="sessions" (same ID)
```

### Truth States

Every chunk and summary carries a `truth_state` field that feeds into search ranking:

| State        | Weight | Description                                              |
| ------------ | ------ | -------------------------------------------------------- |
| `validated`  | 1.0    | Confirmed knowledge (from MEMORY.md or promoted entries) |
| `candidate`  | 0.7    | Extracted session knowledge awaiting validation          |
| `hypothesis` | 0.4    | Speculative or unverified entries                        |
| `disputed`   | 0.3    | Contradicted by newer evidence                           |
| `deprecated` | 0.1    | Superseded or outdated                                   |

**State transitions** (implemented in Phase 2):

```
              ┌──────────────┐
              │  hypothesis  │
              │  (0.4)       │
              └──────┬───────┘
                     │ evidence added
                     ▼
              ┌──────────────┐
  ┌───────────│  candidate   │───────────┐
  │           │  (0.7)       │           │
  │           └──────┬───────┘           │
  │                  │                   │
  │     /memory promote            contradicted by
  │     or autoPromote             newer entry (D)
  │     (3+ similar) (B)                │
  │                  │                   │
  ▼                  ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  deprecated  │  │  validated   │  │  disputed    │
│  (0.1)       │  │  (1.0)       │  │  (0.3)       │
└──────────────┘  └──────────────┘  └──────────────┘
      ▲                  │
      │           newer entry
      │           supersedes (A)
      └──────────────────┘

(A) = maintain.detectStale
(B) = maintain.autoPromote
(D) = maintain.detectContradictions
```

File-sourced chunks start as `validated` (1.0). Session summaries start as `candidate` (0.7). The maintenance engine continuously manages transitions.

---

## Core Pipelines

### Indexing Pipeline

File sync (`sync.ts`) is the heart of the indexing system. It runs on session start, on lazy re-sync before search (when the watcher flags dirty), and on manual `/memory sync`.

```
                    discover()
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   MEMORY.md       memory/*.md     config.paths
        │               │               │
        └───────┬───────┘───────────────┘
                │
                ▼
        readAndHash() for each file
                │
                ▼
    ┌───── hash changed? ─────┐
    │ NO                  YES │
    ▼                         ▼
 unchanged++          chunk(content)
                              │
                              ▼
                    ┌── for each chunk ──┐
                    │                    │
                    ▼                    ▼
          cache hit?               cache miss
          (by hash)                    │
              │                        ▼
              │                 provider.embed()
              │                        │
              │                 cacheEmbedding()
              │                        │
              └────────┬───────────────┘
                       │
                       ▼
               upsertChunk()  (transactional: chunks + FTS5)
                       │
                       ▼
               extractEntities() (regex or LLM mode)
                       │
                       ▼
               upsertEntities() (kind/value tags)
                       │
                       ▼
               upsertFile()   (update files table)
                       │
                       ▼
         Clean up stale files (deleted from disk)
```

**File discovery** (`sync.discover()`):

1. Check `MEMORY.md` / `memory.md` in project root (stop after first match — same file on case-insensitive FS)
2. Scan `memory/` directory for all `**/*.md` files
3. Resolve extra paths from config (supports both files and directories)
4. Dedup by absolute resolved path

**Chunking** (`chunk.chunk()`):

- Character-budget, line-oriented splitting (default: 400 tokens \* 4 chars = 1600 chars)
- Overlap carry from tail of previous chunk (default: 80 tokens)
- Heading context: prepends the most recent `#`-`######` heading hierarchy to chunks that don't start with one
- SHA-256 hash per chunk for change detection and cache keying
- Never drops content — single lines exceeding budget are accepted as-is

**Chunk ID format**: `{relative_path}:{startLine}-{endLine}` with forward-slash normalization for cross-platform stability.

**Chunk metadata** (v2): Each chunk stores `embedding_model` (the model that generated its embedding) and `last_validated_at` (timestamp of last freshness validation). File-sourced chunks get `last_validated_at = now` on every sync.

### Search Pipeline

Hybrid search (`search.ts`) combines vector similarity with FTS5 keyword matching and composable SQL pre-filters:

```
          query string + SearchOptions
              │
     ┌────────┤
     │        │
     ▼        ▼
  Build     SQL pre-filter (composable WHERE clauses)
  filter    ├── source = ?
  from      ├── path GLOB ?
  options   ├── truth_state IN (?)
            ├── updated_at >= ? (dateRange)
            ├── embedding_model = ?
            └── entity join (kind = ? AND value LIKE ?)
              │
              ▼
     chunksByFilter() or allChunks()
              │
     ┌────────┴────────┐
     ▼                  ▼
 provider.embed()   store.searchFts()
     │                  │
     ▼                  ▼
 cosine vs all      FTS5 BM25 rank
 filtered chunks    → rankToScore()
     │                  │
     ▼                  ▼
 vectorScores       textScores
 Map<id, score>     Map<id, score>
     │                  │
     └────────┬─────────┘
              │
              ▼
    Hybrid Merge (weighted union by chunk ID)
    score = (vecScore * 0.7 + txtScore * 0.3) * truthWeight * recencyBoost
              │
              ▼
    Filter by minScore (0.3), sort desc, limit to maxResults (8)
              │
              ▼
    SearchResult[] { id, path, startLine, endLine, text, score, source, truthState }
```

**Composable filters** (`SearchOptions`): source, pathGlob, entity, dateRange, truthState, recencyBoost. These are converted to SQL WHERE clauses that reduce the candidate set before brute-force vector search.

**BM25 normalization** (`rankToScore`): FTS5 rank values are negative (more negative = better match). Formula: `score = neg / (1 + neg)` where `neg = -rank`. This maps rank=-10 to score=0.909, rank=-1 to 0.5, rank=0 to 0.

**Truth weight**: Each truth state has a fixed multiplier applied to the final score: validated=1.0, candidate=0.7, hypothesis=0.4, disputed=0.3, deprecated=0.1.

**Recency boost**: `1.0 / (1 + daysSinceUpdate / 90)`. Recently updated entries score higher. Can be disabled with `recencyBoost: false`.

**FTS sanitization**: Query tokens are stripped of all non-alphanumeric characters to prevent FTS5 syntax injection. Each cleaned token is quoted and joined with `AND`.

**Text-only matches**: Chunks found by FTS but not vector search are included via an O(1) `idToIdx` lookup map, scored with `textScore * textWeight * truthWeight * recencyBoost`.

### Injection Pipeline

Context injection (`inject.ts`) builds the memory packet at agent start using a priority-based budget system with **context-aware scaling** to prevent overflowing the model's context window.

#### Context-Aware Budget Scaling

Before building injection content, the system estimates how much context budget remains:

1. **Model limit**: Resolved via `Provider.getModel()` from the `agent.start` event's model info
2. **Used tokens**: Read from the last assistant message's token counts (`tokens.total` or `input + output + cache.read + cache.write`)
3. **Available budget**: `contextLimit - usedTokens - SAFETY_MARGIN (5000 tokens)`
4. **Effective maxTokens**: `min(configured maxTokens, available budget)`

Three operating modes based on available budget:

| Condition                               | Mode           | Behavior                                                                                                                       |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Available < 200 tokens                  | **Skip**       | Injection skipped entirely. Records `injectionSkippedOverflow` metric.                                                         |
| Available < 50% of configured maxTokens | **Compressed** | Fewer items (2 search results, 2 summaries), shorter snippets (100 chars), MEMORY.md capped at 800 chars, P4 entities skipped. |
| Available >= 50% of maxTokens           | **Normal**     | Full budget with standard limits (5 search results, 5 summaries, 300-char snippets).                                           |

The `effectiveBudget()` function is exported for testability and computes the budget decision as a pure function.

Additionally, the `injection.maxTokensPercent` config option allows capping the injection budget as a percentage of the model's context window (e.g., `2` = max 2% of context for memory).

#### Priority-Based Content Building

```
agent.start hook fires
        │
        ▼
    Lazy re-sync if watcher.isDirty()
        │
        ▼
    firstUserMessage(sessionID)  ← query for P2/P4
        │
        ▼
    Resolve model context limit + last assistant token usage
        │
        ▼
    effectiveBudget() → skip / compressed / normal
        │
        ▼
    inject.build()
        │
    totalBudget = effectiveMaxTokens * 4 chars
        │
    ┌───┼───────────────────────┬──────────────────┐
    │ P1 (30%)                  │ P2 (40%)          │ P3 (20%)         │ P4 (10%)
    │ MEMORY.md                 │ search(query)     │ recentSummaries  │ entity match
    │ up to first ## heading    │ top 5 (or 2)      │ last 5 (or 2)    │ from query
    │ (800 char cap compressed) │ score > 0.25      │                  │ (skipped if
    │                           │                   │                  │  compressed)
    └───┬───────────────────────┴──────────┬────────┴────────┬─────────┘
        │                                   │                 │
        ▼                                   ▼                 ▼
    fitSection()               fitSection()        fitSection()
    (truncate at item          (truncate at item   (truncate at item
     boundary, not mid-text)    boundary)           boundary)
        │                                   │                 │
        └────────────────┬──────────────────┘─────────────────┘
                         │
                         ▼
    ## Project Memory
    ### Key Knowledge     ← P1: MEMORY.md header
    ### Relevant Context  ← P2: search snippets
    ### Recent Sessions   ← P3: summary bullet points
    ### Related Entities  ← P4: entity-matched chunks
                         │
                         ▼
    Return as prependContext (or undefined if empty)
```

Budget overflow from one priority flows to the next. `fitSection()` truncates at item boundaries, never mid-content.

#### Edge Cases

| Case                                    | Behavior                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| First message (no prior assistant)      | No token data → use full configured maxTokens                    |
| Model has `limit.context = 0` (unknown) | Skip scaling, use full maxTokens                                 |
| Session already over limit              | Available goes negative → skip injection                         |
| Compaction just happened                | Last assistant has reduced token count → more room for injection |
| Model lookup or session access fails    | Proceed with unclamped budget (graceful degradation)             |

### Extraction Pipeline

Session summary extraction (`extract.ts`) runs on the `session.archived` hook:

```
session.archived event
        │
        ▼
    Session.get(sessionID)
        │
        ▼
    ┌── extractionMode? ──┐
    │ "title"         "llm" │
    ▼                       ▼
  session.title      Read session messages (up to 50)
                     Build text: "[role]: content" for each
                     Prepend session title
                            │
                            ▼
                     generate(EXTRACTION_PROMPT + text)
                     → structured knowledge list
                     → fallback to raw summary on error/NONE
        │                   │
        └───────┬───────────┘
                │
                ▼
    Skip if title is default / empty / "NONE"
                │
                ▼
    id = "summary:{sessionID}"
    truth_state = "candidate"
                │
                ▼
    upsertSummary(id, content, candidate)
                │
                ▼
    extractEntities(content, entityMode)
                │
                ▼
    provider.embed(content) → serialize → BLOB
                │
                ▼
    upsertChunk(id, source="sessions", path="sessions/{sessionID}")
    upsertEntities(id, entities)
    cacheEmbedding(hash, blob)
                │
                ▼
    detectContradictions(store, id)  ← if contradictionDetection enabled
```

**Deterministic IDs**: Summary ID and chunk ID both use `summary:{sessionID}` — re-extraction for the same session is idempotent (upsert).

**Two extraction modes**:

- `"title"` — Zero LLM cost. Stores the session title directly.
- `"llm"` — Uses `EXTRACTION_PROMPT` to analyze session messages and extract structured knowledge (decisions, root causes, patterns, conventions). Falls back to raw summary on API error or "NONE" response.

### Maintenance Pipeline

The maintenance engine (`maintain.ts`) runs as an hourly cron job and can be triggered manually via `/memory maintain`. It has five subsystems:

```
maintain.run()
    │
    ├── A. detectStale(store, worktree)       [if autoDeprecate]
    │       For each session chunk:
    │       - Extract file path references from text
    │       - Require "/" in paths (avoid bare filename false positives)
    │       - Use path.isAbsolute() + path.join() for resolution
    │       - If ALL referenced files deleted → deprecated (0.1)
    │       - If some files changed after chunk creation → disputed, lower confidence
    │
    ├── B. manageSummaries(store, provider, projectID, config)
    │       - TTL expiry: candidates older than summaryTTLDays → deprecated
    │       - Count cap: if > maxSummaries, delete oldest deprecated/candidate
    │       - autoPromote: find clusters of 3+ similar summaries (cosine > 0.85)
    │         → promote longest as validated, deprecate others
    │
    ├── C. migrateEmbeddings(store, provider)
    │       - Find chunks where embedding_model != provider.model()
    │       - Re-embed in batches of 50
    │       - Update chunk embedding + model + cache
    │
    ├── D. detectContradictions(store, newChunkId)  [per-entry, after extraction]
    │       - Compare new entry's embedding against all chunks
    │       - Skip deprecated, skip same-source within same day
    │       - If cosine > 0.85 from different source/date → mark older as disputed
    │
    ├── E. cleanupDeprecated(store, deprecatedCleanupDays)
    │       - Hard-delete deprecated chunks older than threshold (default 180 days)
    │
    └── store.gc()
            - FTS5 optimize (lightweight merge)
            - Prune orphaned embedding cache entries
            - Prune entity tags for deleted chunks
```

---

## Plugin Wiring

### Registration Lifecycle

The memory plugin is a **bundled new-style plugin** loaded in `src/plugin/index.ts`:

```
Plugin.load()
    │
    ▼
Import MemoryPlugin from "../memory/index"
    │
    ▼
Check plugins.entries["opencode-memory"].enabled !== false
    │
    ▼
Resolve "memory" exclusive slot (resolveSlotDecision)
    │
    ▼
Validate plugin config
    │
    ▼
Create PluginApi via registryFactory.createApi()
    │
    ▼
MemoryPlugin.register(api)
    │
    ├── MemoryConfig.resolve(api.pluginConfig)
    ├── MemoryStore.create(projectID).open()
    ├── Embed.create(config.embedding.provider, {...})
    ├── createGenerate(config) → LLM generate function (3-tier model resolution)
    ├── Sync.sync() (initial)
    ├── api.registerTool(memorySearch, { name: "memory_search" })
    ├── api.registerTool(memoryGet, { name: "memory_get" })
    ├── api.on("agent.start", ...) (injection with context-aware budget scaling)
    ├── api.on("session.archived", ...) (extraction + contradiction detection)
    ├── api.registerService({ id: "memory-watcher", start, stop })
    ├── api.registerCron({ id: "memory-maintenance", schedule: 1h, handler: run })
    └── api.registerChatCommand({ name: "memory", handler })
```

The plugin loads **before** discovery candidates so it wins the `"memory"` slot by default. Community memory plugins can override it via `plugins.slots.memory = "other-plugin-id"` in config.

### Hooks

| Hook               | Purpose                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent.start`      | Inject memory context as `prependContext`. Triggers lazy re-sync if files changed. Uses first user message as search query. Estimates remaining context budget and scales/skips injection to avoid overflowing the model's context window. |
| `agent.finish`     | Primary trigger for session knowledge extraction (with 5-minute per-session cooldown).                                                                                                                                                     |
| `session.archived` | Fallback trigger for extraction. Read session messages, store as summary + searchable chunk + entities. Run contradiction detection.                                                                                                       |

### Tools

**`memory_search`** — Hybrid semantic + keyword search over project memory.

- Args: `{ query: string, maxResults?: number, source?: string, pathGlob?: string, entity?: string, truthState?: string }`
- Filters: source (memory/sessions), pathGlob, entity (maps to technology kind), truthState
- Returns: Formatted markdown with source citations (`Source: path#Lstart-Lend`), scores, and truth state
- Falls through to "No relevant memory entries found." on empty results

**`memory_get`** — Read specific lines from a memory file.

- Args: `{ path: string, from?: number, lines?: number }`
- Security: Path traversal protection — restricts reads to within the project worktree. Blocks `..` traversal and absolute paths outside worktree.
- Caps at 200 lines maximum
- Returns: Line-numbered content with file header

### Services and Cron

**`memory-watcher` service**:

- `start`: Initializes `fs.watch` on MEMORY.md, memory.md, memory/, extra config paths, and worktree root (for new file detection)
- `stop`: Closes all watchers and the SQLite database

**`memory-maintenance` cron** (runs every hour):

- Runs the full `maintain.run()` orchestrator (all 5 subsystems + GC)

### Chat Commands

**`/memory`** with subcommands:

- `/memory` or `/memory status` — Show memory stats (files, chunks, summaries, entities, cache, project, provider, extraction mode, LLM model)
- `/memory sync` — Force re-index all knowledge files
- `/memory gc` — Run garbage collection manually
- `/memory maintain` — Run full maintenance cycle (staleness, TTL, migration, contradictions, cleanup, GC)
- `/memory conflicts` — Show disputed and deprecated entries (up to 10 each with snippets)
- `/memory promote <id>` — Promote a chunk to validated with confidence 1.0

---

## Embedding System

### Provider Abstraction

```ts
type EmbeddingProvider = {
  embed(texts: string[]): Promise<number[][]>
  dimensions(): number
  model(): string
}
```

Providers register via `Embed.register(name, factory)`. The factory receives config (`model`, `dimensions`, `baseURL`, `apiKey`). The registry pattern supports adding providers later.

### OpenAI Provider (`embed-openai.ts`)

- Default model: `text-embedding-3-small` (1536 dims)
- Retry: 3 attempts, exponential backoff (500ms base, 8s max)
- Batching: Up to 2048 inputs per request (OpenAI limit)
- Response validation: Checks for `data?.data?.length`, sorts by `index` field
- Dimension override: Forwarded from config for models that support it
- Auto-registers on import via `Embed.register("openai", createProvider)`

### BLOB Serialization

```ts
// Serialize: number[] → Buffer (8 bytes/dim, float64, little-endian)
function serialize(embedding: number[]): Buffer

// Deserialize: Buffer | Uint8Array → number[]
// Uses DataView (not Buffer.readDoubleLE) because bun:sqlite
// returns Uint8Array for BLOB columns, not Buffer.
function deserialize(buf: Buffer | Uint8Array): number[]
```

### Embedding Cache

The `embedding_cache` table is keyed by the SHA-256 hash of the chunk text. On re-index, if a chunk's text hasn't changed (same hash), the embedding is reused from cache without an API call. Cache entries are pruned during GC when no corresponding chunk exists.

---

## Entity Extraction

Entities provide structured searchability beyond free-text. Each chunk can be tagged with entities that enable queries like "what do we know about Redis?" or "changes to src/auth/".

**Entity kinds**: `"path"` | `"function"` | `"class"` | `"technology"` | `"concept"`

### Regex Mode

Fast, zero API cost. Extracts entities using pattern matching:

- **File paths**: Regex for path-like strings. Requires at least one `/` to avoid false positives from bare filenames. Also matches known extensions (`.ts`, `.js`, `.py`, `.rs`, `.go`, `.md`, `.json`, `.yaml`, `.yml`, `.toml`, `.sql`, `.sh`).
- **PascalCase** identifiers: 2+ uppercase segments (e.g., `AuthService`, `UserController`) → kind: `class`
- **camelCase** identifiers: 3+ segments to reduce noise (e.g., `getUserById`) → kind: `function`
- **snake_case** identifiers: 3+ underscore-separated segments (e.g., `get_user_by_id`) → kind: `function`
- **Technology keywords**: Curated set of 90+ technologies (languages, runtimes, frameworks, databases, tools, protocols, AI) → kind: `technology`

All results are deduplicated by `kind:value`.

### LLM Mode

Higher quality, costs tokens. Uses `ENTITY_EXTRACTION_PROMPT` to ask the LLM for a JSON array of `{kind, value}` pairs. Handles markdown code blocks in response, filters invalid kinds, and falls back to regex on JSON parse errors or API failures.

The mode is configurable via `config.extraction.entityExtraction` ("regex" or "llm").

---

## Model Resolution

Memory plugin LLM calls (extraction, entity extraction) use a 3-tier model resolution:

1. **Plugin config model** — `plugins.entries["opencode-memory"].config.model` (e.g. `"anthropic/claude-haiku-4-5"`)
2. **Global small model** — `Provider.getSmallModel(currentProvider)` — auto-detected cheap model for the active provider
3. **Default model** — `Provider.defaultModel()` — the user's configured default

The resolved model is used to create a `generate(prompt) → string` function via `generateText` from the `ai` package with `temperature: 0.2` and `maxOutputTokens: 2000`.

If no model is available, extraction falls back to title mode and entity extraction falls back to regex mode.

---

## File Watcher

`watcher.ts` provides instance-scoped file watching:

- Watches: `MEMORY.md`, `memory.md`, `memory/` (recursive), extra config paths
- **Worktree root watching**: Also watches the worktree root for new file creation (e.g., `MEMORY.md` being created after plugin start). Filters events to only trigger on memory-related filenames.
- Debounces changes by configurable delay (default 1500ms)
- Sets a `dirty` flag — does NOT trigger sync directly
- Sync runs lazily on next `agent.start` if `config.sync.onSearch && watcher.isDirty()`
- Each `create()` call returns an independent watcher instance (no shared global state)
- Cleanup via `stop()` closes all `FSWatcher` handles and clears timers

---

## Configuration

Memory config lives under `plugins.entries["opencode-memory"].config` in `opencode.json`:

```json
{
  "plugins": {
    "entries": {
      "opencode-memory": {
        "enabled": true,
        "config": {
          "model": "anthropic/claude-haiku-4-5",
          "paths": ["docs/architecture.md"],
          "embedding": {
            "provider": "openai",
            "model": "text-embedding-3-small",
            "dimensions": 1536
          },
          "search": {
            "maxResults": 8,
            "minScore": 0.3,
            "vectorWeight": 0.7,
            "textWeight": 0.3
          },
          "sync": {
            "onSessionStart": true,
            "onSearch": true,
            "watch": true,
            "watchDebounceMs": 1500
          },
          "injection": {
            "enabled": true,
            "maxTokens": 2000,
            "maxTokensPercent": 2
          },
          "extraction": {
            "enabled": true,
            "autoPromote": false,
            "mode": "llm",
            "entityExtraction": "regex"
          },
          "maintenance": {
            "summaryTTLDays": 90,
            "maxSummaries": 100,
            "autoDeprecate": true,
            "contradictionDetection": true,
            "deprecatedCleanupDays": 180
          }
        }
      }
    }
  }
}
```

All fields have defaults via `MemoryConfig.resolve()`. The resolver uses `structuredClone(DEFAULTS)` to avoid shared nested object references. Key defaults:

| Field                                | Default                    |
| ------------------------------------ | -------------------------- |
| `enabled`                            | `true`                     |
| `model`                              | `undefined` (auto-resolve) |
| `embedding.provider`                 | `"openai"`                 |
| `embedding.model`                    | `"text-embedding-3-small"` |
| `injection.maxTokens`                | `2000`                     |
| `injection.maxTokensPercent`         | `undefined` (no cap)       |
| `extraction.mode`                    | `"llm"`                    |
| `extraction.entityExtraction`        | `"regex"`                  |
| `maintenance.summaryTTLDays`         | `90`                       |
| `maintenance.maxSummaries`           | `100`                      |
| `maintenance.autoDeprecate`          | `true`                     |
| `maintenance.contradictionDetection` | `true`                     |
| `maintenance.deprecatedCleanupDays`  | `180`                      |

---

## Bugs Found and Fixed

Multiple bugs were found and fixed across six QA audit rounds:

### Initial Review — 3 Bugs

**1. `maintain.ts:detectStale()` — Path Handling (Windows + False Positives)**

**Problem**: Used `p.startsWith("/")` which fails on Windows where paths use backslashes. Also used template literal path join instead of `path.join()`. Bare filenames like `handler.ts` caused false deprecation when the file didn't exist at worktree root.

**Fix**: Used `path.isAbsolute()` + `path.join()` for cross-platform path resolution. Required `/` in extracted paths to avoid bare filename false positives.

**2. `search.ts:rankToScore()` — Inverted Formula**

**Problem**: Original formula `1/(1+|rank|)` was inverted: better FTS5 matches (more negative rank) got lower scores. rank=-10 → score=0.091 (wrong), rank=-1 → 0.5 (correct by accident).

**Fix**: Changed to `neg/(1+neg)` where `neg = -rank`. Now rank=-10 → 0.909, rank=-1 → 0.5, rank=0 → 0.

**3. `maintain.ts:autoPromote()` — Loop Termination**

**Problem**: Outer loop condition `!used.has(i)` caused the entire loop to terminate at the first used index instead of skipping that index and continuing.

**Fix**: Changed to `if (used.has(i)) continue` inside the loop body.

### Sixth Audit — 8 Source Code Fixes

1. **`embed-openai.ts`** — On retryable status exhaustion (429/5xx after all retries), now records `embeddingErrors` metric and throws with status code context.
2. **`embed.ts:69`** — `deserialize` validates buffer length divisibility by 8 and throws on corruption. Type signature widened to accept `null`.
3. **`store.ts:245,249`** — `dateRange.from`/`.to` filter changed from truthiness check to `!== undefined` (timestamp 0 is valid).
4. **`maintain.ts:82-93`** — TOCTOU race fixed: replaced `fs.existsSync()` + `fs.statSync()` with single `try { fs.statSync() } catch { deletedCount++ }`.
5. **`maintain.ts:103`** — Confidence ratchet fix: added `chunk.confidence > 0.2` guard to skip chunks already at floor.
6. **`sync.ts:218-228`** — Entity extraction wrapped in per-chunk try/catch so one chunk's failure doesn't abort remaining chunks.
7. **`tools.ts:111`** — `lines` parameter now uses `Math.max(1, ...)` to prevent 0/negative producing empty response.
8. **`watcher.ts`** — Added `.on("error", ...)` handlers to both target watchers and root watcher to prevent unhandled error crashes.

---

## Cross-Platform Considerations

| Issue                                                             | Solution                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `MEMORY.md` vs `memory.md` on case-insensitive FS (Windows/macOS) | Discovery stops after first match to avoid indexing the same file twice |
| `path.relative()` returns backslashes on Windows                  | Chunk IDs normalize to forward slashes: `.replace(/\\\\/g, "/")`        |
| `bun:sqlite` returns `Uint8Array` for BLOB columns, not `Buffer`  | `deserialize()` uses `DataView` instead of `Buffer.readDoubleLE`        |
| SQLite WAL files can cause `EBUSY` on Windows during cleanup      | Known pre-existing issue in test preload; does not affect production    |
| `p.startsWith("/")` fails for Windows absolute paths              | Use `path.isAbsolute()` instead                                         |
| Bare filenames cause false staleness deprecation                  | `extractPaths()` requires `/` in paths to be considered file references |

---

## Testing

All tests live in `packages/opencode/test/memory/` and use `bun:test` with real SQLite databases in temp directories (no mocks).

**429 tests passing, 1000 expect() calls** across 14 test files:

```
test/memory/
├── store.test.ts        ~86 tests: Schema, CRUD, FTS transactions, entities,
│                         chunksByFilter (8 combos), chunksNeedingMigration,
│                         updateTruthState, touchValidated, updateEmbedding,
│                         summary lifecycle, BLOB round-trip, meta, GC (incl.
│                         no-op after close), stats
├── search.test.ts       ~39 tests: Embed helpers (serialize/deserialize/cosine,
│                         deserialize validation), hybrid search (sort, relevance,
│                         maxResults, minScore), source/pathGlob/entity/truthState
│                         filters, recencyBoost, dateRange, rankToScore formula,
│                         recencyScore formula, combined filters
├── commands.test.ts     ~59 tests: /memory subcommands (status, sync, gc,
│                         maintain, conflicts, promote, metrics, chunks,
│                         summaries, entities, files, inspect, embeddings),
│                         argument parsing, limit capping, error cases
├── memory.test.ts       ~41 tests: Config resolve (defaults, merges, model,
│                         extraction modes, maintenance), embed registry,
│                         extract (title/LLM modes, fallback, NONE, entities,
│                         embedding_model, idempotent), integration
├── maintain.test.ts     ~36 tests: detectStale (deleted/changed files, skip
│                         deprecated, bare filenames, path resolution),
│                         manageSummaries (TTL, count cap, autoPromote),
│                         detectContradictions (different sources, nonexistent
│                         chunk, empty embeddings), cleanupDeprecated (incl.
│                         empty store), migrateEmbeddings, autoPromote edge
│                         cases, run orchestrator
├── tools.test.ts        ~28 tests: memorySearch (formatted results, no-results,
│                         maxResults, source filter, truthState filter, State
│                         field), memoryGet (read lines, from/lines, nonexistent,
│                         path traversal, absolute path, line cap, default lines),
│                         inferEntityKind camelCase
├── inject.test.ts       ~30 tests: No sources → undefined, MEMORY.md header,
│                         summaries, summary limit, search results, truncation,
│                         prefer MEMORY.md, combined, P4 entity context,
│                         no-entity query, H2 boundary slice, fitSection budget,
│                         P1 truncation markers. Context-aware budget: effectiveBudget
│                         (12 pure function tests), build with scaling (skip on
│                         overflow, compressed mode, P4 skip, metric recording,
│                         first-turn fallback, summary limit in compressed mode)
├── entity.test.ts       ~34 tests: Regex (paths, extensions, PascalCase, camelCase,
│                         snake_case, tech keywords, dedup, no entities, empty,
│                         proper name filtering, ignoredEntities), LLM (JSON,
│                         code blocks, invalid JSON, error, invalid kinds, empty
│                         array, non-array, missing fields), dispatcher
├── sync.test.ts         ~22 tests: Discover (MEMORY.md, memory.md, memory/ dir,
│                         nested, dedup, extra files/dirs, nonexistent, relative,
│                         empty), sync (index, skip unchanged, re-index changed,
│                         remove stale, multiple files, cache, cache reuse, FTS,
│                         exact counts)
├── chunk.test.ts        ~15 tests: Empty, single, hash, identical hash, split,
│                         heading context, heading hierarchy, overlap, oversized,
│                         1-indexed, custom options, whitespace, trailing newlines,
│                         heading replacement
├── embed-openai.test.ts ~14 tests: Provider creation (default/custom model,
│                         dimensions, baseURL), mocked API responses (success,
│                         out-of-order indices, empty, malformed), error handling
│                         (missing API key, 400, 429 retry exhaustion, 500 retry
│                         + success, network error), request body inspection,
│                         env var API key
├── watcher.test.ts      ~13 tests: Start/stop lifecycle, dirty flag, clearDirty,
│                         file change detection, multiple watchers, debounce
├── metrics.test.ts       7 tests: Record/get, custom values, snapshot keys
│                         (incl. injectionBudgetScaled/injectionSkippedOverflow),
│                         reset, snapshot isolation
└── abort-leak.test.ts    2 tests: WebFetch memory leak, closure vs bind
```

Run all memory tests:

```bash
bun test test/memory/
```

Run a specific test file:

```bash
bun test test/memory/chunk.test.ts
```

---

## Future Phases

### Phase 3 — Procedural Memory

**Goal**: Automatically generate and verify runbooks from recurring patterns observed across sessions.

- Pattern detection from tool-call sequences across sessions
- New `procedures` and `procedure_runs` tables
- Preflight verification pipeline stage
- CI validation stamps (auto-promote on CI pass)
- Skill auto-generation from successful procedures

### Phase 4 — Shared / Enterprise

**Goal**: Enable team-level memory sharing with access control, encryption, and optional cloud sync.

- Multi-project memory sharing with scope hierarchy (global > org > project > repo)
- Encryption at rest for memory databases
- Secret redaction before embedding (API keys, tokens, passwords)
- Team memory sync with conflict resolution
- Access control (read/write/promote/admin permissions)
