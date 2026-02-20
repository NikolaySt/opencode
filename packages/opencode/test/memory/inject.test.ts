import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import * as MemoryStore from "../../src/memory/store"
import { serialize } from "../../src/memory/embed"
import { build, effectiveBudget } from "../../src/memory/inject"
import * as Metrics from "../../src/memory/metrics"
import type { EmbeddingProvider } from "../../src/memory/embed"
import type { ChunkRow } from "../../src/memory/schema"

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `opencode-inject-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fakeProvider(dims = 8): EmbeddingProvider {
  const dictionary: Record<string, number> = {
    typescript: 0,
    architecture: 1,
    patterns: 2,
    conventions: 3,
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
        const fallback = new Array(dims).fill(0)
        fallback[t.length % dims] = 1.0
        return fallback
      })
    },
    dimensions: () => dims,
    model: () => "fake",
  }
}

describe("memory.inject.build", () => {
  let dir: string
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  beforeEach(() => {
    dir = makeTmpDir()
    store = MemoryStore.create(`inject-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()
  })

  afterEach(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("returns undefined when no memory sources exist", async () => {
    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(result).toBeUndefined()
  })

  test("includes MEMORY.md header when file exists", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project Knowledge\n\nImportant architectural decisions here.")
    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(result).toContain("Project Knowledge")
    expect(result).toContain("Key Knowledge")
    expect(result).toContain("## Project Memory")
  })

  test("includes recent session summaries", async () => {
    store.upsertSummary({
      id: "s1",
      session_id: "sess1",
      project_id: "test",
      content: "Discovered that Redis is used for caching.",
      truth_state: "candidate",
      created_at: Date.now(),
    })

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(result).toContain("Recent Sessions")
    expect(result).toContain("Redis")
  })

  test("limits summaries to SUMMARY_LIMIT", async () => {
    for (let i = 0; i < 10; i++) {
      store.upsertSummary({
        id: `s${i}`,
        session_id: `sess${i}`,
        project_id: "test",
        content: `Summary ${i}`,
        truth_state: "candidate",
        created_at: i * 1000,
      })
    }

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(result).toBeDefined()
    // Should have exactly 5 bullet points (SUMMARY_LIMIT = 5, we have 10 summaries)
    const bullets = result!.match(/^- /gm)
    expect(bullets).toHaveLength(5)
  })

  test("includes search results when query is provided", async () => {
    // Seed a searchable chunk
    const [embedding] = await provider.embed(["TypeScript architecture"])
    store.upsertChunk({
      id: "c1",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-c1",
      text: "TypeScript architecture patterns and conventions",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    } as ChunkRow)

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      query: "TypeScript architecture",
    })
    expect(result).toContain("## Project Memory")
    // Search results should include "Relevant Context" section (P2)
    expect(result).toContain("Relevant Context")
    expect(result).toContain("TypeScript architecture")
  })

  test("truncates output to maxTokens budget", async () => {
    // Create a very long MEMORY.md — the priority builder limits the
    // content slice via P1 budget (30% of total). With maxTokens=50,
    // totalBudget=200, P1 budget=60 chars. So the content is sliced
    // to ~60 chars even though the file has 5000+ chars.
    const longContent = "# Knowledge\n\n" + "x".repeat(5000)
    fs.writeFileSync(path.join(dir, "MEMORY.md"), longContent)

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 50, // 200 chars budget — forces content slicing
    })
    expect(result).toBeDefined()
    // Total output should fit within ~200 char budget + wrapper
    expect(result!.length).toBeLessThan(250)
    expect(result!).toContain("## Project Memory")
    expect(result!).toContain("Key Knowledge")
    // The long "x" content should be truncated — p1Budget = floor(200*0.3) = 60 chars
    const xCount = (result!.match(/x/g) || []).length
    expect(xCount).toBeLessThanOrEqual(60)
    expect(xCount).toBeGreaterThan(0) // but some x's are present
  })

  test("prefers MEMORY.md over memory.md", async () => {
    // On case-insensitive filesystems (Windows/macOS), both filenames
    // refer to the same file. We test the preference logic differently:
    // - Case-sensitive FS: write both files, verify MEMORY.md content is used
    // - Case-insensitive FS: write only memory.md (lowercase), verify it's found as fallback
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Uppercase")
    fs.writeFileSync(path.join(dir, "memory.md"), "# Lowercase")

    // Detect if filesystem is case-insensitive
    const upper = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8")
    const lower = fs.readFileSync(path.join(dir, "memory.md"), "utf-8")

    if (upper === lower) {
      // Case-insensitive FS — both names point to same file.
      // Instead, verify the build loop checks MEMORY.md first by
      // confirming the written file (last write wins) is found.
      const result = await build({
        store,
        provider,
        worktree: dir,
        projectID: "test",
        maxTokens: 2000,
      })
      expect(result).toBeDefined()
      // On case-insensitive FS the second write overwrites the first,
      // so the content is "# Lowercase". Verify it was picked up.
      expect(result!).toContain("Lowercase")
    } else {
      const result = await build({
        store,
        provider,
        worktree: dir,
        projectID: "test",
        maxTokens: 2000,
      })
      expect(result).toBeDefined()
      expect(result!).toContain("Uppercase")
    }
  })

  test("combines MEMORY.md header with summaries", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project\n\nKey fact here.")
    store.upsertSummary({
      id: "s1",
      session_id: "sess1",
      project_id: "test",
      content: "Session learned something",
      truth_state: "candidate",
      created_at: Date.now(),
    })

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(result).toContain("Key Knowledge")
    expect(result).toContain("Recent Sessions")
  })

  test("includes P4 entity-matched context when query has entities", async () => {
    // Seed a chunk with entity tags
    const [embedding] = await provider.embed(["TypeScript architecture"])
    store.upsertChunk({
      id: "ent-c1",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-ent-c1",
      text: "TypeScript architecture patterns in the codebase",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    } as ChunkRow)
    store.upsertEntities("ent-c1", [{ kind: "technology", value: "typescript" }])

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      query: "How does typescript work in this project?",
    })
    // The query contains "typescript" which extractRegex picks up as technology.
    // P4 section should be included since we have a matching entity tag.
    expect(result).toContain("## Project Memory")
    expect(result).toContain("Related Entities")
    expect(result).toContain("TypeScript architecture")
  })

  test("handles query with no matching entities gracefully", async () => {
    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      query: "How does the system work?",
    })
    // Should return undefined since no MEMORY.md, no summaries, and no entity matches
    expect(result).toBeUndefined()
  })

  test("P1 truncation slices content when it exceeds budget", async () => {
    // Create a MEMORY.md with no ## headings so the full content is used.
    // With maxTokens=10 → totalBudget=40 chars → the header "### Key Knowledge\n\n"
    // alone is ~20 chars, leaving only ~20 chars for content.
    // The P1 budget (30% of 40 = 12 chars) limits the slice from the file.
    const longContent = "Knowledge that is much longer than the budget allows for testing purposes"
    fs.writeFileSync(path.join(dir, "MEMORY.md"), longContent)

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 10,
    })
    expect(result).toBeDefined()
    // The full content is 73 chars; with maxTokens=10 (40 char budget), the result must be much shorter
    expect(result!.length).toBeLessThan(73) // shorter than full content alone
    expect(result!).toContain("## Project Memory")
    expect(result!).toContain("Key Knowledge")
    // The content should be truncated — not all words present
    expect(result!).not.toContain("testing purposes")
  })

  test("P2 search error is handled gracefully", async () => {
    // Create a provider that fails during search
    const failProvider: EmbeddingProvider = {
      async embed(_texts: string[]): Promise<number[][]> {
        throw new Error("embedding service down")
      },
      dimensions: () => 8,
      model: () => "fail",
    }

    // MEMORY.md ensures we get a result even if search fails
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project Knowledge")

    const result = await build({
      store,
      provider: failProvider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      query: "TypeScript architecture",
    })
    // Should still succeed with MEMORY.md even though search failed
    expect(result).toBeDefined()
    expect(result!).toContain("Project Knowledge")
    // Should NOT contain "Relevant Context" since search errored
    expect(result!).not.toContain("Relevant Context")
  })

  test("P3 summaries appear without MEMORY.md or query (standalone)", async () => {
    store.upsertSummary({
      id: "s1",
      session_id: "sess1",
      project_id: "test",
      content: "Standalone summary knowledge.",
      truth_state: "candidate",
      created_at: Date.now(),
    })

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      // No query, no MEMORY.md
    })
    expect(result).toBeDefined()
    expect(result!).toContain("Recent Sessions")
    expect(result!).toContain("Standalone summary")
  })

  test("metrics are recorded during injection", async () => {
    Metrics.reset()

    // Empty case — no sources
    await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(Metrics.get("injections")).toBe(1)
    expect(Metrics.get("injectionMisses")).toBe(1)

    // Case with MEMORY.md — should record a hit
    Metrics.reset()
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Metrics Test")
    await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(Metrics.get("injections")).toBe(1)
    expect(Metrics.get("injectionHits")).toBe(1)
    expect(Metrics.get("injectionChars")).toBeGreaterThan(0)
  })

  test("fitSection budget overflow trims items to fit", async () => {
    // Create many summaries that exceed the P3 budget
    for (let i = 0; i < 5; i++) {
      store.upsertSummary({
        id: `fit-s${i}`,
        session_id: `sess${i}`,
        project_id: "test",
        content: "A".repeat(100) + ` summary item ${i}`,
        truth_state: "candidate",
        created_at: Date.now() - i * 1000,
      })
    }

    // Small budget forces truncation of items
    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 60, // 240 chars total budget, P3 = 48 chars
    })
    expect(result).toBeDefined()
    expect(result!).toContain("Recent Sessions")
    // Should have fewer than 5 bullet points due to budget
    const bullets = result!.match(/^- /gm)
    expect(bullets).not.toBeNull()
    expect(bullets!.length).toBeLessThanOrEqual(2) // tight budget allows only a couple
    expect(bullets!.length).toBeGreaterThanOrEqual(1) // but at least one must fit
  })

  test("P1 truncation with very small budget hard-slices without marker", async () => {
    // maxTokens=5 → totalBudget=20. p1Budget=6. Content sliced to 6 chars.
    // section = "### Key Knowledge\n\n" + "KKKKKK" = 27 chars. remaining = 20. 27 > 20 → truncate!
    // remaining (20) < 25, so the else branch fires → section.slice(0, remaining), no marker
    const content = "K".repeat(100)
    fs.writeFileSync(path.join(dir, "MEMORY.md"), content)

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 5, // 20 chars total budget — forces truncation in the else branch
    })
    expect(result).toBeDefined()
    // With remaining=20 < 25, the else-branch fires (section.slice(0, remaining))
    // No "[...truncated]" marker — it just hard-slices
    expect(result!).not.toContain("[...truncated]")
    expect(result!.length).toBeLessThanOrEqual(50) // "## Project Memory\n\n" + sliced section
    expect(result!).toContain("## Project Memory")
  })

  test("P1 truncation produces [...truncated] marker when remaining > 25", async () => {
    // To trigger the marker path: section > remaining AND remaining > 25.
    // Using a ## heading that appears late forces a long slice.
    // Content before \n## = long block. firstH2 > 0 → slice(0, firstH2) = long.
    // section = "### Key Knowledge\n\n" (19) + longSlice. If > remaining AND remaining > 25 → marker.
    const longBlock = "A".repeat(50) // 50 chars before the H2
    const content = `${longBlock}\n## Details\n\nMore stuff here`
    fs.writeFileSync(path.join(dir, "MEMORY.md"), content)

    // maxTokens=15 → totalBudget=60. remaining=60.
    // firstH2 = content.indexOf("\n## ") = 50. slice(0,50) = 50 "A"s.
    // section = "### Key Knowledge\n\n" (19) + 50 "A"s = 69 chars. 69 > 60 → truncate.
    // remaining (60) > 25 → marker path: section.slice(0, 60-25) + "\n\n[...truncated]"
    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 15,
    })
    expect(result).toBeDefined()
    expect(result!).toContain("## Project Memory")
    expect(result!).toContain("Key Knowledge")
    expect(result!).toContain("[...truncated]")
    // Content must be truncated — not all 50 A's present
    const aCount = (result!.match(/A/g) || []).length
    expect(aCount).toBeLessThan(50)
  })

  test("respects MEMORY.md first H2 boundary for P1 slice", async () => {
    const content = "# Project\n\nTop-level knowledge\n\n## Details\n\nDetailed content that should be excluded"
    fs.writeFileSync(path.join(dir, "MEMORY.md"), content)

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
    })
    expect(result).toBeDefined()
    expect(result!).toContain("Top-level knowledge")
    // Content after ## Details should be excluded by firstH2 slice
    expect(result!).not.toContain("Detailed content that should be excluded")
  })
})

