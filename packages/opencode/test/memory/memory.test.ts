import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import * as MemoryStore from "../../src/memory/store"
import { extract } from "../../src/memory/extract"
import { resolve } from "../../src/memory/config"
import { serialize, deserialize, register, create, available } from "../../src/memory/embed"
import type { EmbeddingProvider } from "../../src/memory/embed"

function fakeProvider(dims = 4): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = new Array(dims).fill(0)
        // Simple deterministic embedding: hash the text length
        v[t.length % dims] = 1.0
        return v
      })
    },
    dimensions: () => dims,
    model: () => "fake",
  }
}

// =========================================================================
// Config
// =========================================================================

describe("memory.config.resolve", () => {
  test("returns defaults when no input", () => {
    const cfg = resolve()
    expect(cfg.enabled).toBe(true)
    expect(cfg.embedding.provider).toBe("openai")
    expect(cfg.embedding.model).toBe("text-embedding-3-small")
    expect(cfg.search.maxResults).toBe(8)
    expect(cfg.search.minScore).toBe(0.2)
    expect(cfg.search.vectorWeight).toBe(0.7)
    expect(cfg.search.textWeight).toBe(0.3)
    expect(cfg.sync.onSessionStart).toBe(true)
    expect(cfg.sync.watch).toBe(true)
    expect(cfg.injection.enabled).toBe(true)
    expect(cfg.injection.maxTokens).toBe(2000)
    expect(cfg.extraction.enabled).toBe(true)
  })

  test("merges partial overrides", () => {
    const cfg = resolve({
      enabled: false,
      embedding: { model: "custom-model" },
      search: { maxResults: 20 },
    })
    expect(cfg.enabled).toBe(false)
    expect(cfg.embedding.model).toBe("custom-model")
    expect(cfg.embedding.provider).toBe("openai") // default preserved
    expect(cfg.search.maxResults).toBe(20)
    expect(cfg.search.minScore).toBe(0.2) // default preserved
  })

  test("empty object returns defaults", () => {
    const cfg = resolve({})
    expect(cfg.enabled).toBe(true)
    expect(cfg.embedding.provider).toBe("openai")
  })

  test("paths override", () => {
    const cfg = resolve({ paths: ["/extra/notes.md"] })
    expect(cfg.paths).toEqual(["/extra/notes.md"])
  })

  test("model config is passed through", () => {
    const cfg = resolve({ model: "anthropic/claude-haiku-4-5" })
    expect(cfg.model).toBe("anthropic/claude-haiku-4-5")
  })

  test("model is undefined by default", () => {
    const cfg = resolve()
    expect(cfg.model).toBeUndefined()
  })

  test("extraction.mode defaults to llm", () => {
    const cfg = resolve()
    expect(cfg.extraction.mode).toBe("llm")
  })

  test("extraction.entityExtraction defaults to regex", () => {
    const cfg = resolve()
    expect(cfg.extraction.entityExtraction).toBe("regex")
  })

  test("extraction overrides merge correctly", () => {
    const cfg = resolve({ extraction: { mode: "title", entityExtraction: "llm" } })
    expect(cfg.extraction.mode).toBe("title")
    expect(cfg.extraction.entityExtraction).toBe("llm")
    expect(cfg.extraction.enabled).toBe(true) // default preserved
    expect(cfg.extraction.autoPromote).toBe(false) // default preserved
  })

  test("maintenance defaults", () => {
    const cfg = resolve()
    expect(cfg.maintenance.summaryTTLDays).toBe(90)
    expect(cfg.maintenance.maxSummaries).toBe(100)
    expect(cfg.maintenance.autoDeprecate).toBe(true)
    expect(cfg.maintenance.contradictionDetection).toBe(true)
    expect(cfg.maintenance.deprecatedCleanupDays).toBe(180)
  })

  test("maintenance overrides merge correctly", () => {
    const cfg = resolve({ maintenance: { summaryTTLDays: 30, maxSummaries: 50 } })
    expect(cfg.maintenance.summaryTTLDays).toBe(30)
    expect(cfg.maintenance.maxSummaries).toBe(50)
    expect(cfg.maintenance.autoDeprecate).toBe(true) // default preserved
  })

  test("ignoredEntities override", () => {
    const cfg = resolve({ extraction: { ignoredEntities: ["NikolayStoychev", "JohnDoe"] } })
    expect(cfg.extraction.ignoredEntities).toEqual(["NikolayStoychev", "JohnDoe"])
  })

  test("ignoredEntities defaults to empty array", () => {
    const cfg = resolve()
    expect(cfg.extraction.ignoredEntities).toEqual([])
  })

  test("embedding dimensions override", () => {
    const cfg = resolve({ embedding: { dimensions: 256 } })
    expect(cfg.embedding.dimensions).toBe(256)
    expect(cfg.embedding.provider).toBe("openai") // default preserved
  })

  test("embedding dimensions is undefined by default", () => {
    const cfg = resolve()
    expect(cfg.embedding.dimensions).toBeUndefined()
  })

  test("sync.onSearch override", () => {
    const cfg = resolve({ sync: { onSearch: false } })
    expect(cfg.sync.onSearch).toBe(false)
    expect(cfg.sync.onSessionStart).toBe(true) // default preserved
  })
})

