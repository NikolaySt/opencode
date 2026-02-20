# Memory Implementation Plan

This is the concrete, file-level implementation plan for the built-in memory system in OpenCode. It is built as a **new-style plugin** that ships with core, filling the exclusive `"memory"` slot.

**Status**: Phase 1 (basic memory) and Phase 2 (full lifecycle) are COMPLETE. All 16 source files implemented and tested. Context-aware injection budget scaling prevents "prompt is too long" errors. 429 tests passing across 14 test files (1000 expect() calls). See `MEMORY_ARCHITECTURE.md` for the full technical reference and `MEMORY_LIFECYCLE_PLAN.md` for the lifecycle design.

---

## Architecture Decision

**Build as a built-in plugin, not core infrastructure.**

Rationale:

- The `"memory"` exclusive slot already exists in `src/plugin/slots.ts`
- The `agent.start` hook already supports `systemPrompt` and `prependContext` injection
- The `session.archived` hook exposes session end events for extraction
- Users can disable or replace the memory plugin without touching core
- The plugin API provides tools, services, cron, pipeline stages, and bus — everything needed

The plugin lives at `packages/opencode/src/memory/` as an internal built-in module.

---

## Storage Decision

**Use `bun:sqlite` (built into Bun, zero external dependencies).**

OpenCode already runs on Bun. `bun:sqlite` provides synchronous SQLite access without native module compilation. The schema is custom-designed with:

- WAL journal mode for concurrent read/write
- Embeddings stored as BLOBs (float64, 8 bytes/dim) not JSON
- FTS5 external-content mode (no text duplication)
- Versioned migrations (currently v2)
- Entity table for structured search

The SQLite database lives at `~/.local/share/opencode/memory/{projectID}.sqlite`, scoped per project.

---

## Phase 1 — Foundations (COMPLETE)

### Deliverables (All Done)

1. [x] SQLite-backed memory store with vector + keyword search
2. [x] `MEMORY.md` + `memory/` directory as the knowledge source
3. [x] `memory_search` and `memory_get` tools for agent retrieval
4. [x] Session summary extraction after each session
5. [x] Context injection at agent start via `agent.start` hook
6. [x] File watching for knowledge file changes
7. [x] OpenAI embedding provider with retry + batching

### File Structure (All Implemented)

```
packages/opencode/src/memory/
  index.ts              # Plugin entry: definition + register() wiring
  store.ts              # SQLite database lifecycle, CRUD, FTS, entities, GC
  schema.ts             # SQL DDL (v1 + v2 migrations), row types
  chunk.ts              # Markdown chunking with heading preservation
  embed.ts              # Embedding provider interface, registry, cosine, BLOB serde
  embed-openai.ts       # OpenAI embedding provider (retry, batching)
  search.ts             # Hybrid search with composable filters
  sync.ts               # File discovery, change detection, index pipeline
  extract.ts            # Session summary extraction (title or LLM mode)
  inject.ts             # Priority-based context injection builder
  tools.ts              # memory_search and memory_get tool definitions
  watcher.ts            # Instance-scoped fs.watch with debounce
  config.ts             # Configuration types and resolver
  entity.ts             # Regex + LLM entity extraction
  maintain.ts           # Maintenance engine (5 subsystems)
```

---

## Phase 2 — Full Lifecycle (COMPLETE)

### Deliverables (All Done)

1. [x] Truth states on all memory entries (`hypothesis`, `candidate`, `validated`, `deprecated`, `disputed`)
2. [x] Entity extraction (regex + LLM modes) with structured search
3. [x] Configurable LLM model for memory operations (3-tier resolution)
4. [x] LLM-based session extraction using `EXTRACTION_PROMPT`
5. [x] Composable search filters (source, path, entity, date, truthState)
6. [x] Priority-based context injection (P1-P4 budget system)
7. [x] Maintenance engine: staleness detection, summary TTL, contradiction detection, model migration, orphan cleanup
8. [x] Auto-promote: 3+ similar summaries merged to validated
9. [x] Watcher enhancement: detect new file creation at worktree root
10. [x] `/memory` chat commands (status, sync, gc, maintain, conflicts, promote)

### Schema Changes (v2, Implemented)

```sql
ALTER TABLE chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '';
ALTER TABLE chunks ADD COLUMN last_validated_at INTEGER;

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'path', 'function', 'class', 'technology', 'concept'
  value TEXT NOT NULL,
  UNIQUE(chunk_id, kind, value)
);
```

### Truth State Lifecycle (Implemented)

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
  │     /memory promote            contradicted
  │     or autoPromote                   │
  │                  │                   │
  ▼                  ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  deprecated  │  │  validated   │  │  disputed    │
│  (0.1)       │  │  (1.0)       │  │  (0.3)       │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Search Scoring (Implemented)

