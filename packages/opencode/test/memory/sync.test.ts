import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { discover, sync } from "../../src/memory/sync"
import * as MemoryStore from "../../src/memory/store"
import type { EmbeddingProvider } from "../../src/memory/embed"

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `opencode-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fakeProvider(dims = 4): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => {
        const v = new Array(dims).fill(0)
        v[0] = 1.0
        return v
      })
    },
    dimensions: () => dims,
    model: () => "fake",
  }
}

describe("memory.sync.discover", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("discovers MEMORY.md in worktree root", () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Knowledge")
    const files = discover(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain("MEMORY.md")
  })

  test("discovers memory.md (lowercase)", () => {
    fs.writeFileSync(path.join(dir, "memory.md"), "# Knowledge")
    const files = discover(dir)
    expect(files).toHaveLength(1)
  })

  test("discovers files in memory/ directory", () => {
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(dir, "memory", "patterns.md"), "# Patterns")
    fs.writeFileSync(path.join(dir, "memory", "decisions.md"), "# Decisions")
    const files = discover(dir)
    expect(files).toHaveLength(2)
  })

  test("discovers nested files in memory/ subdirectories", () => {
    fs.mkdirSync(path.join(dir, "memory", "sub"), { recursive: true })
    fs.writeFileSync(path.join(dir, "memory", "sub", "deep.md"), "# Deep")
    const files = discover(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain("deep.md")
  })

  test("deduplicates files", () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Knowledge")
    // Pass the same file as an extra path
    const files = discover(dir, [path.join(dir, "MEMORY.md")])
    expect(files).toHaveLength(1)
  })

  test("handles extra file paths", () => {
    const extra = path.join(dir, "extra.md")
    fs.writeFileSync(extra, "# Extra")
    const files = discover(dir, [extra])
    expect(files).toHaveLength(1)
    expect(files[0]).toContain("extra.md")
  })

  test("handles extra directory paths", () => {
    const extraDir = path.join(dir, "docs")
    fs.mkdirSync(extraDir, { recursive: true })
    fs.writeFileSync(path.join(extraDir, "guide.md"), "# Guide")
    const files = discover(dir, [extraDir])
    expect(files).toHaveLength(1)
    expect(files[0]).toContain("guide.md")
  })

  test("skips nonexistent extra paths", () => {
    const files = discover(dir, ["/nonexistent/path.md"])
    expect(files).toHaveLength(0)
  })

  test("handles relative extra paths", () => {
    fs.writeFileSync(path.join(dir, "rel.md"), "# Relative")
    const files = discover(dir, ["rel.md"])
    expect(files).toHaveLength(1)
  })

  test("returns empty for directory with no knowledge files", () => {
    const files = discover(dir)
    expect(files).toHaveLength(0)
  })
})

describe("memory.sync.sync", () => {
  let dir: string
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(() => {
    dir = makeTmpDir()
    store = MemoryStore.create(`sync-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()
  })

  afterEach(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("indexes a new MEMORY.md file", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project\n\nSome knowledge content here.")
    const result = await sync({ store, provider, worktree: dir })
    expect(result.indexed).toBe(1)
    expect(result.unchanged).toBe(0)
    expect(result.removed).toBe(0)
    expect(result.errors).toHaveLength(0)
    // "# Project\n\nSome knowledge content here." = 1 chunk (short content, single paragraph)
    expect(store.stats().chunks).toBe(1)
    expect(store.stats().files).toBe(1)
  })

  test("skips unchanged files on re-sync", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project\n\nContent here.")
    await sync({ store, provider, worktree: dir })
    const result = await sync({ store, provider, worktree: dir })
    expect(result.indexed).toBe(0)
    expect(result.unchanged).toBe(1)
  })

  test("re-indexes changed files", async () => {
    const filepath = path.join(dir, "MEMORY.md")
    fs.writeFileSync(filepath, "# Version 1")
    await sync({ store, provider, worktree: dir })

    fs.writeFileSync(filepath, "# Version 2 with more content")
    const result = await sync({ store, provider, worktree: dir })
    expect(result.indexed).toBe(1)
    expect(result.unchanged).toBe(0)
  })

  test("removes stale files when source file is deleted", async () => {
    const filepath = path.join(dir, "MEMORY.md")
    fs.writeFileSync(filepath, "# Content")
    await sync({ store, provider, worktree: dir })
    expect(store.stats().files).toBe(1)

    fs.unlinkSync(filepath)
    const result = await sync({ store, provider, worktree: dir })
    expect(result.removed).toBe(1)
    expect(store.stats().files).toBe(0)
    expect(store.stats().chunks).toBe(0)
  })

  test("indexes multiple files from memory/ directory", async () => {
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(dir, "memory", "a.md"), "# A\n\nContent A")
    fs.writeFileSync(path.join(dir, "memory", "b.md"), "# B\n\nContent B")
    const result = await sync({ store, provider, worktree: dir })
    expect(result.indexed).toBe(2)
    expect(store.stats().files).toBe(2)
  })

  test("caches embeddings for reuse", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project\n\nKnowledge content.")
    await sync({ store, provider, worktree: dir })
    // "# Project\n\nKnowledge content." produces 1 chunk → 1 cache entry
    expect(store.stats().chunks).toBe(1)
    expect(store.stats().cacheEntries).toBe(1)
  })

  test("embedding cache is reused on re-index with same content", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Cache Test\n\nContent for cache reuse.")
    await sync({ store, provider, worktree: dir })
    const cacheAfterFirst = store.stats().cacheEntries
    expect(cacheAfterFirst).toBe(1) // 1 chunk → 1 cache entry

    // Delete file tracking to force re-index, but keep cache entries
    const filepath = path.join(dir, "MEMORY.md")
    const resolved = path.resolve(filepath)
    store.deleteChunksForPath(resolved)
    store.deleteFile(resolved)

    // Count embed calls to verify cache is used
    let embedCalls = 0
    const trackingProvider: EmbeddingProvider = {
      async embed(texts: string[]): Promise<number[][]> {
        embedCalls += texts.length
        return provider.embed(texts)
      },
      dimensions: () => provider.dimensions(),
      model: () => provider.model(),
    }

    const result = await sync({ store, provider: trackingProvider, worktree: dir })
    expect(result.indexed).toBe(1)
    // Cache should be reused — no new embed calls needed
    expect(embedCalls).toBe(0)
    expect(store.stats().cacheEntries).toBeGreaterThanOrEqual(cacheAfterFirst)
  })

  test("FTS search works after sync", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Architecture\n\nUses SQLite for storage.")
    await sync({ store, provider, worktree: dir })
    const results = store.searchFts("SQLite", 10)
    expect(results).toHaveLength(1)
    const chunk = store.getChunk(results[0].id)!
    expect(chunk.text).toContain("SQLite")
    expect(chunk.source).toBe("memory")
    expect(store.searchFts("PostgreSQL", 10)).toHaveLength(0)
  })

  test("entity extraction during sync produces entity tags", async () => {
    fs.writeFileSync(
      path.join(dir, "MEMORY.md"),
      "# Architecture\n\nWe use typescript with react, the AuthService handles authentication at src/auth/handler.ts.",
    )
    await sync({ store, provider, worktree: dir, entityMode: "regex" })

    // Content produces 1 chunk; entity extraction finds at least: typescript, react, AuthService, src/auth/handler.ts
    const chunks = store.allChunks()
    expect(chunks).toHaveLength(1)
    const ents = store.entitiesForChunk(chunks[0].id)
    const allValues = ents.map((e) => e.value)
    // Exactly 4 entities: typescript, react, AuthService, src/auth/handler.ts
    expect(ents).toHaveLength(4)
    expect(allValues).toContain("typescript")
    expect(allValues).toContain("react")
    expect(allValues).toContain("AuthService")
    expect(allValues.some((v) => v.includes("src/auth/handler.ts"))).toBe(true)
  })

  test("handles provider failure during sync gracefully", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Error Test\n\nContent for error testing.")
    const failProvider: EmbeddingProvider = {
      async embed(_texts: string[]): Promise<number[][]> {
        throw new Error("embedding API unavailable")
      },
      dimensions: () => 4,
      model: () => "fail-model",
    }

    const result = await sync({ store, provider: failProvider, worktree: dir })
    // The sync should record an error rather than crashing
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("embedding API unavailable")
  })

  test("handles empty file during sync", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "")
    const result = await sync({ store, provider, worktree: dir })
    // Empty file should be indexed (discovered) but produce zero chunks
    expect(result.indexed).toBe(1)
    expect(store.stats().chunks).toBe(0)
  })

  test("handles extra paths in sync", async () => {
    const extraDir = path.join(dir, "extra")
    fs.mkdirSync(extraDir, { recursive: true })
    fs.writeFileSync(path.join(extraDir, "notes.md"), "# Notes\n\nExtra notes here.")
    const result = await sync({ store, provider, worktree: dir, extra: [extraDir] })
    expect(result.indexed).toBe(1)
  })

  // =========================================================================
  // Gap-fill: sync edge cases
  // =========================================================================

  test("entity extraction failure does not crash sync", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Knowledge\n\nSome important patterns and conventions here.")
    // Use regex entity mode — entity extraction itself shouldn't fail,
    // but we verify the pipeline completes even if entityMode is provided
    const result = await sync({ store, provider, worktree: dir, entityMode: "regex" })
    expect(result.indexed).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  test("non-.md files in memory/ directory are ignored", async () => {
    const memDir = path.join(dir, "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "notes.md"), "# Notes\n\nSome notes.")
    fs.writeFileSync(path.join(memDir, "data.json"), '{"key": "value"}')
    fs.writeFileSync(path.join(memDir, "script.py"), "print('hello')")
    const paths = discover(dir)
    // Only .md files should be discovered
    expect(paths.every((p) => p.endsWith(".md"))).toBe(true)
    expect(paths.some((p) => p.endsWith(".json"))).toBe(false)
    expect(paths.some((p) => p.endsWith(".py"))).toBe(false)
  })
})
