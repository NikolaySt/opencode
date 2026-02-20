# Memory Lifecycle Implementation Plan

Complete lifecycle design for the OpenCode memory subsystem — covering ingestion, indexing, search, injection, and continuous maintenance.

**Status**: COMPLETE. All 16 source files implemented. Context-aware injection budget scaling added. 429 tests passing across 14 test files (1000 expect() calls). Multiple bugs found and fixed across six QA audit rounds.

---

## The Core Problem

The initial memory system (Phase 1) had storage and search infrastructure but lacked a **living lifecycle**. Memory was indexed but never invalidated. Summaries were extracted but never expired. Search existed but couldn't filter by anything except text. Injection existed but didn't use search. The result: memory grows stale and noisy over time, which is worse than having no memory at all.

**Phase 2 (this plan) solved all 15 gaps.**

## The 15 Gaps (All Implemented)

| #   | Gap                                             | Severity | Fix Location                         | Status |
| --- | ----------------------------------------------- | -------- | ------------------------------------ | ------ |
| 1   | Injection search is dead code (no query passed) | Critical | `inject.ts`, `index.ts`              | DONE   |
| 2   | Extraction only captures session title          | Critical | `extract.ts` (LLM rewrite)           | DONE   |
| 3   | Summaries never expire                          | High     | `maintain.ts`                        | DONE   |
| 4   | Embedding model change corrupts search          | High     | `maintain.ts`, `schema.ts` v2        | DONE   |
| 5   | No entity/path/date search                      | Medium   | `entity.ts`, `search.ts`, `tools.ts` | DONE   |
| 6   | GC doesn't clean summaries                      | Medium   | `maintain.ts`                        | DONE   |
| 7   | No contradiction detection                      | Medium   | `maintain.ts`                        | DONE   |
| 8   | Watcher misses new file creation                | Medium   | `watcher.ts`                         | DONE   |
| 9   | `autoPromote` config is dead                    | Low      | `maintain.ts`                        | DONE   |
| 10  | MEMORY.md injection is raw prefix               | Low      | `inject.ts`                          | DONE   |
| 11  | Full re-index resets created_at                 | Low      | `sync.ts`                            | DONE   |
| 12  | Chunk IDs change when lines shift               | Low      | `sync.ts`                            | DONE   |
| 13  | FTS strips meaningful chars                     | Low      | `store.ts`                           | DONE   |
| 14  | No agent feedback loop                          | Low      | `tools.ts`                           | DONE   |
| 15  | Naive truncation cuts mid-section               | Low      | `inject.ts`                          | DONE   |

---

## The Complete Lifecycle (5 Stages)

```
    ┌──────────┐      ┌──────────┐      ┌──────────┐      ┌──────────┐
    │ 1.INGEST │─────▶│ 2.INDEX  │─────▶│ 3.SEARCH │─────▶│4.INJECT/ │
    │          │      │          │      │  & RANK  │      │  SERVE   │
    └──────────┘      └──────────┘      └──────────┘      └──────────┘
         ▲                                                      │
         │            ┌─────────────────────────────┐           │
         └────────────│ 5.MAINTAIN (continuous loop) │◀──────────┘
                      │                              │
                      │ staleness · expiry · migrate │
                      │ contradict · promote · prune │
                      └─────────────────────────────┘
```

### Stage 1: INGEST

| Source                             | Trigger                                     | Truth State     |
| ---------------------------------- | ------------------------------------------- | --------------- |
| MEMORY.md / memory/\*.md           | session start, fs.watch dirty, /memory sync | validated (1.0) |
| config.paths (extra files)         | same as above                               | validated (1.0) |
| Session knowledge (LLM extraction) | session.archived hook                       | candidate (0.7) |
| File deletion                      | sync (stale cleanup)                        | chunks DELETED  |

### Stage 2: INDEX

```
file → SHA-256 hash → skip if unchanged → chunk(content)
  → entity extraction (regex or LLM, configurable)
  → embed (with cache, track embedding_model on chunk)
  → upsertChunk (transactional: chunks + FTS5 + entities)
  → upsertFile (update tracking)
```

**Schema v2 additions** (implemented):

- `embedding_model` and `last_validated_at` on chunks table
- New `entities` table (chunk_id, kind, value) with UNIQUE constraint
- Indexes on `updated_at`, `truth_state`, `embedding_model`

### Stage 3: SEARCH & RANK

**Search modes** (all implemented):

- Semantic (vector cosine)
- Keyword (FTS5 BM25)
- By path/glob (SQL GLOB filter)
- By source (memory/sessions)
- By entity tags (entity table join with LIKE)
- By date range (SQL filter on updated_at)
- By truth state (SQL IN filter, single or array)
- Combined (all above composable via `SearchOptions`)

**Ranking formula** (implemented):

```
score = (vecScore * vecW + ftsScore * txtW) * truthWeight * recencyBoost
recencyBoost = 1.0 / (1 + daysSinceUpdate / 90)

rankToScore(rank) = neg / (1 + neg)  where neg = -rank
  rank=-10 → 0.909, rank=-1 → 0.5, rank=0 → 0
```

### Stage 4: INJECT / SERVE

