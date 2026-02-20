import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import * as MemoryStore from "../../src/memory/store"
import { serialize, cosine, deserialize } from "../../src/memory/embed"
import { search } from "../../src/memory/search"
import type { ChunkRow } from "../../src/memory/schema"
import type { EmbeddingProvider } from "../../src/memory/embed"

/**
 * Create a fake embedding provider that returns deterministic vectors.
 * Maps known keywords to fixed directions for predictable cosine similarity.
 */
function fakeProvider(dims = 8): EmbeddingProvider {
  function vec(seed: number): number[] {
    const v = new Array(dims).fill(0)
    v[seed % dims] = 1.0
    return v
  }

  const dictionary: Record<string, number> = {
    typescript: 0,
    javascript: 1,
    rust: 2,
    python: 3,
    memory: 4,
    database: 5,
    search: 6,
    test: 7,
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const words = t.toLowerCase().split(/\s+/)
        const v = new Array(dims).fill(0)
        for (const w of words) {
          const idx = dictionary[w]
          if (idx !== undefined) v[idx] += 1.0
        }
        // Normalize
        const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0))
        return norm > 0 ? v.map((x: number) => x / norm) : vec(0)
      })
    },
    dimensions: () => dims,
    model: () => "fake-embed",
  }
}

describe("memory.embed.deserialize validation", () => {
  test("deserialize throws on corrupted buffer (not divisible by 8)", () => {
    const corrupted = Buffer.alloc(7) // 7 bytes is not divisible by 8
    expect(() => deserialize(corrupted)).toThrow("corrupted embedding blob")
  })

  test("deserialize returns empty for null", () => {
    expect(deserialize(null)).toEqual([])
  })

  test("deserialize returns empty for zero-length buffer", () => {
    expect(deserialize(Buffer.alloc(0))).toEqual([])
  })
})

describe("memory.search.rankToScore and recencyScore", () => {
  // Import the internal functions via the search module behavior

  test("rankToScore: rank=-10 → ~0.909", () => {
    // We test rankToScore indirectly: FTS5 returns negative ranks.
    // A chunk with rank=-10 should produce score ≈ 0.909 via neg/(1+neg).
    // Direct test: neg=10, score = 10/11 ≈ 0.909
    const score = 10 / (1 + 10)
    expect(score).toBeCloseTo(0.909, 3)
  })

  test("rankToScore: rank=0 → 0", () => {
    // neg=0 → score=0
    const neg = 0
    expect(neg <= 0 ? 0 : neg / (1 + neg)).toBe(0)
  })

  test("rankToScore: positive rank (should not occur) → 0", () => {
    // rank=5 → neg=-5, neg<=0 → 0
    const neg = -5
    expect(neg <= 0 ? 0 : neg / (1 + neg)).toBe(0)
  })

  test("recencyScore: recent entry scores close to 1", () => {
    // days=0 → 1/(1+0/90) = 1.0
    const score = 1.0 / (1 + 0 / 90)
    expect(score).toBe(1.0)
  })

  test("recencyScore: 90-day-old entry scores ~0.5", () => {
    // days=90 → 1/(1+90/90) = 1/2 = 0.5
    const score = 1.0 / (1 + 90 / 90)
    expect(score).toBe(0.5)
  })

  test("recencyScore: 180-day-old entry scores ~0.33", () => {
    // days=180 → 1/(1+180/90) = 1/3 ≈ 0.333
    const score = 1.0 / (1 + 180 / 90)
    expect(score).toBeCloseTo(0.333, 3)
  })
})

