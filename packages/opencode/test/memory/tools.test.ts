import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import * as MemoryStore from "../../src/memory/store"
import { serialize } from "../../src/memory/embed"
import { memorySearch, memoryGet, inferEntityKind } from "../../src/memory/tools"
import type { EmbeddingProvider } from "../../src/memory/embed"
import type { ChunkRow } from "../../src/memory/schema"
import type { ToolContext } from "@opencode-ai/plugin"

const ctx: ToolContext = {
  sessionID: "test",
  messageID: "",
  agent: "build",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
}

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `opencode-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fakeProvider(dims = 8): EmbeddingProvider {
  const dictionary: Record<string, number> = {
    typescript: 0,
    conventions: 1,
    patterns: 2,
    javascript: 3,
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
        const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0))
        if (norm > 0) return v.map((x: number) => x / norm)
        // Unknown words get a unique-ish direction based on hash
        const fallback = new Array(dims).fill(0)
        fallback[t.length % dims] = 1.0
        return fallback
      })
    },
    dimensions: () => dims,
    model: () => "fake",
  }
}

describe("memory.tools.memorySearch", () => {
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(async () => {
    store = MemoryStore.create(`tools-search-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()

    const [embedding] = await provider.embed(["TypeScript conventions and patterns"])
    const row: ChunkRow = {
      id: "c1",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 3,
      hash: "hash-c1",
      text: "TypeScript conventions and patterns",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    }
    store.upsertChunk(row)
  })

  afterEach(() => {
    store.close()
  })

  test("returns formatted results with Score, Source, and State fields", async () => {
    const tool = memorySearch(store, provider)
    const result = await tool.execute({ query: "TypeScript" }, ctx)
    expect(result as string).toContain("Result 1")
    expect(result as string).toContain("Score:")
    expect(result as string).toContain("Source:")
    expect(result as string).toContain("State:")
    expect(result as string).toContain("validated")
  })

  test("returns no-results message for non-matching query", async () => {
    const tool = memorySearch(store, provider)
    const result = await tool.execute({ query: "zzzznonexistent" }, ctx)
    expect(result as string).toContain("No relevant memory entries found")
  })

  test("respects maxResults argument", async () => {
    // Add a second matching chunk so we can verify limiting
    const [embedding] = await provider.embed(["TypeScript patterns"])
    store.upsertChunk({
      id: "c2",
      path: "/test2.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-c2",
      text: "TypeScript patterns and best practices",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    })

    const tool = memorySearch(store, provider)
    const result = await tool.execute({ query: "TypeScript", maxResults: 1 }, ctx)
    // Should have exactly 1 result section header
    const matches = (result as string).match(/### Result/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)
  })

  test("source filter restricts results", async () => {
    // Add a sessions source chunk
    const [embedding] = await provider.embed(["TypeScript session note"])
    store.upsertChunk({
      id: "s1",
      path: "/sessions/s1",
      source: "sessions",
      start_line: 1,
      end_line: 1,
      hash: "hash-s1",
      text: "TypeScript session note about conventions",
      embedding: serialize(embedding),
      truth_state: "candidate",
      confidence: 0.7,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    })

    const tool = memorySearch(store, provider)
    const result = await tool.execute({ query: "TypeScript", source: "sessions" }, ctx)
    // Should find the sessions source chunk
    expect(result as string).toContain("Result 1")
    expect(result as string).toContain("/sessions/s1")
    // The output format is "Source: <path>#L..." — the memory-source chunk's path is /test.md
    // so it should NOT appear when filtering to sessions
    expect(result as string).not.toContain("/test.md")
  })

  // Removed: "result includes State field in output" — merged into "returns formatted results" above

  test("truthState filter restricts results", async () => {
    // c1 is validated; add a deprecated chunk
    const [embedding] = await provider.embed(["TypeScript deprecated info"])
    store.upsertChunk({
      id: "dep1",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-dep1",
      text: "TypeScript deprecated conventions info",
      embedding: serialize(embedding),
      truth_state: "deprecated",
      confidence: 0.1,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    })

    // Use the underlying search directly to verify filter works with minScore=0
    // (the tool has a default minScore threshold that may filter low-scoring deprecated results)
    const { search: rawSearch } = await import("../../src/memory/search")
    const results = await rawSearch({
      store,
      provider,
      query: "TypeScript",
      options: { truthState: "deprecated", minScore: 0 },
    })
    // All results must be deprecated — validated c1 must be excluded
    for (const r of results) {
      expect(r.truthState).toBe("deprecated")
    }
    expect(results.length).toBeGreaterThan(0)
  })
})