Priority-based injection builder (implemented):

- P1 (30%): MEMORY.md project invariants (up to first ## heading)
- P2 (40%): Relevant search results using first user message as query
- P3 (20%): Recent validated/candidate summaries (up to 5)
- P4 (10%): Entity-matched context from query entities

Truncation at item boundaries via `fitSection()`, never mid-content. Budget overflow from one priority flows to next.

### Stage 5: MAINTAIN

Runs: hourly cron + manual `/memory maintain`.

**A. Staleness Detection** (implemented) — For each session chunk: extract file path references from text (require `/` to avoid bare filename false positives), use `path.isAbsolute()` + `path.join()` for cross-platform resolution, check if referenced files still exist and haven't changed since chunk creation, mark deprecated/disputed as appropriate.

**B. Summary Lifecycle** (implemented) — TTL expiry (configurable, default 90 days), count cap (default 100), auto-promote (3+ similar candidate summaries with cosine > 0.85 get merged — longest promoted to validated, others deprecated).

**C. Model Migration** (implemented) — Detect `embedding_model` mismatch on chunks, re-embed in batches of 50, update chunk + cache.

**D. Contradiction Detection** (implemented) — On new entry: check all chunks for cosine > 0.85 from different source/date (skip same-source within same day to avoid false positives), mark older as disputed with reduced confidence.

**E. Orphan Cleanup** (implemented) — Hard-delete deprecated chunks older than configurable threshold (default 180 days), prune entity orphans, prune embedding cache orphans.

---

## Configurable Model

Memory plugin LLM calls use a 3-tier resolution (implemented):

1. **Plugin config model** — `plugins.entries["opencode-memory"].config.model` (e.g. `"anthropic/claude-haiku-4-5"`)
2. **Global small model** — `Provider.getSmallModel(currentProvider)`
3. **Fallback** — `Provider.defaultModel()`

Config example:

```json
{
  "plugins": {
    "entries": {
      "opencode-memory": {
        "config": {
          "model": "anthropic/claude-haiku-4-5",
          "extraction": {
            "enabled": true,
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

---

## File-by-File Changes (All Complete)

| File          | Action  | Changes                                                                                                                                                                                                       |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`   | Modify  | v2 migration: embedding_model, last_validated_at, entities table, new indexes                                                                                                                                 |
| `store.ts`    | Modify  | Entity CRUD, chunksByFilter(), chunksNeedingMigration(), truth state ops, summary lifecycle ops, meta CRUD, enhanced GC with entity cleanup, stats with entities                                              |
| `entity.ts`   | Create  | Regex + LLM entity extraction, 90+ tech keywords, dispatcher with mode fallback                                                                                                                               |
| `extract.ts`  | Rewrite | LLM-based extraction with EXTRACTION_PROMPT, entity attachment, embedding_model tracking                                                                                                                      |
| `search.ts`   | Modify  | Composable SearchOptions, SQL pre-filter, fixed rankToScore, recency boost, truthState in results                                                                                                             |
| `tools.ts`    | Modify  | Expose source/pathGlob/entity/truthState filters on memory_search, path security on memory_get                                                                                                                |
| `inject.ts`   | Rewrite | Priority-based builder (P1-P4), fitSection() for boundary truncation, entity-matched P4 section                                                                                                               |
| `maintain.ts` | Create  | All 5 maintenance subsystems (staleness, summaries, migration, contradictions, cleanup), run() orchestrator                                                                                                   |
| `watcher.ts`  | Modify  | Watch worktree root for new file creation (e.g. MEMORY.md created after plugin start)                                                                                                                         |
| `sync.ts`     | Modify  | Entity extraction in pipeline, embedding_model tracking, last_validated_at, entityMode + generate params                                                                                                      |
| `config.ts`   | Modify  | model field, extraction.mode, extraction.entityExtraction, full maintenance section                                                                                                                           |
| `index.ts`    | Modify  | 3-tier resolveModel(), createGenerate(), firstUserMessage() for query, session.archived with LLM extraction + contradiction detection, /memory chat commands (status, sync, gc, maintain, conflicts, promote) |

## Bugs Found and Fixed

1. **`maintain.ts:detectStale()` path handling** — `p.startsWith("/")` failed on Windows; template literal path join; bare filenames caused false deprecation. **Fix:** `path.isAbsolute()` + `path.join()`, require `/` in extracted paths.

2. **`search.ts:rankToScore()` inverted formula** — `1/(1+|rank|)` gave better matches lower scores. **Fix:** `neg/(1+neg)` where `neg = -rank`.

3. **`maintain.ts:autoPromote()` loop termination** — `!used.has(i)` as loop condition terminated entire loop at first used index. **Fix:** `if (used.has(i)) continue` inside loop body.

## Implementation Order (Completed)

1. schema.ts + store.ts + config.ts (foundation) — DONE
2. entity.ts + search.ts + tools.ts (entity extraction + enhanced search) — DONE
3. extract.ts + inject.ts + index.ts (extraction rewrite + injection fix) — DONE
4. maintain.ts + watcher.ts + sync.ts (maintenance engine) — DONE
5. Tests + QA review (222 tests, 3 bugs fixed) — DONE