// =========================================================================
// Embed registry
// =========================================================================

describe("memory.embed registry", () => {
  test("register and create round-trip", () => {
    register("test-provider", () => fakeProvider())
    const p = create("test-provider")
    expect(p.model()).toBe("fake")
    expect(p.dimensions()).toBe(4)
  })

  test("create throws for unknown provider", () => {
    expect(() => create("nonexistent-provider-xyz")).toThrow()
  })

  test("available lists registered providers", () => {
    register("list-test", () => fakeProvider())
    expect(available()).toContain("list-test")
  })

  test("config is passed to factory", () => {
    register("config-test", (cfg) => {
      const model = (cfg?.model as string) ?? "default"
      return {
        async embed(texts: string[]) {
          return texts.map(() => [1])
        },
        dimensions: () => 1,
        model: () => model,
      }
    })
    const p = create("config-test", { model: "custom" })
    expect(p.model()).toBe("custom")
  })
})

// =========================================================================
// Extract
// =========================================================================

describe("memory.extract", () => {
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(() => {
    store = MemoryStore.create(`extract-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()
  })

  afterEach(() => {
    store.close()
  })

  test("extracts and stores a session summary", async () => {
    const result = await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "Learned that the project uses TypeScript with Bun runtime.",
      mode: "title",
      entityMode: "regex",
    })
    expect(result).toBe(true)
    expect(store.stats().summaries).toBe(1)
    expect(store.stats().chunks).toBe(1)
  })

  test("stores summary with candidate truth state", async () => {
    await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "Architecture uses SQLite for persistence.",
      mode: "title",
      entityMode: "regex",
    })
    const summaries = store.recentSummaries("p1", 10)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].truth_state).toBe("candidate")
    expect(summaries[0].content).toContain("SQLite")
  })

  test("chunk is FTS-searchable after extraction", async () => {
    await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "Redis is used for caching in production.",
      mode: "title",
      entityMode: "regex",
    })
    const results = store.searchFts("Redis", 10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("summary:s1")
    // Also verify non-matching query returns empty
    expect(store.searchFts("PostgreSQL", 10)).toHaveLength(0)
  })

  test("caches the embedding after extraction", async () => {
    await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "Short summary here",
      mode: "title",
      entityMode: "regex",
    })
    // Exactly 1 chunk → exactly 1 cache entry
    expect(store.stats().cacheEntries).toBe(1)
    // Verify the cached embedding belongs to the chunk's hash
    const chunk = store.getChunk("summary:s1")!
    const cached = store.getCachedEmbedding(chunk.hash)
    expect(cached).not.toBeNull()
    expect(cached!.model).toBe("fake")
  })

  test("returns false for empty summary", async () => {
    const result = await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "",
      mode: "title",
      entityMode: "regex",
    })
    expect(result).toBe(false)
    expect(store.stats().summaries).toBe(0)
  })

  test("returns false for NONE summary", async () => {
    const result = await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "NONE",
      mode: "title",
      entityMode: "regex",
    })
    expect(result).toBe(false)
  })

  test("returns false for whitespace-only summary", async () => {
    const result = await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "   \n  ",
      mode: "title",
      entityMode: "regex",
    })
    expect(result).toBe(false)
  })

  test("chunk path includes session ID", async () => {
    await extract({
      store,
      provider,
      sessionID: "sess-abc",
      projectID: "p1",
      summary: "Test knowledge",
      mode: "title",
      entityMode: "regex",
    })
    const chunks = store.allChunks()
    expect(chunks).toHaveLength(1)
    expect(chunks[0].path).toContain("sess-abc")
  })

  test("chunk source is 'sessions'", async () => {
    await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "Test knowledge",
      mode: "title",
      entityMode: "regex",
    })
    const chunks = store.chunksBySource("sessions")
    expect(chunks).toHaveLength(1)
  })

  test("idempotent re-extraction does not duplicate", async () => {
    const params = {
      store,
      provider,
      sessionID: "s-idem",
      projectID: "p1",
      summary: "Idempotent extraction test",
      mode: "title" as const,
      entityMode: "regex" as const,
    }
    await extract(params)
    await extract(params)
    // Should have exactly 1 summary and 1 chunk, not 2
    expect(store.stats().summaries).toBe(1)
    expect(store.stats().chunks).toBe(1)
    const summaries = store.recentSummaries("p1", 10)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].id).toBe("summary:s-idem")
  })

  test("LLM mode uses generate function for extraction", async () => {
    let called = false
    const generate = async (prompt: string): Promise<string> => {
      called = true
      expect(prompt).toContain("knowledge extraction system")
      return "- The project uses Bun as its runtime\n- SQLite is used for persistence"
    }

    const result = await extract({
      store,
      provider,
      sessionID: "s-llm",
      projectID: "p1",
      summary: "We discussed using Bun and SQLite.",
      mode: "llm",
      entityMode: "regex",
      generate,
    })
    expect(result).toBe(true)
    expect(called).toBe(true)
    // The stored content should be from the LLM response, not the raw summary
    const summaries = store.recentSummaries("p1", 10)
    expect(summaries[0].content).toContain("Bun")
    expect(summaries[0].content).toContain("SQLite")
  })

  test("LLM mode falls back to raw summary on generate error", async () => {
    const generate = async (_prompt: string): Promise<string> => {
      throw new Error("API error")
    }

    const result = await extract({
      store,
      provider,
      sessionID: "s-llm-fail",
      projectID: "p1",
      summary: "Raw summary about Redis caching.",
      mode: "llm",
      entityMode: "regex",
      generate,
    })
    expect(result).toBe(true)
    const summaries = store.recentSummaries("p1", 10)
    expect(summaries[0].content).toContain("Redis")
  })

  test("LLM mode falls back to raw summary when generate returns NONE", async () => {
    const generate = async (_prompt: string): Promise<string> => "NONE"

    const result = await extract({
      store,
      provider,
      sessionID: "s-none",
      projectID: "p1",
      summary: "Trivial session.",
      mode: "llm",
      entityMode: "regex",
      generate,
    })
    // When LLM returns "NONE", it falls back to the raw summary.
    // Since the raw summary is not empty/NONE, extraction succeeds.
    expect(result).toBe(true)
    const summaries = store.recentSummaries("p1", 10)
    expect(summaries[0].content).toBe("Trivial session.")
  })

  test("returns false when both LLM and summary are NONE", async () => {
    const generate = async (_prompt: string): Promise<string> => "NONE"

    const result = await extract({
      store,
      provider,
      sessionID: "s-both-none",
      projectID: "p1",
      summary: "NONE",
      mode: "llm",
      entityMode: "regex",
      generate,
    })
    expect(result).toBe(false)
  })

  test("embedding failure still stores summary (catch path)", async () => {
    // Create a provider that fails to embed
    const failProvider: EmbeddingProvider = {
      async embed(_texts: string[]): Promise<number[][]> {
        throw new Error("embedding API unavailable")
      },
      dimensions: () => 4,
      model: () => "fail-model",
    }

    const result = await extract({
      store,
      provider: failProvider,
      sessionID: "s-emb-fail",
      projectID: "p1",
      summary: "Knowledge despite embedding failure.",
      mode: "title",
      entityMode: "regex",
    })
    // Extraction should still succeed (summary is stored)
    expect(result).toBe(true)
    // Summary is stored even if embedding fails
    expect(store.stats().summaries).toBe(1)
    const summaries = store.recentSummaries("p1", 10)
    expect(summaries[0].content).toContain("embedding failure")
    // Chunk is NOT stored when embedding fails — the try/catch in extract.ts
    // wraps the entire chunk creation (embedding + upsert), so the chunk
    // is skipped when the provider throws
    expect(store.getChunk("summary:s-emb-fail")).toBeNull()
    expect(store.stats().chunks).toBe(0)
    // No cache entry since embedding failed
    expect(store.stats().cacheEntries).toBe(0)
  })

  test("ignoredEntities parameter excludes matching entities", async () => {
    const ignored = new Set(["nikolaystoychev"])

    await extract({
      store,
      provider,
      sessionID: "s-ignored",
      projectID: "p1",
      summary: "NikolayStoychev worked on typescript with AuthService.",
      mode: "title",
      entityMode: "regex",
      ignoredEntities: ignored,
    })
    const entities = store.entitiesForChunk("summary:s-ignored")
    // "NikolayStoychev" should be filtered by ignoredEntities
    const values = entities.map((e) => e.value.toLowerCase())
    expect(values).not.toContain("nikolaystoychev")
    // "typescript" should still be present
    expect(entities.some((e) => e.value === "typescript")).toBe(true)
  })

  test("extracts and stores entities with chunk", async () => {
    await extract({
      store,
      provider,
      sessionID: "s-ent",
      projectID: "p1",
      summary: "We use typescript with react, modified src/auth/handler.ts for AuthService.",
      mode: "title",
      entityMode: "regex",
    })
    const entities = store.entitiesForChunk("summary:s-ent")
    // Should have entity tags from regex extraction:
    // typescript, react (technology), src/auth/handler.ts (path), AuthService (class) = 4
    expect(entities.length).toBe(4)
    const kinds = entities.map((e) => e.kind)
    const values = entities.map((e) => e.value)
    expect(kinds).toContain("technology")
    expect(kinds).toContain("path")
    expect(kinds).toContain("class")
    expect(values).toContain("typescript")
    expect(values).toContain("react") // comma-separated so split works
    expect(values.some((v) => v.includes("src/auth/handler.ts"))).toBe(true)
    expect(values).toContain("AuthService")
  })

  test("chunk has correct embedding_model set", async () => {
    await extract({
      store,
      provider,
      sessionID: "s-model",
      projectID: "p1",
      summary: "Test embedding model tracking",
      mode: "title",
      entityMode: "regex",
    })
    const chunk = store.getChunk("summary:s-model")!
    expect(chunk.embedding_model).toBe("fake")
  })
})

// =========================================================================
// Integration: Store + Search + Extract pipeline
// =========================================================================

describe("memory integration: store + extract + search", () => {
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(() => {
    store = MemoryStore.create(`integ-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider(8)
  })

  afterEach(() => {
    store.close()
  })

  test("extracted knowledge is findable via FTS", async () => {
    await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "The codebase uses PostgreSQL for the main database.",
      mode: "title",
      entityMode: "regex",
    })
    await extract({
      store,
      provider,
      sessionID: "s2",
      projectID: "p1",
      summary: "API endpoints follow REST conventions with JSON payloads.",
      mode: "title",
      entityMode: "regex",
    })

    const pgResults = store.searchFts("PostgreSQL", 10)
    expect(pgResults.length).toBeGreaterThan(0)

    const restResults = store.searchFts("REST", 10)
    expect(restResults.length).toBeGreaterThan(0)
  })

  test("gc preserves chunks with matching cache entries", async () => {
    await extract({
      store,
      provider,
      sessionID: "s1",
      projectID: "p1",
      summary: "Important knowledge",
      mode: "title",
      entityMode: "regex",
    })

    const before = store.stats()
    store.gc()
    const after = store.stats()

    // Chunks and cache should be preserved
    expect(after.chunks).toBe(before.chunks)
    expect(after.cacheEntries).toBe(before.cacheEntries)
  })

  test("multiple extractions create distinct summaries", async () => {
    for (let i = 0; i < 3; i++) {
      await extract({
        store,
        provider,
        sessionID: `s${i}`,
        projectID: "p1",
        summary: `Knowledge entry number ${i}`,
        mode: "title",
        entityMode: "regex",
      })
    }
    expect(store.stats().summaries).toBe(3)
    expect(store.stats().chunks).toBe(3)
    expect(store.recentSummaries("p1", 10)).toHaveLength(3)
  })
})