```
score = (vectorScore * vectorWeight + textScore * textWeight) * truthWeight * recencyBoost

rankToScore(rank) = neg / (1 + neg)  where neg = -rank
recencyBoost = 1.0 / (1 + daysSinceUpdate / 90)
```

### Maintenance Engine (Implemented)

Five subsystems running as hourly cron:

- **A. Staleness detection** — session chunks referencing deleted/changed files
- **B. Summary lifecycle** — TTL expiry, count cap, auto-promote clusters
- **C. Model migration** — re-embed chunks on embedding model change
- **D. Contradiction detection** — high-similarity entries from different sources
- **E. Orphan cleanup** — hard-delete old deprecated entries

### Bugs Found and Fixed During QA

1. `maintain.ts:detectStale()` — Cross-platform path handling (Windows), bare filename false positives
2. `search.ts:rankToScore()` — Inverted BM25 normalization formula
3. `maintain.ts:autoPromote()` — Loop termination bug (entire loop stopped at first used index)

---

## Phase 3 — Procedural Memory (Future)

### Deliverables

1. Automatic runbook generation from recurring error/fix patterns
2. Preflight verification loop (pipeline stage before `PROCESS`)
3. CI validation stamps (mark entries as `validated` when CI passes)
4. Skill auto-generation from session patterns

### Key Changes

- New `procedures` and `procedure_runs` tables (v3 migration)
- Pattern detection from tool-call sequences across sessions
- Verification stage checks file existence and API contracts
- Skill export as `.opencode/skill/` files

---

## Phase 4 — Shared / Enterprise (Future)

### Deliverables

1. Multi-project memory sharing with scope controls
2. Encryption at rest for memory databases
3. Secret redaction in embeddings
4. Team memory with access control (read/write/promote permissions)
5. Remote memory sync (optional cloud backend)

### Key Changes

- Per-tenant encryption keys
- Scope-based access: `global > org > project > repo > module > file`
- Redaction pipeline strips secrets before embedding
- Conflict resolution for multi-user sync

---

## Testing (Complete)

222 tests passing across 10 test files, 433 expect() calls:

| Test File            | Tests | Coverage                                                          |
| -------------------- | ----- | ----------------------------------------------------------------- |
| `store.test.ts`      | ~53   | Full CRUD, FTS, entities, filters, lifecycle ops, BLOB, GC, stats |
| `search.test.ts`     | ~18   | Embed helpers, hybrid search, all filter types, scoring           |
| `memory.test.ts`     | ~25   | Config, embed registry, extract (title/LLM), integration          |
| `tools.test.ts`      | ~14   | Search formatting, get with security                              |
| `maintain.test.ts`   | ~14   | All 5 subsystems + orchestrator                                   |
| `inject.test.ts`     | ~11   | All priority levels, truncation, edge cases                       |
| `sync.test.ts`       | ~15   | Discovery, indexing, change detection, cache                      |
| `chunk.test.ts`      | ~14   | Chunking, hashing, headings, overlap                              |
| `entity.test.ts`     | ~12   | Regex, LLM, dispatcher                                            |
| `abort-leak.test.ts` | 2     | Memory leak (pre-existing)                                        |

No mocks — all tests use real SQLite databases in temp directories.

```bash
bun test test/memory/     # Run all memory tests
bun run typecheck         # Verify types (only pre-existing script/build.ts error)
```

---

## Dependencies

- `bun:sqlite` — built into Bun, zero external dependency
- `ai` package — for `generateText()` in LLM extraction/entity calls (already a project dependency)
- OpenAI API — for embeddings (users need `OPENAI_API_KEY`)
- No new npm packages required

---

## Modified Core Files

| File                  | Change                                                      |
| --------------------- | ----------------------------------------------------------- |
| `src/global/index.ts` | Added `Global.Path.memory` for memory database directory    |
| `src/plugin/index.ts` | Bundled memory plugin loading (before discovery candidates) |

---

## Success Criteria

### Phase 1 (Complete)

- [x] Agent can call `memory_search` and get relevant results from `MEMORY.md` / `memory/` files
- [x] Agent can call `memory_get` to read specific lines from memory files
- [x] Memory context is automatically injected at session start
- [x] Session summaries are automatically extracted and searchable
- [x] File changes to `MEMORY.md` trigger re-indexing via watcher
- [x] Embedding cache prevents redundant API calls
- [x] Plugin can be disabled without affecting core functionality
- [x] All tests pass with `bun test`

### Phase 2 (Complete)

- [x] Entity extraction tags chunks with structured metadata
- [x] Search supports composable filters (source, path, entity, date, truthState)
- [x] LLM extraction analyzes session messages for reusable knowledge
- [x] Maintenance engine detects stale entries and auto-deprecates
- [x] Contradiction detection marks conflicting older entries as disputed
- [x] Auto-promote merges 3+ similar summaries into validated entries
- [x] Model migration re-embeds chunks when embedding model changes
- [x] `/memory` chat commands provide full manual control
- [x] 222 tests pass with comprehensive coverage