// ============================================================================
// Context-aware budget scaling
// ============================================================================

describe("memory.inject.effectiveBudget", () => {
  test("returns configured maxTokens when no contextLimit", () => {
    const result = effectiveBudget({ maxTokens: 2000 })
    expect(result).toEqual({ tokens: 2000, compressed: false })
  })

  test("returns configured maxTokens when contextLimit is 0", () => {
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 0 })
    expect(result).toEqual({ tokens: 2000, compressed: false })
  })

  test("returns configured maxTokens when usedTokens is undefined (first turn)", () => {
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000 })
    expect(result).toEqual({ tokens: 2000, compressed: false })
  })

  test("returns undefined when available budget is below minimum", () => {
    // contextLimit=200000, usedTokens=199900, safety=5000 → available = -4900
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 199900 })
    expect(result).toBeUndefined()
  })

  test("returns undefined when available exactly equals safety margin", () => {
    // contextLimit=200000, usedTokens=195000, safety=5000 → available = 0
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 195000 })
    expect(result).toBeUndefined()
  })

  test("returns undefined when available is below MIN_INJECTION_TOKENS (200)", () => {
    // contextLimit=200000, usedTokens=194850, safety=5000 → available = 150 < 200
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 194850 })
    expect(result).toBeUndefined()
  })

  test("clamps to available when less than maxTokens, not compressed", () => {
    // contextLimit=200000, usedTokens=193500, safety=5000 → available = 1500
    // 1500 >= maxTokens*0.5=1000 → not compressed
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 193500 })
    expect(result).toEqual({ tokens: 1500, compressed: false })
  })

  test("activates compressed mode when available < 50% of maxTokens", () => {
    // contextLimit=200000, usedTokens=194300, safety=5000 → available = 700
    // 700 < maxTokens*0.5=1000 → compressed
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 194300 })
    expect(result).toEqual({ tokens: 700, compressed: true })
  })

  test("does not clamp when plenty of room", () => {
    // contextLimit=200000, usedTokens=50000, safety=5000 → available = 145000
    // min(2000, 145000) = 2000 → no scaling
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 50000 })
    expect(result).toEqual({ tokens: 2000, compressed: false })
  })

  test("works with small context models (8K)", () => {
    // contextLimit=8192, usedTokens=6000, safety=5000 → available = -808
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 8192, usedTokens: 6000 })
    expect(result).toBeUndefined()
  })

  test("works with small context model but low usage", () => {
    // contextLimit=8192, usedTokens=1000, safety=5000 → available = 2192
    // min(2000, 2192) = 2000 → no scaling
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 8192, usedTokens: 1000 })
    expect(result).toEqual({ tokens: 2000, compressed: false })
  })

  test("boundary: available exactly at MIN_INJECTION_TOKENS (200)", () => {
    // contextLimit=200000, usedTokens=194800, safety=5000 → available = 200
    // 200 >= 200 → allowed. 200 < 1000 → compressed
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 194800 })
    expect(result).toEqual({ tokens: 200, compressed: true })
  })

  test("boundary: compressed threshold exact (available === 50% of maxTokens)", () => {
    // contextLimit=200000, usedTokens=194000, safety=5000 → available = 1000
    // 1000 === maxTokens*0.5=1000 → NOT compressed (threshold is strict <)
    const result = effectiveBudget({ maxTokens: 2000, contextLimit: 200000, usedTokens: 194000 })
    expect(result).toEqual({ tokens: 1000, compressed: false })
  })
})

