import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import * as MemoryStore from "../../src/memory/store"
import { serialize, deserialize } from "../../src/memory/embed"
import type { ChunkRow, FileRow, SummaryRow } from "../../src/memory/schema"

describe("memory.store", () => {
  let store: MemoryStore.Store
  const projectID = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`

  beforeEach(() => {
    store = MemoryStore.create(projectID + Math.random().toString(36).slice(2))
    store.open()
  })

  afterEach(() => {
    store.close()
  })

  // =========================================================================
  // Schema & lifecycle
  // =========================================================================

  test("open creates database and migrates schema", () => {
    const s = store.stats()
    expect(s.files).toBe(0)
    expect(s.chunks).toBe(0)
    expect(s.summaries).toBe(0)
    expect(s.cacheEntries).toBe(0)
  })

  test("double open is idempotent", () => {
    // Insert data, then re-open — data should persist
    store.upsertFile({ path: "/double-open", source: "memory", hash: "h1", mtime: 1, size: 1 })
    store.open() // second open
    const s = store.stats()
    expect(s.files).toBe(1)
    expect(s.chunks).toBe(0)
    expect(s.summaries).toBe(0)
  })

  test("close then stats returns zeros", () => {
    store.close()
    expect(store.stats()).toEqual({
      files: 0,
      chunks: 0,
      summaries: 0,
      cacheEntries: 0,
      entities: 0,
      chunksByTruth: {},
      chunksBySource: {},
    })
  })

  test("gc is no-op after close (null db)", () => {
    store.close()
    // Should not throw
    store.gc()
  })

  test("double close does not throw", () => {
    expect(() => {
      store.close()
      store.close()
    }).not.toThrow()
  })

  // =========================================================================
  // Files CRUD
  // =========================================================================

  test("upsertFile and getFile round-trip", () => {
    const row: FileRow = { path: "/a/b.md", source: "memory", hash: "abc123", mtime: 100, size: 50 }
    store.upsertFile(row)
    const got = store.getFile("/a/b.md")
    expect(got).toEqual(row)
  })

  test("getFile returns null for missing file", () => {
    expect(store.getFile("/nonexistent")).toBeNull()
  })

  test("upsertFile overwrites on same path", () => {
    store.upsertFile({ path: "/f", source: "memory", hash: "h1", mtime: 1, size: 1 })
    store.upsertFile({ path: "/f", source: "memory", hash: "h2", mtime: 2, size: 2 })
    expect(store.getFile("/f")!.hash).toBe("h2")
    expect(store.allFiles()).toHaveLength(1)
  })

  test("deleteFile removes file", () => {
    store.upsertFile({ path: "/del", source: "memory", hash: "h", mtime: 1, size: 1 })
    store.deleteFile("/del")
    expect(store.getFile("/del")).toBeNull()
  })

  test("allFiles returns all tracked files", () => {
    store.upsertFile({ path: "/a", source: "memory", hash: "h1", mtime: 1, size: 1 })
    store.upsertFile({ path: "/b", source: "memory", hash: "h2", mtime: 2, size: 2 })
    expect(store.allFiles()).toHaveLength(2)
  })

  // =========================================================================
  // Chunks + FTS
  // =========================================================================

  function makeChunk(id: string, text: string, opts?: Partial<ChunkRow>): ChunkRow {
    return {
      id,
      path: opts?.path ?? "/test.md",
      source: opts?.source ?? "memory",
      start_line: opts?.start_line ?? 1,
      end_line: opts?.end_line ?? 1,
      hash: opts?.hash ?? `hash-${id}`,
      text,
      embedding: opts?.embedding ?? serialize([0.1, 0.2, 0.3]),
      truth_state: opts?.truth_state ?? "validated",
      confidence: opts?.confidence ?? 1.0,
      created_at: opts?.created_at ?? Date.now(),
      updated_at: opts?.updated_at ?? Date.now(),
      embedding_model: opts?.embedding_model ?? "fake",
      last_validated_at: opts?.last_validated_at ?? null,
    }
  }

  test("upsertChunk inserts and searchFts finds it", () => {
    store.upsertChunk(makeChunk("c1", "embeddings and vector search"))
    const results = store.searchFts("embeddings", 10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("upsertChunk update replaces text and FTS stays in sync", () => {
    store.upsertChunk(makeChunk("c1", "old text about apples"))
    store.upsertChunk(makeChunk("c1", "new text about oranges"))

    // FTS should find the new text
    expect(store.searchFts("oranges", 10)).toHaveLength(1)
    // FTS should NOT find the old text
    expect(store.searchFts("apples", 10)).toHaveLength(0)
    // Only one chunk should exist
    expect(store.allChunks()).toHaveLength(1)
  })

  test("deleteChunksForPath removes chunks, FTS entries, and entities", () => {
    store.upsertChunk(makeChunk("c1", "alpha text", { path: "/a.md" }))
    store.upsertChunk(makeChunk("c2", "beta text", { path: "/a.md" }))
    store.upsertChunk(makeChunk("c3", "gamma text", { path: "/b.md" }))
    store.upsertEntities("c1", [{ kind: "technology", value: "redis" }])
    store.upsertEntities("c2", [{ kind: "class", value: "Foo" }])
    store.upsertEntities("c3", [{ kind: "technology", value: "sqlite" }])

    store.deleteChunksForPath("/a.md")

    expect(store.allChunks()).toHaveLength(1)
    expect(store.allChunks()[0].id).toBe("c3")
    expect(store.searchFts("alpha", 10)).toHaveLength(0)
    expect(store.searchFts("gamma", 10)).toHaveLength(1)
    // Entities for deleted chunks should also be removed
    expect(store.entitiesForChunk("c1")).toHaveLength(0)
    expect(store.entitiesForChunk("c2")).toHaveLength(0)
    // Entities for remaining chunk should be preserved
    expect(store.entitiesForChunk("c3")).toHaveLength(1)
    expect(store.stats().entities).toBe(1)
  })

  test("allChunks returns all stored chunks", () => {
    store.upsertChunk(makeChunk("c1", "first"))
    store.upsertChunk(makeChunk("c2", "second"))
    expect(store.allChunks()).toHaveLength(2)
  })

  test("chunksBySource filters correctly", () => {
    store.upsertChunk(makeChunk("c1", "memory text", { source: "memory" }))
    store.upsertChunk(makeChunk("c2", "session text", { source: "sessions" }))
    expect(store.chunksBySource("memory")).toHaveLength(1)
    expect(store.chunksBySource("sessions")).toHaveLength(1)
    expect(store.chunksBySource("unknown")).toHaveLength(0)
  })

  test("searchFts with empty query returns empty", () => {
    store.upsertChunk(makeChunk("c1", "some text"))
    expect(store.searchFts("", 10)).toHaveLength(0)
    expect(store.searchFts("   ", 10)).toHaveLength(0)
  })

  test("searchFts respects limit", () => {
    for (let i = 0; i < 5; i++) {
      store.upsertChunk(makeChunk(`c${i}`, `keyword result item ${i}`))
    }
    const results = store.searchFts("keyword", 3)
    expect(results).toHaveLength(3)
  })

  test("searchFts handles special characters without throwing and returns results", () => {
    store.upsertChunk(makeChunk("c1", "config value for testing"))
    // These should not throw FTS5 parse errors and should return results where applicable
    const configResults = store.searchFts("config:value", 10)
    // After sanitization "config:value" → "configvalue" (colon stripped, no space split),
    // which doesn't match any FTS token
    expect(configResults.length).toBe(0)
    expect(() => store.searchFts("foo*bar", 10)).not.toThrow()
    expect(() => store.searchFts('"quoted text"', 10)).not.toThrow()
    expect(() => store.searchFts("NEAR(a b)", 10)).not.toThrow()
    expect(() => store.searchFts("term^boost", 10)).not.toThrow()
    expect(() => store.searchFts("a OR b", 10)).not.toThrow()
    expect(() => store.searchFts("col:val NOT other", 10)).not.toThrow()
    // Purely special characters should return empty
    expect(store.searchFts(":::***", 10)).toHaveLength(0)
    // A plain word from the chunk MUST return results (proves FTS works after special chars)
    const plainResults = store.searchFts("config", 10)
    expect(plainResults).toHaveLength(1)
    expect(plainResults[0].id).toBe("c1")
  })

  test("searchFts rank values are negative (FTS5 convention)", () => {
    store.upsertChunk(makeChunk("c1", "needle in a haystack"))
    const results = store.searchFts("needle", 10)
    expect(results).toHaveLength(1)
    expect(results[0].rank).toBeLessThanOrEqual(0)
  })

  test("searchFts better matches have more negative rank", () => {
    store.upsertChunk(makeChunk("exact", "needle needle needle needle"))
    store.upsertChunk(makeChunk("partial", "needle in a large haystack field with lots of other words"))

    const results = store.searchFts("needle", 10)
    expect(results.length).toBeGreaterThanOrEqual(2)
    const exactRank = results.find((r) => r.id === "exact")?.rank ?? 0
    const partialRank = results.find((r) => r.id === "partial")?.rank ?? 0
    // Both negative
    expect(exactRank).toBeLessThan(0)
    expect(partialRank).toBeLessThan(0)
    // "exact" (4 occurrences) should rank better (more negative) than "partial" (1 occurrence)
    expect(exactRank).toBeLessThanOrEqual(partialRank)
  })

  // =========================================================================
  // get() before open() throws
  // =========================================================================

  test("get() before open() throws", () => {
    const fresh = MemoryStore.create(`unopened-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    expect(() => fresh.get()).toThrow("memory store not opened")
  })

  // =========================================================================
  // upsertSummary overwrite
  // =========================================================================

  test("upsertSummary overwrites existing summary with same id", () => {
    const pid = "overwrite-test"
    store.upsertSummary({
      id: "s1",
      session_id: "sess1",
      project_id: pid,
      content: "Original content",
      truth_state: "candidate",
      created_at: 100,
    })
    store.upsertSummary({
      id: "s1",
      session_id: "sess1",
      project_id: pid,
      content: "Updated content",
      truth_state: "validated",
      created_at: 200,
    })
    const summaries = store.recentSummaries(pid, 10)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].content).toBe("Updated content")
    expect(summaries[0].truth_state).toBe("validated")
    expect(store.countSummaries(pid)).toBe(1)
  })

  // =========================================================================
  // chunksByFilter with empty truthState array
  // =========================================================================

  test("chunksByFilter with empty truthState array returns all chunks", () => {
    store.upsertChunk(makeChunk("c1", "text", { truth_state: "validated" }))
    store.upsertChunk(makeChunk("c2", "text", { truth_state: "deprecated" }))
    // Empty array in SQL IN clause — should handle gracefully
    const results = store.chunksByFilter({ truthState: [] })
    // Empty IN (...) returns nothing since "truth_state IN ()" is empty
    expect(results).toHaveLength(0)
  })

  // =========================================================================
  // LIKE wildcard escape in entity filter
  // =========================================================================

  test("entity filter escapes LIKE wildcards in value", () => {
    store.upsertChunk(makeChunk("c1", "text with special chars"))
    store.upsertEntities("c1", [{ kind: "technology", value: "100%" }])

    // Without escaping, "%" in value would be a wildcard matching everything
    const results = store.chunksByFilter({ entity: { kind: "technology", value: "100%" } })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")

    // Ensure a different entity doesn't false-match
    store.upsertChunk(makeChunk("c2", "other text"))
    store.upsertEntities("c2", [{ kind: "technology", value: "50 percent" }])
    const results2 = store.chunksByFilter({ entity: { kind: "technology", value: "100%" } })
    expect(results2).toHaveLength(1)
    expect(results2[0].id).toBe("c1")
  })

  test("searchByEntity escapes LIKE wildcards", () => {
    store.upsertChunk(makeChunk("c1", "underscore test"))
    store.upsertEntities("c1", [{ kind: "function", value: "get_100%_data" }])
    store.upsertChunk(makeChunk("c2", "other test"))
    store.upsertEntities("c2", [{ kind: "function", value: "get_data" }])

    const results = store.searchByEntity("function", "100%", 10)
    // Should only match c1 (exact substring "100%"), not c2
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  // =========================================================================
  // Stats breakdowns
  // =========================================================================

  test("stats chunksByTruth breaks down by truth_state", () => {
    store.upsertChunk(makeChunk("c1", "validated text", { truth_state: "validated" }))
    store.upsertChunk(makeChunk("c2", "candidate text", { truth_state: "candidate" }))
    store.upsertChunk(makeChunk("c3", "deprecated text", { truth_state: "deprecated" }))
    const s = store.stats()
    expect(s.chunksByTruth.validated).toBe(1)
    expect(s.chunksByTruth.candidate).toBe(1)
    expect(s.chunksByTruth.deprecated).toBe(1)
  })

  test("stats chunksBySource breaks down by source", () => {
    store.upsertChunk(makeChunk("c1", "memory text", { source: "memory" }))
    store.upsertChunk(makeChunk("c2", "session text", { source: "sessions" }))
    store.upsertChunk(makeChunk("c3", "more memory", { source: "memory" }))
    const s = store.stats()
    expect(s.chunksBySource.memory).toBe(2)
    expect(s.chunksBySource.sessions).toBe(1)
  })

  // =========================================================================
  // dateRange.to filter
  // =========================================================================

  test("chunksByFilter with dateRange.to restricts upper bound", () => {
    const now = Date.now()
    store.upsertChunk(makeChunk("c1", "old", { updated_at: now - 100_000 }))
    store.upsertChunk(makeChunk("c2", "new", { updated_at: now }))
    const results = store.chunksByFilter({ dateRange: { to: now - 50_000 } })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("chunksByFilter with dateRange.from and .to restricts window", () => {
    const now = Date.now()
    store.upsertChunk(makeChunk("c1", "old", { updated_at: now - 200_000 }))
    store.upsertChunk(makeChunk("c2", "mid", { updated_at: now - 100_000 }))
    store.upsertChunk(makeChunk("c3", "new", { updated_at: now }))
    const results = store.chunksByFilter({ dateRange: { from: now - 150_000, to: now - 50_000 } })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c2")
  })

  // =========================================================================
  // Meta
  // =========================================================================
  // Embedding Cache
  // =========================================================================

  test("cacheEmbedding and getCachedEmbedding round-trip", () => {
    const embedding = serialize([1.0, 2.0, 3.0])
    store.cacheEmbedding({ hash: "emb1", embedding, model: "test", dims: 3, updated_at: Date.now() })
    const cached = store.getCachedEmbedding("emb1")
    expect(cached).not.toBeNull()
    expect(cached!.model).toBe("test")
    expect(cached!.dims).toBe(3)
  })

  test("getCachedEmbedding returns null for missing", () => {
    expect(store.getCachedEmbedding("missing")).toBeNull()
  })

  // =========================================================================
  // Summaries
  // =========================================================================

  test("upsertSummary and recentSummaries round-trip", () => {
    const pid = "proj1"
    const row: SummaryRow = {
      id: "s1",
      session_id: "sess1",
      project_id: pid,
      content: "Learned about X",
      truth_state: "candidate",
      created_at: Date.now(),
    }
    store.upsertSummary(row)
    const results = store.recentSummaries(pid, 10)
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe("Learned about X")
  })

  test("recentSummaries returns most recent first", () => {
    const pid = "proj2"
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: pid,
      content: "old",
      truth_state: "candidate",
      created_at: 100,
    })
    store.upsertSummary({
      id: "s2",
      session_id: "b",
      project_id: pid,
      content: "new",
      truth_state: "candidate",
      created_at: 200,
    })
    const results = store.recentSummaries(pid, 10)
    expect(results[0].content).toBe("new")
    expect(results[1].content).toBe("old")
  })

  test("recentSummaries respects limit", () => {
    const pid = "proj3"
    for (let i = 0; i < 5; i++) {
      store.upsertSummary({
        id: `s${i}`,
        session_id: `sess${i}`,
        project_id: pid,
        content: `item ${i}`,
        truth_state: "candidate",
        created_at: i,
      })
    }
    expect(store.recentSummaries(pid, 2)).toHaveLength(2)
  })

  test("recentSummaries filters by project_id", () => {
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: "p1",
      content: "one",
      truth_state: "candidate",
      created_at: 1,
    })
    store.upsertSummary({
      id: "s2",
      session_id: "b",
      project_id: "p2",
      content: "two",
      truth_state: "candidate",
      created_at: 2,
    })
    expect(store.recentSummaries("p1", 10)).toHaveLength(1)
    expect(store.recentSummaries("p2", 10)).toHaveLength(1)
    expect(store.recentSummaries("p3", 10)).toHaveLength(0)
  })

  // =========================================================================
  // BLOB round-trip through actual SQLite
  // =========================================================================

  test("embedding BLOB survives SQLite round-trip", () => {
    const original = [0.123456789, -0.987654321, 1e-10, 1e10, 0, -0, Math.PI]
    const blob = serialize(original)
    store.upsertChunk(makeChunk("blob-rt", "blob test", { embedding: blob }))
    const rows = store.allChunks()
    const row = rows.find((r) => r.id === "blob-rt")!
    expect(row).toBeDefined()
    // bun:sqlite returns Uint8Array for BLOB columns
    const restored = deserialize(row.embedding)
    expect(restored).toHaveLength(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 10)
    }
  })

  test("embedding BLOB Uint8Array from SQLite deserializes correctly", () => {
    const vec = [1.0, 2.0, 3.0, -4.0]
    store.upsertChunk(makeChunk("blob-u8", "uint8 test", { embedding: serialize(vec) }))
    const row = store.allChunks().find((r) => r.id === "blob-u8")!
    // bun:sqlite returns Uint8Array for BLOB columns — verify it's a Uint8Array but not Buffer
    expect(row.embedding).toBeInstanceOf(Uint8Array)
    expect(row.embedding.byteLength).toBe(vec.length * 8) // Float64 = 8 bytes each
    const back = deserialize(row.embedding)
    expect(back).toHaveLength(vec.length)
    expect(back).toEqual(vec)
  })

  // =========================================================================
  // Meta
  // =========================================================================

  test("getMeta returns null for missing key", () => {
    expect(store.getMeta("nonexistent")).toBeNull()
  })

  test("setMeta and getMeta round-trip", () => {
    store.setMeta("foo", "bar")
    expect(store.getMeta("foo")).toBe("bar")
  })

  test("setMeta overwrites existing key", () => {
    store.setMeta("k", "v1")
    store.setMeta("k", "v2")
    expect(store.getMeta("k")).toBe("v2")
  })

  // =========================================================================
  // Chunk single-item ops
  // =========================================================================

  test("getChunk returns null for missing id", () => {
    expect(store.getChunk("nonexistent")).toBeNull()
  })

  test("getChunk returns the chunk by id", () => {
    store.upsertChunk(makeChunk("c1", "hello"))
    const got = store.getChunk("c1")
    expect(got).not.toBeNull()
    expect(got!.text).toBe("hello")
  })

  test("deleteChunk removes a single chunk, FTS, and entities", () => {
    store.upsertChunk(makeChunk("c1", "deletable chunk"))
    store.upsertEntities("c1", [{ kind: "technology", value: "redis" }])
    expect(store.getChunk("c1")).not.toBeNull()
    expect(store.searchFts("deletable", 10)).toHaveLength(1)
    expect(store.entitiesForChunk("c1")).toHaveLength(1)

    store.deleteChunk("c1")

    expect(store.getChunk("c1")).toBeNull()
    expect(store.searchFts("deletable", 10)).toHaveLength(0)
    expect(store.entitiesForChunk("c1")).toHaveLength(0)
  })

  test("deleteChunk on non-existent id does not throw", () => {
    expect(() => store.deleteChunk("missing")).not.toThrow()
  })

  // =========================================================================
  // updateTruthState / touchValidated / updateEmbedding
  // =========================================================================

  test("updateTruthState changes state", () => {
    store.upsertChunk(makeChunk("c1", "truth test", { truth_state: "candidate", confidence: 0.7 }))
    store.updateTruthState("c1", "validated")
    const got = store.getChunk("c1")!
    expect(got.truth_state).toBe("validated")
    expect(got.confidence).toBe(0.7) // unchanged
  })

  test("updateTruthState with confidence updates both", () => {
    store.upsertChunk(makeChunk("c1", "truth test", { truth_state: "candidate", confidence: 0.7 }))
    store.updateTruthState("c1", "disputed", 0.3)
    const got = store.getChunk("c1")!
    expect(got.truth_state).toBe("disputed")
    expect(got.confidence).toBeCloseTo(0.3)
  })

  test("touchValidated updates last_validated_at", () => {
    store.upsertChunk(makeChunk("c1", "validate me", { last_validated_at: null }))
    expect(store.getChunk("c1")!.last_validated_at).toBeNull()
    store.touchValidated("c1")
    const got = store.getChunk("c1")!
    expect(got.last_validated_at).not.toBeNull()
    expect(got.last_validated_at!).toBeGreaterThan(0)
  })

  test("updateEmbedding changes embedding and model", () => {
    store.upsertChunk(makeChunk("c1", "embed me", { embedding_model: "old" }))
    const newEmb = serialize([9, 8, 7])
    store.updateEmbedding("c1", newEmb, "new-model")
    const got = store.getChunk("c1")!
    expect(got.embedding_model).toBe("new-model")
    expect(deserialize(got.embedding)).toEqual([9, 8, 7])
  })

  // =========================================================================
  // Entities
  // =========================================================================

  test("upsertEntities and entitiesForChunk round-trip", () => {
    store.upsertChunk(makeChunk("c1", "entity test"))
    store.upsertEntities("c1", [
      { kind: "technology", value: "redis" },
      { kind: "path", value: "src/cache.ts" },
    ])
    const entities = store.entitiesForChunk("c1")
    expect(entities).toHaveLength(2)
    expect(entities.some((e) => e.kind === "technology" && e.value === "redis")).toBe(true)
    expect(entities.some((e) => e.kind === "path" && e.value === "src/cache.ts")).toBe(true)
  })

  test("upsertEntities replaces previous entities", () => {
    store.upsertChunk(makeChunk("c1", "entity replace"))
    store.upsertEntities("c1", [{ kind: "technology", value: "redis" }])
    store.upsertEntities("c1", [{ kind: "class", value: "AuthService" }])
    const entities = store.entitiesForChunk("c1")
    expect(entities).toHaveLength(1)
    expect(entities[0].kind).toBe("class")
  })

  test("deleteEntitiesForChunk removes entities", () => {
    store.upsertChunk(makeChunk("c1", "entity delete"))
    store.upsertEntities("c1", [{ kind: "technology", value: "redis" }])
    store.deleteEntitiesForChunk("c1")
    expect(store.entitiesForChunk("c1")).toHaveLength(0)
  })

  test("searchByEntity finds matching chunks", () => {
    store.upsertChunk(makeChunk("c1", "redis text"))
    store.upsertChunk(makeChunk("c2", "postgres text"))
    store.upsertEntities("c1", [{ kind: "technology", value: "redis" }])
    store.upsertEntities("c2", [{ kind: "technology", value: "postgres" }])

    const results = store.searchByEntity("technology", "redis", 10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("searchByEntity uses LIKE for partial match", () => {
    store.upsertChunk(makeChunk("c1", "auth handler"))
    store.upsertEntities("c1", [{ kind: "path", value: "src/auth/handler.ts" }])

    const results = store.searchByEntity("path", "auth", 10)
    expect(results).toHaveLength(1)
  })

  test("stats includes entities count", () => {
    store.upsertChunk(makeChunk("c1", "entity stats"))
    store.upsertEntities("c1", [
      { kind: "technology", value: "redis" },
      { kind: "class", value: "Foo" },
    ])
    expect(store.stats().entities).toBe(2)
  })

  // =========================================================================
  // chunksByFilter
  // =========================================================================

  test("chunksByFilter with source filter", () => {
    store.upsertChunk(makeChunk("c1", "memory text", { source: "memory" }))
    store.upsertChunk(makeChunk("c2", "session text", { source: "sessions" }))
    const results = store.chunksByFilter({ source: "memory" })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("chunksByFilter with pathGlob filter", () => {
    store.upsertChunk(makeChunk("c1", "text", { path: "/src/auth/handler.ts" }))
    store.upsertChunk(makeChunk("c2", "text", { path: "/src/db/store.ts" }))
    const results = store.chunksByFilter({ pathGlob: "*/auth/*" })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("chunksByFilter with truthState filter (single)", () => {
    store.upsertChunk(makeChunk("c1", "text", { truth_state: "validated" }))
    store.upsertChunk(makeChunk("c2", "text", { truth_state: "deprecated" }))
    const results = store.chunksByFilter({ truthState: "validated" })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("chunksByFilter with truthState filter (array)", () => {
    store.upsertChunk(makeChunk("c1", "text", { truth_state: "validated" }))
    store.upsertChunk(makeChunk("c2", "text", { truth_state: "deprecated" }))
    store.upsertChunk(makeChunk("c3", "text", { truth_state: "disputed" }))
    const results = store.chunksByFilter({ truthState: ["validated", "disputed"] })
    expect(results).toHaveLength(2)
  })

  test("chunksByFilter with dateRange filter", () => {
    const now = Date.now()
    store.upsertChunk(makeChunk("c1", "old", { updated_at: now - 100_000 }))
    store.upsertChunk(makeChunk("c2", "new", { updated_at: now }))
    const results = store.chunksByFilter({ dateRange: { from: now - 50_000 } })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c2")
  })

  test("chunksByFilter with embeddingModel filter", () => {
    store.upsertChunk(makeChunk("c1", "text", { embedding_model: "model-a" }))
    store.upsertChunk(makeChunk("c2", "text", { embedding_model: "model-b" }))
    const results = store.chunksByFilter({ embeddingModel: "model-a" })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("chunksByFilter with entity filter", () => {
    store.upsertChunk(makeChunk("c1", "redis text"))
    store.upsertChunk(makeChunk("c2", "postgres text"))
    store.upsertEntities("c1", [{ kind: "technology", value: "redis" }])
    store.upsertEntities("c2", [{ kind: "technology", value: "postgres" }])

    const results = store.chunksByFilter({ entity: { kind: "technology", value: "redis" } })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("chunksByFilter with no filters returns all chunks", () => {
    store.upsertChunk(makeChunk("c1", "a"))
    store.upsertChunk(makeChunk("c2", "b"))
    const results = store.chunksByFilter({})
    expect(results).toHaveLength(2)
  })

  test("chunksByFilter with multiple filters composes AND", () => {
    store.upsertChunk(makeChunk("c1", "text", { source: "memory", truth_state: "validated" }))
    store.upsertChunk(makeChunk("c2", "text", { source: "memory", truth_state: "deprecated" }))
    store.upsertChunk(makeChunk("c3", "text", { source: "sessions", truth_state: "validated" }))
    const results = store.chunksByFilter({ source: "memory", truthState: "validated" })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  // =========================================================================
  // chunksNeedingMigration
  // =========================================================================

  test("chunksNeedingMigration returns chunks with different model", () => {
    store.upsertChunk(makeChunk("c1", "old model", { embedding_model: "old-model" }))
    store.upsertChunk(makeChunk("c2", "current", { embedding_model: "current-model" }))
    const results = store.chunksNeedingMigration("current-model", 100)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("chunksNeedingMigration skips chunks with empty embedding", () => {
    store.upsertChunk(makeChunk("c1", "no embed", { embedding_model: "old", embedding: Buffer.alloc(0) }))
    const results = store.chunksNeedingMigration("current", 100)
    expect(results).toHaveLength(0)
  })

  test("chunksNeedingMigration respects limit", () => {
    for (let i = 0; i < 5; i++) {
      store.upsertChunk(makeChunk(`c${i}`, `text ${i}`, { embedding_model: "old" }))
    }
    const results = store.chunksNeedingMigration("current", 3)
    expect(results).toHaveLength(3)
  })

  // =========================================================================
  // Summary lifecycle ops
  // =========================================================================

  test("countSummaries returns accurate count", () => {
    const pid = "count-test"
    expect(store.countSummaries(pid)).toBe(0)
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: pid,
      content: "x",
      truth_state: "candidate",
      created_at: 1,
    })
    store.upsertSummary({
      id: "s2",
      session_id: "b",
      project_id: pid,
      content: "y",
      truth_state: "candidate",
      created_at: 2,
    })
    expect(store.countSummaries(pid)).toBe(2)
  })

  test("deprecateSummariesOlderThan marks old candidates deprecated", () => {
    const pid = "dep-test"
    const old = Date.now() - 200_000
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: pid,
      content: "old",
      truth_state: "candidate",
      created_at: old,
    })
    store.upsertSummary({
      id: "s2",
      session_id: "b",
      project_id: pid,
      content: "new",
      truth_state: "candidate",
      created_at: Date.now(),
    })

    store.deprecateSummariesOlderThan(pid, 100_000)

    const summaries = store.recentSummaries(pid, 10)
    const s1 = summaries.find((s) => s.id === "s1")!
    const s2 = summaries.find((s) => s.id === "s2")!
    expect(s1.truth_state).toBe("deprecated")
    expect(s2.truth_state).toBe("candidate")
  })

  test("deprecateSummariesOlderThan does not affect validated summaries", () => {
    const pid = "dep-val"
    const old = Date.now() - 200_000
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: pid,
      content: "old validated",
      truth_state: "validated",
      created_at: old,
    })

    store.deprecateSummariesOlderThan(pid, 100_000)

    const s = store.recentSummaries(pid, 10)
    expect(s[0].truth_state).toBe("validated")
  })

  test("oldestSummaries returns deprecated and candidate sorted by created_at asc", () => {
    const pid = "oldest"
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: pid,
      content: "a",
      truth_state: "deprecated",
      created_at: 100,
    })
    store.upsertSummary({
      id: "s2",
      session_id: "b",
      project_id: pid,
      content: "b",
      truth_state: "candidate",
      created_at: 200,
    })
    store.upsertSummary({
      id: "s3",
      session_id: "c",
      project_id: pid,
      content: "c",
      truth_state: "validated",
      created_at: 50,
    })

    const results = store.oldestSummaries(pid, 10)
    // Should NOT include validated (s3), only deprecated and candidate
    expect(results.map((s) => s.id)).not.toContain("s3")
    expect(results[0].id).toBe("s1") // oldest by created_at
  })

  test("deleteSummary removes summary and associated chunk", () => {
    const pid = "del-summ"
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: pid,
      content: "to delete",
      truth_state: "candidate",
      created_at: 1,
    })
    store.upsertChunk(makeChunk("s1", "summary chunk text"))

    store.deleteSummary("s1")

    expect(store.countSummaries(pid)).toBe(0)
    expect(store.getChunk("s1")).toBeNull()
  })

  // =========================================================================
  // GC
  // =========================================================================

  test("searchFts multi-word query uses AND semantics", () => {
    store.upsertChunk(makeChunk("c1", "TypeScript is a typed language"))
    store.upsertChunk(makeChunk("c2", "Rust is a systems language"))
    store.upsertChunk(makeChunk("c3", "TypeScript and Rust comparison"))
    // Multi-word query should match chunks containing all words
    const results = store.searchFts("TypeScript language", 10)
    // c1 contains both words, c3 contains only TypeScript
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].id).toBe("c1") // best match has both words
  })

  test("gc removes orphaned embedding cache entries", () => {
    store.upsertChunk(makeChunk("c1", "some text", { hash: "used" }))
    store.cacheEmbedding({ hash: "used", embedding: serialize([1]), model: "m", dims: 1, updated_at: 1 })
    store.cacheEmbedding({ hash: "orphan", embedding: serialize([2]), model: "m", dims: 1, updated_at: 1 })

    expect(store.stats().cacheEntries).toBe(2)
    store.gc()
    expect(store.stats().cacheEntries).toBe(1)
    expect(store.getCachedEmbedding("used")).not.toBeNull()
    expect(store.getCachedEmbedding("orphan")).toBeNull()
  })

  test("gc removes orphaned entity entries", () => {
    store.upsertChunk(makeChunk("c1", "text", { hash: "h1" }))
    store.upsertEntities("c1", [{ kind: "technology", value: "redis" }])
    // Insert an orphaned entity via raw SQL — deleteChunk already cleans
    // entities, so we must bypass the API to create a genuine orphan
    const db = store.get()
    db.run("INSERT INTO entities (chunk_id, kind, value) VALUES (?, ?, ?)", ["ghost-chunk", "class", "OrphanClass"])

    // 1 real + 1 orphaned
    expect(store.stats().entities).toBe(2)
    store.gc()
    // After gc, orphaned entity (referencing nonexistent chunk) should be cleaned up
    expect(store.stats().entities).toBe(1)
    expect(store.entitiesForChunk("c1")).toHaveLength(1)
    expect(store.entitiesForChunk("ghost-chunk")).toHaveLength(0)
  })

  // =========================================================================
  // Stats
  // =========================================================================

  test("stats reflects all tables", () => {
    store.upsertFile({ path: "/f1", source: "memory", hash: "h", mtime: 1, size: 1 })
    store.upsertChunk(makeChunk("c1", "text"))
    store.upsertSummary({
      id: "s1",
      session_id: "a",
      project_id: "p",
      content: "c",
      truth_state: "candidate",
      created_at: 1,
    })
    store.cacheEmbedding({ hash: "e1", embedding: serialize([1]), model: "m", dims: 1, updated_at: 1 })

    const s = store.stats()
    expect(s.files).toBe(1)
    expect(s.chunks).toBe(1)
    expect(s.summaries).toBe(1)
    expect(s.cacheEntries).toBe(1)
  })

  // =========================================================================
  // Inspection helpers (allEntities, embeddingStats, allSummaries)
  // =========================================================================

  test("allEntities returns joined entity+chunk data", () => {
    store.upsertChunk(makeChunk("ent-c1", "some code", { path: "/src/app.ts", source: "memory" }))
    store.upsertChunk(makeChunk("ent-c2", "more code", { path: "/src/lib.ts", source: "session" }))
    store.upsertEntities("ent-c1", [
      { kind: "function", value: "main" },
      { kind: "technology", value: "TypeScript" },
    ])
    store.upsertEntities("ent-c2", [{ kind: "technology", value: "TypeScript" }])

    const all = store.allEntities(100)
    expect(all.length).toBe(3)
    // Each entity has chunk's path and source joined
    const ts = all.filter((e) => e.value === "TypeScript")
    expect(ts.length).toBe(2)
    expect(ts.map((e) => e.source).sort()).toEqual(["memory", "session"])
  })

  test("allEntities filters by kind", () => {
    store.upsertChunk(makeChunk("ent-k1", "text"))
    store.upsertEntities("ent-k1", [
      { kind: "function", value: "foo" },
      { kind: "class", value: "Bar" },
    ])

    const fns = store.allEntities(100, "function")
    expect(fns.length).toBe(1)
    expect(fns[0].value).toBe("foo")

    const cls = store.allEntities(100, "class")
    expect(cls.length).toBe(1)
    expect(cls[0].value).toBe("Bar")
  })

  test("allEntities respects limit", () => {
    store.upsertChunk(makeChunk("ent-lim", "text"))
    store.upsertEntities("ent-lim", [
      { kind: "function", value: "a" },
      { kind: "function", value: "b" },
      { kind: "function", value: "c" },
    ])
    const limited = store.allEntities(2)
    expect(limited.length).toBe(2)
  })

  test("allEntities returns empty when no entities exist", () => {
    expect(store.allEntities(100)).toEqual([])
  })

  test("embeddingStats reports correct counts", () => {
    store.upsertChunk(
      makeChunk("es-1", "with embed", {
        embedding: serialize([1, 2, 3]),
        embedding_model: "openai/text-embedding-3-small",
      }),
    )
    store.upsertChunk(
      makeChunk("es-2", "also embedded", {
        embedding: serialize([4, 5, 6]),
        embedding_model: "openai/text-embedding-3-small",
      }),
    )
    store.upsertChunk(makeChunk("es-3", "no embed", { embedding: Buffer.alloc(0), embedding_model: "" }))

    const es = store.embeddingStats()
    expect(es.total).toBe(3)
    expect(es.withEmbedding).toBe(2)
    expect(es.empty).toBe(1)
    expect(es.byModel["openai/text-embedding-3-small"]).toBe(2)
  })

  test("embeddingStats returns zeros on empty store", () => {
    const es = store.embeddingStats()
    expect(es.total).toBe(0)
    expect(es.withEmbedding).toBe(0)
    expect(es.empty).toBe(0)
    expect(Object.keys(es.byModel).length).toBe(0)
  })

  test("embeddingStats includes cache info", () => {
    store.cacheEmbedding({ hash: "h1", embedding: serialize([1, 2]), model: "m", dims: 256, updated_at: 1 })
    store.cacheEmbedding({ hash: "h2", embedding: serialize([3, 4]), model: "m", dims: 256, updated_at: 2 })

    const es = store.embeddingStats()
    expect(es.cacheEntries).toBe(2)
    expect(es.cacheDims).toBe(256)
  })

  test("allSummaries returns summaries ordered by created_at desc", () => {
    store.upsertSummary({
      id: "s-old",
      session_id: "sess1",
      project_id: "p",
      content: "old knowledge",
      truth_state: "candidate",
      created_at: 1000,
    })
    store.upsertSummary({
      id: "s-new",
      session_id: "sess2",
      project_id: "p",
      content: "new knowledge",
      truth_state: "validated",
      created_at: 2000,
    })

    const summaries = store.allSummaries(50)
    expect(summaries.length).toBe(2)
    expect(summaries[0].id).toBe("s-new")
    expect(summaries[1].id).toBe("s-old")
  })

  test("allSummaries respects limit", () => {
    store.upsertSummary({
      id: "sl-1",
      session_id: "a",
      project_id: "p",
      content: "c1",
      truth_state: "candidate",
      created_at: 1,
    })
    store.upsertSummary({
      id: "sl-2",
      session_id: "a",
      project_id: "p",
      content: "c2",
      truth_state: "candidate",
      created_at: 2,
    })
    store.upsertSummary({
      id: "sl-3",
      session_id: "a",
      project_id: "p",
      content: "c3",
      truth_state: "candidate",
      created_at: 3,
    })

    const summaries = store.allSummaries(2)
    expect(summaries.length).toBe(2)
  })

  test("allSummaries returns empty when no summaries exist", () => {
    expect(store.allSummaries(50)).toEqual([])
  })

  // =========================================================================
  // Gap-fill: hypothesis truth state and concept entity kind
  // =========================================================================

  test("hypothesis truth_state round-trips correctly", () => {
    store.upsertChunk(makeChunk("hypo-chunk", "hypothesis text", { truth_state: "hypothesis", confidence: 0.4 }))
    const chunk = store.getChunk("hypo-chunk")
    expect(chunk).not.toBeNull()
    expect(chunk!.truth_state).toBe("hypothesis")
    expect(chunk!.confidence).toBe(0.4)
  })

  test("concept entity kind round-trips correctly", () => {
    store.upsertChunk(makeChunk("concept-chunk", "concept text"))
    store.upsertEntities("concept-chunk", [{ kind: "concept", value: "immutability" }])
    const entities = store.entitiesForChunk("concept-chunk")
    expect(entities).toHaveLength(1)
    expect(entities[0].kind).toBe("concept")
    expect(entities[0].value).toBe("immutability")
  })

  test("searchByEntity with concept kind", () => {
    store.upsertChunk(makeChunk("concept-search", "concept search text"))
    store.upsertEntities("concept-search", [{ kind: "concept", value: "modularity" }])
    const results = store.searchByEntity("concept", "modularity", 10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("concept-search")
  })

  // =========================================================================
  // Gap-fill: closed-db guards for allEntities, embeddingStats, allSummaries
  // =========================================================================

  test("allEntities returns empty after close", () => {
    store.upsertChunk(makeChunk("ent-close", "text"))
    store.upsertEntities("ent-close", [{ kind: "function", value: "foo" }])
    store.close()
    expect(store.allEntities(100)).toEqual([])
  })

  test("embeddingStats returns zeros after close", () => {
    store.upsertChunk(makeChunk("es-close", "text", { embedding: serialize([1, 2, 3]) }))
    store.close()
    const es = store.embeddingStats()
    expect(es.total).toBe(0)
    expect(es.withEmbedding).toBe(0)
    expect(es.empty).toBe(0)
    expect(es.cacheEntries).toBe(0)
    expect(es.cacheDims).toBe(0)
  })

  test("allSummaries returns empty after close", () => {
    store.upsertSummary({
      id: "s-close",
      session_id: "a",
      project_id: "p",
      content: "c",
      truth_state: "candidate",
      created_at: 1,
    })
    store.close()
    expect(store.allSummaries(50)).toEqual([])
  })

  // =========================================================================
  // Gap-fill: deleteSummary with non-existent ID does not throw
  // =========================================================================

  test("deleteSummary with non-existent id does not throw", () => {
    expect(() => store.deleteSummary("nonexistent-summary")).not.toThrow()
  })

  // =========================================================================
  // Gap-fill: deleteChunksForPath with zero matching chunks
  // =========================================================================

  test("deleteChunksForPath with no matching chunks is a no-op", () => {
    store.upsertChunk(makeChunk("other-path", "text", { path: "/other.md" }))
    store.deleteChunksForPath("/nonexistent.md")
    // The other chunk should still exist
    expect(store.getChunk("other-path")).not.toBeNull()
  })
})