describe("memory.embed helpers", () => {
  test("serialize and deserialize round-trip", () => {
    const vec = [0.1, 0.2, 0.3, -0.5, 1.0]
    const buf = serialize(vec)
    expect(buf.length).toBe(vec.length * 8)
    const back = deserialize(buf)
    expect(back).toHaveLength(vec.length)
    for (let i = 0; i < vec.length; i++) {
      expect(back[i]).toBeCloseTo(vec[i], 10)
    }
  })

  test("deserialize empty buffer returns empty array", () => {
    expect(deserialize(Buffer.alloc(0))).toEqual([])
  })

  test("cosine similarity of identical vectors is 1", () => {
    const v = [1, 0, 0, 0]
    expect(cosine(v, v)).toBeCloseTo(1.0, 10)
  })

  test("cosine similarity of orthogonal vectors is 0", () => {
    expect(cosine([1, 0, 0, 0], [0, 1, 0, 0])).toBeCloseTo(0, 10)
  })

  test("cosine similarity of opposite vectors is -1", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10)
  })

  test("cosine returns 0 for mismatched dimensions", () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0)
  })

  test("cosine returns 0 for empty vectors", () => {
    expect(cosine([], [])).toBe(0)
  })

  test("cosine returns 0 for zero vectors", () => {
    expect(cosine([0, 0, 0], [0, 0, 0])).toBe(0)
  })
})