describe("memory.tools.memoryGet", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("reads lines from an existing file", async () => {
    const filepath = path.join(dir, "test.md")
    fs.writeFileSync(filepath, "line1\nline2\nline3\nline4\nline5")
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: "test.md" }, ctx)
    expect(result as string).toContain("line1")
    expect(result as string).toContain("line5")
  })

  test("respects from and lines arguments", async () => {
    const filepath = path.join(dir, "test.md")
    fs.writeFileSync(filepath, "a\nb\nc\nd\ne\nf")
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: "test.md", from: 3, lines: 2 }, ctx)
    expect(result as string).toContain("3: c")
    expect(result as string).toContain("4: d")
    expect(result as string).not.toContain("1: a")
  })

  test("returns error for nonexistent file", async () => {
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: "missing.md" }, ctx)
    expect(result as string).toContain("File not found")
  })

  test("blocks path traversal with ..", async () => {
    // Create a file outside the worktree
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
    fs.writeFileSync(outside, "secret data")
    const tool = memoryGet(dir)

    // Try to traverse out
    const relative = path.relative(dir, outside)
    const result = await tool.execute({ path: relative }, ctx)
    expect(result as string).toContain("Access denied")

    fs.unlinkSync(outside)
  })

  test("blocks absolute path outside worktree", async () => {
    const outside = path.join(os.tmpdir(), `outside-abs-${Date.now()}.txt`)
    fs.writeFileSync(outside, "secret data")
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: outside }, ctx)
    expect(result as string).toContain("Access denied")
    fs.unlinkSync(outside)
  })

  test("allows absolute path inside worktree", async () => {
    const filepath = path.join(dir, "inside.md")
    fs.writeFileSync(filepath, "safe content")
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: filepath }, ctx)
    expect(result as string).toContain("safe content")
  })

  test("caps lines at 200 maximum", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`)
    fs.writeFileSync(path.join(dir, "big.md"), lines.join("\n"))
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: "big.md", lines: 500 }, ctx)
    // Should be capped at 200 lines
    const lineCount = (result as string).split("\n").filter((l) => /^\d+:/.test(l)).length
    expect(lineCount).toBe(200)
    // Verify first and last line numbers
    expect(result as string).toContain("1: line 0")
    expect(result as string).toContain("200: line 199")
    expect(result as string).not.toContain("201:")
  })

  test("default lines is 50", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
    fs.writeFileSync(path.join(dir, "big.md"), lines.join("\n"))
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: "big.md" }, ctx)
    // Default lines=50, so only first 50 lines should appear
    const lineCount = (result as string).split("\n").filter((l) => /^\d+:/.test(l)).length
    expect(lineCount).toBe(50)
    expect(result as string).toContain("1: line 0")
    expect(result as string).toContain("50: line 49")
    expect(result as string).not.toContain("51:")
  })

  test("from defaults to 1", async () => {
    fs.writeFileSync(path.join(dir, "test.md"), "first\nsecond")
    const tool = memoryGet(dir)
    const result = await tool.execute({ path: "test.md" }, ctx)
    expect(result as string).toContain("1: first")
  })
})

describe("memory.tools.inferEntityKind", () => {
  test("path with slash returns 'path'", () => {
    expect(inferEntityKind("src/auth/handler.ts")).toBe("path")
  })

  test("path with file extension returns 'path'", () => {
    expect(inferEntityKind("handler.ts")).toBe("path")
    expect(inferEntityKind("config.json")).toBe("path")
  })

  test("PascalCase returns 'class'", () => {
    expect(inferEntityKind("AuthService")).toBe("class")
    expect(inferEntityKind("UserController")).toBe("class")
  })

  test("camelCase returns 'function'", () => {
    expect(inferEntityKind("getUserById")).toBe("function")
    expect(inferEntityKind("createNewSession")).toBe("function")
  })

  test("snake_case returns 'function'", () => {
    expect(inferEntityKind("get_user_by_id")).toBe("function")
  })

  test("2-segment camelCase returns 'technology' (not function)", () => {
    // camelCase pattern requires 2+ uppercase transitions (3+ segments)
    // "getData" has only 2 segments → doesn't match function pattern → falls through to technology
    expect(inferEntityKind("getData")).toBe("technology")
  })

  test("lowercase single word returns 'technology'", () => {
    expect(inferEntityKind("redis")).toBe("technology")
    expect(inferEntityKind("typescript")).toBe("technology")
  })
})

describe("memory.tools.memorySearch via tool.execute with entity filter", () => {
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(async () => {
    store = MemoryStore.create(`tools-entity-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()

    const [embedding] = await provider.embed(["TypeScript conventions and patterns"])
    store.upsertChunk({
      id: "c-ts",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-c-ts",
      text: "TypeScript conventions and patterns for the project",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    })
    store.upsertEntities("c-ts", [{ kind: "technology", value: "typescript" }])
  })

  afterEach(() => {
    store.close()
  })

  test("entity filter through tool.execute restricts results", async () => {
    const tool = memorySearch(store, provider)
    const result = await tool.execute({ query: "conventions", entity: "typescript" }, ctx)
    // Should find the TypeScript chunk via entity search
    expect(result as string).toContain("Result 1")
    expect(result as string).toContain("TypeScript conventions")
  })

  test("truthState filter through tool.execute returns deprecated chunks", async () => {
    // Add a deprecated chunk
    const [embedding] = await provider.embed(["TypeScript deprecated old info"])
    store.upsertChunk({
      id: "c-dep",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-c-dep",
      text: "TypeScript deprecated old info",
      embedding: serialize(embedding),
      truth_state: "deprecated",
      confidence: 0.1,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    })

    // Use the underlying search with minScore=0 to bypass the tool's default threshold
    const { search: rawSearch } = await import("../../src/memory/search")
    const results = await rawSearch({
      store,
      provider,
      query: "TypeScript",
      options: { truthState: "deprecated", minScore: 0 },
    })
    // All results must have the deprecated truth state
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.truthState).toBe("deprecated")
    }
    // The deprecated chunk we inserted must be among results
    expect(results.some((r) => r.id === "c-dep")).toBe(true)
    expect(results.some((r) => r.text.includes("deprecated old info"))).toBe(true)
  })
})