describe("memory.inject.build with context-aware budget", () => {
  let dir: string
  let store: MemoryStore.Store
  let provider: EmbeddingProvider

  function fakeProvider(dims = 8): EmbeddingProvider {
    const dictionary: Record<string, number> = {
      typescript: 0,
      architecture: 1,
      patterns: 2,
      conventions: 3,
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
          const fallback = new Array(dims).fill(0)
          fallback[t.length % dims] = 1.0
          return fallback
        })
      },
      dimensions: () => dims,
      model: () => "fake",
    }
  }

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `opencode-inject-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(dir, { recursive: true })
    store = MemoryStore.create(`inject-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
    provider = fakeProvider()
    Metrics.reset()
  })

  afterEach(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("skips injection when context is nearly full", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project Knowledge\n\nImportant info.")

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      contextLimit: 200000,
      usedTokens: 199900, // only 100 tokens left, minus 5000 safety = -4900
    })
    expect(result).toBeUndefined()
    expect(Metrics.get("injectionSkippedOverflow")).toBe(1)
    expect(Metrics.get("injections")).toBe(1)
  })

  test("records injectionBudgetScaled when budget is reduced", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Knowledge\n\nSome content here.")

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      contextLimit: 200000,
      usedTokens: 193500, // available = 1500 < 2000 → scaled
    })
    expect(result).toBeDefined()
    expect(Metrics.get("injectionBudgetScaled")).toBe(1)
  })

  test("does not record injectionBudgetScaled when plenty of room", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Knowledge\n\nSome content.")

    await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      contextLimit: 200000,
      usedTokens: 50000, // available = 145000 >> 2000
    })
    expect(Metrics.get("injectionBudgetScaled")).toBe(0)
  })

  test("compressed mode produces shorter output than normal mode", async () => {
    // Seed data for all sections
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Project\n\n" + "Knowledge ".repeat(50))
    for (let i = 0; i < 5; i++) {
      store.upsertSummary({
        id: `s${i}`,
        session_id: `sess${i}`,
        project_id: "test",
        content: "Summary line " + "data ".repeat(30),
        truth_state: "candidate",
        created_at: Date.now() - i * 1000,
      })
    }
    const [embedding] = await provider.embed(["TypeScript architecture"])
    store.upsertChunk({
      id: "c-budget",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-budget",
      text: "TypeScript architecture patterns and conventions " + "detail ".repeat(40),
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    } as ChunkRow)

    // Normal mode — full budget
    const normal = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      query: "TypeScript architecture",
    })

    // Compressed mode — tight budget triggers compression
    // available = 200000 - 194300 - 5000 = 700 tokens, < 2000*0.5 → compressed
    const compressed = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      contextLimit: 200000,
      usedTokens: 194300,
      query: "TypeScript architecture",
    })

    expect(normal).toBeDefined()
    expect(compressed).toBeDefined()
    expect(compressed!.length).toBeLessThan(normal!.length)
  })

  test("compressed mode skips P4 entity section", async () => {
    const [embedding] = await provider.embed(["TypeScript architecture"])
    store.upsertChunk({
      id: "c-entity",
      path: "/test.md",
      source: "memory",
      start_line: 1,
      end_line: 1,
      hash: "hash-entity",
      text: "TypeScript architecture patterns",
      embedding: serialize(embedding),
      truth_state: "validated",
      confidence: 1.0,
      created_at: Date.now(),
      updated_at: Date.now(),
      embedding_model: "fake",
      last_validated_at: null,
    } as ChunkRow)
    store.upsertEntities("c-entity", [{ kind: "technology", value: "typescript" }])

    // Normal mode includes P4
    const normal = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      query: "How does typescript work?",
    })
    expect(normal).toContain("Related Entities")

    // Compressed mode skips P4
    const compressed = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      contextLimit: 200000,
      usedTokens: 194300, // compressed
      query: "How does typescript work?",
    })
    // Compressed may or may not have content (depends on whether search results
    // and summaries fit in 700 tokens), but should NOT have entity section
    if (compressed) {
      expect(compressed).not.toContain("Related Entities")
    }
  })

  test("normal budget when contextLimit provided but usedTokens undefined (first turn)", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# First Turn\n\nContent for first turn.")

    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      contextLimit: 200000,
      // usedTokens not provided — first turn
    })
    expect(result).toBeDefined()
    expect(result!).toContain("First Turn")
    expect(Metrics.get("injectionBudgetScaled")).toBe(0)
    expect(Metrics.get("injectionSkippedOverflow")).toBe(0)
  })

  test("compressed mode limits summaries to 2", async () => {
    for (let i = 0; i < 10; i++) {
      store.upsertSummary({
        id: `s${i}`,
        session_id: `sess${i}`,
        project_id: "test",
        content: `Summary ${i}`,
        truth_state: "candidate",
        created_at: Date.now() - i * 1000,
      })
    }

    // Compressed mode: available = 700, compressed = true
    const result = await build({
      store,
      provider,
      worktree: dir,
      projectID: "test",
      maxTokens: 2000,
      contextLimit: 200000,
      usedTokens: 194300,
    })
    expect(result).toBeDefined()
    const bullets = result!.match(/^- /gm)
    expect(bullets).not.toBeNull()
    // COMPRESSED_SUMMARY_LIMIT = 2, so at most 2 summary bullets
    expect(bullets!.length).toBeLessThanOrEqual(2)
  })
})