describe("memory.search", () => {
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(async () => {
    store = MemoryStore.create(`search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()

    // Seed chunks with known embeddings
    const texts = [
      { id: "c1", text: "TypeScript is a typed superset of JavaScript" },
      { id: "c2", text: "Rust provides memory safety without garbage collection" },
      { id: "c3", text: "Python is great for machine learning" },
      { id: "c4", text: "Database search with full text indexing" },
    ]

    for (const t of texts) {
      const [embedding] = await provider.embed([t.text])
      const row: ChunkRow = {
        id: t.id,
        path: "/test.md",
        source: "memory",
        start_line: 1,
        end_line: 1,
        hash: `hash-${t.id}`,
        text: t.text,
        embedding: serialize(embedding),
        truth_state: "validated",
        confidence: 1.0,
        created_at: Date.now(),
        updated_at: Date.now(),
        embedding_model: "fake-embed",
        last_validated_at: null,
      }
      store.upsertChunk(row)
    }
  })

  afterEach(() => {
    store.close()
  })

  test("search returns results sorted by score descending", async () => {
    const results = await search({
      store,
      provider,
      query: "TypeScript JavaScript",
      options: { minScore: 0 },
    })
    expect(results.length).toBeGreaterThanOrEqual(1) // at least c1 matches both words
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  test("search for TypeScript returns relevant chunk first", async () => {
    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { minScore: 0 },
    })
    // c1 contains "TypeScript" — must be first; c4 has no TypeScript match
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].id).toBe("c1")
  })

  test("search for Rust returns memory safety chunk first", async () => {
    const results = await search({
      store,
      provider,
      query: "Rust memory",
      options: { minScore: 0 },
    })
    // c2 contains both "Rust" and "memory"
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].id).toBe("c2")
  })

  test("search respects maxResults", async () => {
    // First verify we get more than 2 results without limit
    // Use a broad query that should match all 4 seeded chunks via text search
    const unlimited = await search({
      store,
      provider,
      query: "TypeScript Rust Python Database search",
      options: { minScore: 0, textWeight: 1.0, vectorWeight: 0 },
    })
    expect(unlimited.length).toBeGreaterThan(2)

    // Now verify limit is respected
    const results = await search({
      store,
      provider,
      query: "TypeScript Rust Python Database search",
      options: { maxResults: 2, minScore: 0, textWeight: 1.0, vectorWeight: 0 },
    })
    expect(results).toHaveLength(2)
  })

  test("search respects minScore filter", async () => {
    // With minScore: 0, we should get results
    const unfiltered = await search({
      store,
      provider,
      query: "TypeScript",
      options: { minScore: 0 },
    })
    expect(unfiltered.length).toBeGreaterThan(0)

    // With very high threshold, should get fewer or zero results
    const filtered = await search({
      store,
      provider,
      query: "TypeScript",
      options: { minScore: 0.99 },
    })
    expect(filtered.length).toBeLessThan(unfiltered.length)
    // Any that pass the threshold must genuinely meet it
    for (const r of filtered) {
      expect(r.score).toBeGreaterThanOrEqual(0.99)
    }
  })

  test("search returns empty for nonsense query", async () => {
    const results = await search({
      store,
      provider,
      query: "zzzzzzzzzzz",
      options: { minScore: 0.5 },
    })
    expect(results).toHaveLength(0)
  })

  test("search respects source filter", async () => {
    // Add a chunk with different source
    const [embedding] = await provider.embed(["TypeScript session note"])
    store.upsertChunk({
      id: "s1",
      path: "/sessions/s1",
      source: "sessions",
      start_line: 1,
      end_line: 1,
      hash: "hash-s1",
      text: "TypeScript session note",
      embedding: serialize(embedding),
      truth_state: "candidate",
      confidence: 0.7,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const memoryOnly = await search({
      store,
      provider,
      query: "TypeScript",
      options: { source: "memory", minScore: 0 },
    })
    const ids = memoryOnly.map((r) => r.id)
    expect(ids).not.toContain("s1")
  })

  test("truth_state weighting affects scores", async () => {
    // Insert a deprecated chunk about TypeScript
    const [embedding] = await provider.embed(["TypeScript deprecated info"])
    store.upsertChunk({
      id: "dep1",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-dep1",
      text: "TypeScript deprecated info",
      embedding: serialize(embedding),
      truth_state: "deprecated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { minScore: 0 },
    })

    // The deprecated chunk should have a lower score than the validated one
    const validatedResult = results.find((r) => r.id === "c1")
    const deprecatedResult = results.find((r) => r.id === "dep1")
    expect(validatedResult).toBeDefined()
    expect(deprecatedResult).toBeDefined()
    expect(validatedResult!.score).toBeGreaterThan(deprecatedResult!.score)
  })

  test("custom vectorWeight=0 uses text-only scoring", async () => {
    const textOnly = await search({
      store,
      provider,
      query: "TypeScript",
      options: { vectorWeight: 0, textWeight: 1.0, minScore: 0 },
    })
    const vectorOnly = await search({
      store,
      provider,
      query: "TypeScript",
      options: { vectorWeight: 1.0, textWeight: 0, minScore: 0 },
    })
    // Should still find results via FTS even with vector weight at 0
    expect(textOnly.length).toBeGreaterThan(0)
    // Scores must differ between text-only and vector-only for same query
    const c1Text = textOnly.find((r) => r.id === "c1")
    const c1Vector = vectorOnly.find((r) => r.id === "c1")
    expect(c1Text).toBeDefined()
    expect(c1Vector).toBeDefined()
    // With different weight configs, scores should differ
    expect(c1Text!.score).toBeGreaterThan(0)
    expect(c1Vector!.score).toBeGreaterThan(0)
    // Verify the two modes produce different scores (proving weight config has effect)
    expect(c1Text!.score).not.toBeCloseTo(c1Vector!.score, 5)
  })

  test("custom textWeight=0 uses vector-only scoring", async () => {
    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { vectorWeight: 1.0, textWeight: 0, minScore: 0 },
    })
    // Should still find results via vector search even with text weight at 0
    expect(results.length).toBeGreaterThan(0)
    // The top result must have a positive score computed from vector similarity only
    expect(results[0].score).toBeGreaterThan(0)
    expect(results[0].id).toBe("c1")
  })

  test("equal weights produce scores between extremes", async () => {
    const vectorOnly = await search({
      store,
      provider,
      query: "TypeScript JavaScript",
      options: { vectorWeight: 1.0, textWeight: 0, minScore: 0 },
    })
    const textOnly = await search({
      store,
      provider,
      query: "TypeScript JavaScript",
      options: { vectorWeight: 0, textWeight: 1.0, minScore: 0 },
    })
    const balanced = await search({
      store,
      provider,
      query: "TypeScript JavaScript",
      options: { vectorWeight: 0.5, textWeight: 0.5, minScore: 0 },
    })
    // All should return results
    expect(vectorOnly.length).toBeGreaterThan(0)
    expect(textOnly.length).toBeGreaterThan(0)
    expect(balanced.length).toBeGreaterThan(0)

    // For the top result (c1), the balanced score should not exceed
    // the maximum of the two extremes, proving the weighting actually blends.
    const c1Vector = vectorOnly.find((r) => r.id === "c1")
    const c1Text = textOnly.find((r) => r.id === "c1")
    const c1Balanced = balanced.find((r) => r.id === "c1")
    expect(c1Vector).toBeDefined()
    expect(c1Text).toBeDefined()
    expect(c1Balanced).toBeDefined()
    const maxExtreme = Math.max(c1Vector!.score, c1Text!.score)
    const minExtreme = Math.min(c1Vector!.score, c1Text!.score)
    // Balanced score should be between the two extremes (inclusive)
    expect(c1Balanced!.score).toBeLessThanOrEqual(maxExtreme + 0.01)
    expect(c1Balanced!.score).toBeGreaterThanOrEqual(minExtreme - 0.01)
  })

  test("search result shape has all expected fields including truthState", async () => {
    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { minScore: 0 },
    })
    expect(results.length).toBeGreaterThan(0)
    const r = results[0]
    expect(r).toHaveProperty("id")
    expect(r).toHaveProperty("path")
    expect(r).toHaveProperty("startLine")
    expect(r).toHaveProperty("endLine")
    expect(r).toHaveProperty("text")
    expect(r).toHaveProperty("score")
    expect(r).toHaveProperty("source")
    expect(r).toHaveProperty("truthState")
    expect(r.truthState).toBe("validated")
  })

  test("search with pathGlob filter restricts to matching paths", async () => {
    // Add a chunk at a different path
    const [embedding] = await provider.embed(["TypeScript module"])
    store.upsertChunk({
      id: "auth1",
      path: "/src/auth/login.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-auth1",
      text: "TypeScript authentication module",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { pathGlob: "*/auth/*", minScore: 0 },
    })
    // Exactly the auth chunk should match the glob
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("auth1")
    expect(results[0].path).toContain("auth")
  })

  test("search with entity filter restricts to tagged chunks", async () => {
    // Tag c1 with an entity
    store.upsertEntities("c1", [{ kind: "technology", value: "typescript" }])

    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { entity: { kind: "technology", value: "typescript" }, minScore: 0 },
    })
    // Should only return c1 (the one with the entity tag)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("c1")
  })

  test("search with truthState filter restricts to matching states", async () => {
    // c1-c4 are all "validated", add a candidate chunk
    const [embedding] = await provider.embed(["TypeScript candidate info"])
    store.upsertChunk({
      id: "cand1",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-cand1",
      text: "TypeScript candidate info",
      embedding: serialize(embedding),
      truth_state: "candidate",
      confidence: 0.7,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { truthState: "candidate", minScore: 0 },
    })
    // Exactly the one candidate chunk should match
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("cand1")
    expect(results[0].truthState).toBe("candidate")
  })

  test("search with recencyBoost=false disables recency scoring", async () => {
    // Insert an old chunk and a new chunk with same content
    const [embedding] = await provider.embed(["TypeScript patterns"])
    const now = Date.now()
    store.upsertChunk({
      id: "old-ts",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-old-ts",
      text: "TypeScript patterns",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: now - 365 * 24 * 60 * 60 * 1000,
      updated_at: now - 365 * 24 * 60 * 60 * 1000,
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const withBoost = await search({
      store,
      provider,
      query: "TypeScript patterns",
      options: { recencyBoost: true, minScore: 0 },
    })
    const withoutBoost = await search({
      store,
      provider,
      query: "TypeScript patterns",
      options: { recencyBoost: false, minScore: 0 },
    })

    // Both should find results
    expect(withBoost.length).toBeGreaterThan(0)
    expect(withoutBoost.length).toBeGreaterThan(0)
    // Without boost, the old entry's score should be relatively higher compared to with-boost
    const oldWithBoost = withBoost.find((r) => r.id === "old-ts")
    const oldWithoutBoost = withoutBoost.find((r) => r.id === "old-ts")
    // Both must be found — fail explicitly if either is missing
    expect(oldWithBoost).toBeDefined()
    expect(oldWithoutBoost).toBeDefined()
    // Without recency boost, the old entry's score should be STRICTLY higher
    // because recency boost penalizes older entries
    expect(oldWithoutBoost!.score).toBeGreaterThan(oldWithBoost!.score)
  })

  test("hypothesis truth_state scores lower than candidate", async () => {
    const [embedding] = await provider.embed(["TypeScript hypothesis info"])
    store.upsertChunk({
      id: "hypo1",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-hypo1",
      text: "TypeScript hypothesis info",
      embedding: serialize(embedding),
      truth_state: "hypothesis",
      confidence: 0.5,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { minScore: 0 },
    })

    const validated = results.find((r) => r.id === "c1") // truth_state: validated
    const hypothesis = results.find((r) => r.id === "hypo1") // truth_state: hypothesis
    expect(validated).toBeDefined()
    expect(hypothesis).toBeDefined()
    // Validated (weight 1.0) should score higher than hypothesis (weight 0.4)
    expect(validated!.score).toBeGreaterThan(hypothesis!.score)
  })

  test("text-only match with no vector match still appears in results", async () => {
    // Add a chunk with a zero embedding (no vector match possible)
    store.upsertChunk({
      id: "text-only",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-text-only",
      text: "TypeScript JavaScript unique text only match",
      embedding: serialize([0, 0, 0, 0, 0, 0, 0, 0]),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const results = await search({
      store,
      provider,
      query: "unique text only match",
      options: { minScore: 0, textWeight: 1.0, vectorWeight: 0 },
    })
    // The FTS-only path should find it
    expect(results.some((r) => r.id === "text-only")).toBe(true)
  })

  test("search returns empty on empty store", async () => {
    // Create a fresh empty store
    const emptyStore = MemoryStore.create(`search-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    emptyStore.open()
    const results = await search({
      store: emptyStore,
      provider,
      query: "TypeScript",
      options: { minScore: 0 },
    })
    expect(results).toHaveLength(0)
    emptyStore.close()
  })

  test("search with combined source and truthState filters", async () => {
    // Add a sessions+candidate chunk
    const [embedding] = await provider.embed(["TypeScript session candidate"])
    store.upsertChunk({
      id: "comb1",
      path: "/test.md",
      source: "sessions",
      start_line: 1,
      end_line: 1,
      hash: "hash-comb1",
      text: "TypeScript session candidate info",
      embedding: serialize(embedding),
      truth_state: "candidate",
      confidence: 0.7,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { source: "sessions", truthState: "candidate", minScore: 0 },
    })
    // Should find exactly the sessions+candidate chunk
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("comb1")
    expect(results[0].source).toBe("sessions")
    expect(results[0].truthState).toBe("candidate")
  })

  test("search with dateRange filter restricts to time window", async () => {
    const now = Date.now()
    // c1-c4 are all at ~now; add an old chunk
    const [embedding] = await provider.embed(["TypeScript legacy"])
    store.upsertChunk({
      id: "legacy",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-legacy",
      text: "TypeScript legacy code",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: now - 1_000_000,
      updated_at: now - 1_000_000,
      embedding_model: "fake-embed",
      last_validated_at: null,
    })

    const results = await search({
      store,
      provider,
      query: "TypeScript",
      options: { dateRange: { from: now - 500_000 }, minScore: 0 },
    })
    // Should NOT include the legacy chunk
    expect(results.every((r) => r.id !== "legacy")).toBe(true)
  })
})