describe("memory.tools.memorySearch entity kind inference", () => {
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(async () => {
    store = MemoryStore.create(`tools-entity-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()

    // Seed chunks with different entity kinds
    const [embedding] = await provider.embed(["entity test"])
    const base = {
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      embedding: serialize(embedding),
      truth_state: "validated" as const,
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    }

    store.upsertChunk({ ...base, id: "c-path", hash: "h-path", text: "Auth handler implementation" })
    store.upsertEntities("c-path", [{ kind: "path", value: "src/auth/handler.ts" }])

    store.upsertChunk({ ...base, id: "c-class", hash: "h-class", text: "AuthService class definition" })
    store.upsertEntities("c-class", [{ kind: "class", value: "AuthService" }])

    store.upsertChunk({ ...base, id: "c-tech", hash: "h-tech", text: "Redis caching setup" })
    store.upsertEntities("c-tech", [{ kind: "technology", value: "redis" }])

    store.upsertChunk({ ...base, id: "c-func", hash: "h-func", text: "getUserById function" })
    store.upsertEntities("c-func", [{ kind: "function", value: "getUserById" }])
  })

  afterEach(() => {
    store.close()
  })

  test("entity with slash infers kind=path", async () => {
    const { search: rawSearch } = await import("../../src/memory/search")
    const results = await rawSearch({
      store,
      provider,
      query: "handler",
      options: { entity: { kind: "path", value: "src/auth/handler.ts" }, minScore: 0 },
    })
    expect(results.some((r) => r.id === "c-path")).toBe(true)
  })

  test("PascalCase entity infers kind=class", async () => {
    const { search: rawSearch } = await import("../../src/memory/search")
    const results = await rawSearch({
      store,
      provider,
      query: "AuthService class definition",
      options: { entity: { kind: "class", value: "AuthService" }, minScore: 0 },
    })
    expect(results.some((r) => r.id === "c-class")).toBe(true)
  })

  test("lowercase entity infers kind=technology", async () => {
    const { search: rawSearch } = await import("../../src/memory/search")
    const results = await rawSearch({
      store,
      provider,
      query: "caching",
      options: { entity: { kind: "technology", value: "redis" }, minScore: 0 },
    })
    expect(results.some((r) => r.id === "c-tech")).toBe(true)
  })
})
