import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import * as MemoryStore from "../../src/memory/store"
import { handleCommand } from "../../src/memory/index"
import { serialize } from "../../src/memory/embed"
import type { ChunkRow } from "../../src/memory/schema"

describe("memory commands", () => {
  let store: MemoryStore.Store

  beforeEach(() => {
    store = MemoryStore.create(`cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    store.open()
  })

  afterEach(() => {
    store.close()
  })

  function makeChunk(id: string, text: string, opts?: Partial<ChunkRow>): ChunkRow {
    return {
      id,
      path: opts?.path ?? "/test.md",
      source: opts?.source ?? "memory",
      start_line: opts?.start_line ?? 1,
      end_line: opts?.end_line ?? 10,
      hash: opts?.hash ?? `hash-${id}`,
      text,
      embedding: opts?.embedding ?? serialize([0.1, 0.2, 0.3]),
      truth_state: opts?.truth_state ?? "validated",
      confidence: opts?.confidence ?? 1.0,
      created_at: opts?.created_at ?? Date.now(),
      updated_at: opts?.updated_at ?? Date.now(),
      embedding_model: opts?.embedding_model ?? "openai/text-embedding-3-small",
      last_validated_at: opts?.last_validated_at ?? null,
    }
  }

  // =========================================================================
  // /memory chunks
  // =========================================================================

  describe("chunks", () => {
    test("returns 'No chunks found' on empty store", () => {
      const result = handleCommand(store, "chunks")
      expect(result).not.toBeNull()
      expect(result!.text).toBe("No chunks found.")
    })

    test("lists chunks with table header", () => {
      store.upsertChunk(makeChunk("chunk-abc-123", "Some interesting text about memory"))
      const result = handleCommand(store, "chunks")!
      expect(result.text).toContain("**Memory Chunks**")
      expect(result.text).toContain("| ID (8) | Source | Path | Truth | Embed | Model | Text |")
      expect(result.text).toContain("`chunk-ab`")
      expect(result.text).toContain("memory")
      expect(result.text).toContain("validated")
      expect(result.text).toContain("yes")
      expect(result.text).toContain("Some interesting text about memory")
    })

    test("shows correct embed status for chunks without embeddings", () => {
      store.upsertChunk(makeChunk("no-embed-1", "no vector here", { embedding: Buffer.alloc(0), embedding_model: "" }))
      const result = handleCommand(store, "chunks")!
      // The table row should show "no" in the Embed column — verify the table structure
      // Split into rows and find the data row for this chunk
      const lines = result.text.split("\n")
      const dataRow = lines.find((l) => l.includes("`no-embed`"))
      expect(dataRow).toBeDefined()
      // The embed column (5th column) should contain "no"
      const cells = dataRow!.split("|").map((c) => c.trim())
      // cells: ["", id, source, path, truth, embed, model, text, ""]
      expect(cells[5]).toBe("no")
      expect(result.text).toContain("no vector here")
    })

    test("filters by source", () => {
      store.upsertChunk(makeChunk("mem-1", "memory chunk", { source: "memory" }))
      store.upsertChunk(makeChunk("sess-1", "session chunk", { source: "session" }))

      const memResult = handleCommand(store, "chunks source=memory")!
      expect(memResult.text).toContain("memory chunk")
      expect(memResult.text).not.toContain("session chunk")

      const sessResult = handleCommand(store, "chunks source=session")!
      expect(sessResult.text).toContain("session chunk")
      expect(sessResult.text).not.toContain("memory chunk")
    })

    test("filters by truth state", () => {
      store.upsertChunk(makeChunk("val-1", "validated chunk", { truth_state: "validated" }))
      store.upsertChunk(makeChunk("cand-1", "candidate chunk", { truth_state: "candidate" }))

      const result = handleCommand(store, "chunks truth=candidate")!
      expect(result.text).toContain("candidate chunk")
      expect(result.text).not.toContain("validated chunk")
    })

    test("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        store.upsertChunk(makeChunk(`lim-${i}`, `chunk number ${i}`))
      }
      const result = handleCommand(store, "chunks limit=2")!
      expect(result.text).toContain("(2 shown)")
      // Verify only 2 data rows appear (each has a backtick-ID cell)
      const dataRows = result.text.split("\n").filter((l) => l.includes("`lim-"))
      expect(dataRows).toHaveLength(2)
    })

    test("limit=999 is capped to 100 and returns all when fewer exist", () => {
      // Insert 3 chunks — fewer than the 100 cap
      for (let i = 0; i < 3; i++) {
        store.upsertChunk(makeChunk(`cap-${i}`, `chunk ${i}`))
      }
      // limit=999 should be capped to 100, but since we only have 3, all 3 show
      const result = handleCommand(store, "chunks limit=999")!
      expect(result.text).toContain("(3 shown)")

      // Verify that a smaller limit actually restricts — proving the limit path works
      const limited = handleCommand(store, "chunks limit=2")!
      expect(limited.text).toContain("(2 shown)")
      const fullRows = result.text.split("\n").filter((l) => l.includes("`cap-"))
      const limitedRows = limited.text.split("\n").filter((l) => l.includes("`cap-"))
      expect(fullRows.length).toBe(3)
      expect(limitedRows.length).toBe(2)
    })

    test("combines source and truth filters", () => {
      store.upsertChunk(makeChunk("a", "target", { source: "session", truth_state: "candidate" }))
      store.upsertChunk(makeChunk("b", "decoy1", { source: "session", truth_state: "validated" }))
      store.upsertChunk(makeChunk("c", "decoy2", { source: "memory", truth_state: "candidate" }))

      const result = handleCommand(store, "chunks source=session truth=candidate")!
      expect(result.text).toContain("target")
      expect(result.text).not.toContain("decoy1")
      expect(result.text).not.toContain("decoy2")
    })

    test("shows path filename only", () => {
      store.upsertChunk(makeChunk("path-1", "deep path", { path: "/src/memory/store.ts" }))
      const result = handleCommand(store, "chunks")!
      expect(result.text).toContain("store.ts")
    })

    test("shows model name without provider prefix", () => {
      store.upsertChunk(makeChunk("model-1", "text", { embedding_model: "openai/text-embedding-3-small" }))
      const result = handleCommand(store, "chunks")!
      expect(result.text).toContain("text-embedding-3-small")
      // Verify the prefix is actually stripped (not just present as substring)
      const lines = result.text.split("\n")
      const dataRow = lines.find((l) => l.includes("`model-1`"))
      expect(dataRow).toBeDefined()
      // The model column should NOT contain the full "openai/" prefix
      expect(dataRow!).not.toContain("openai/text-embedding")
    })

    test("escapes pipe characters in text snippets", () => {
      store.upsertChunk(makeChunk("pipe-1", "value | other | stuff"))
      const result = handleCommand(store, "chunks")!
      expect(result.text).toContain("value \\| other \\| stuff")
    })

    test("includes footer with inspect hint", () => {
      store.upsertChunk(makeChunk("foot-1", "text"))
      const result = handleCommand(store, "chunks")!
      expect(result.text).toContain("Use `/memory inspect <id>` for full details.")
    })
  })

  // =========================================================================
  // /memory summaries
  // =========================================================================

  describe("summaries", () => {
    test("returns 'No session summaries found' on empty store", () => {
      const result = handleCommand(store, "summaries")
      expect(result).not.toBeNull()
      expect(result!.text).toBe("No session summaries found.")
    })

    test("lists summaries with table header", () => {
      store.upsertSummary({
        id: "sum-abcdef-123",
        session_id: "sess-xyz-789",
        project_id: "proj-1",
        content: "We implemented a memory system using SQLite",
        truth_state: "candidate",
        created_at: new Date("2026-01-15T10:30:00Z").getTime(),
      })
      const result = handleCommand(store, "summaries")!
      expect(result.text).toContain("**Session Summaries**")
      expect(result.text).toContain("| ID (8) | Session (8) | Truth | Created | Content |")
      expect(result.text).toContain("`sum-abcd`")
      expect(result.text).toContain("`sess-xyz`")
      expect(result.text).toContain("candidate")
      expect(result.text).toContain("2026-01-15 10:30")
      expect(result.text).toContain("We implemented a memory system using SQLite")
    })

    test("shows most recent summaries first", () => {
      store.upsertSummary({
        id: "old-sum",
        session_id: "s1",
        project_id: "p",
        content: "old knowledge",
        truth_state: "candidate",
        created_at: 1000,
      })
      store.upsertSummary({
        id: "new-sum",
        session_id: "s2",
        project_id: "p",
        content: "new knowledge",
        truth_state: "validated",
        created_at: 2000,
      })
      const result = handleCommand(store, "summaries")!
      const newIdx = result.text.indexOf("new knowledge")
      const oldIdx = result.text.indexOf("old knowledge")
      expect(newIdx).toBeLessThan(oldIdx)
    })

    test("respects limit argument", () => {
      for (let i = 0; i < 5; i++) {
        store.upsertSummary({
          id: `s-${i}`,
          session_id: "s",
          project_id: "p",
          content: `summary ${i}`,
          truth_state: "candidate",
          created_at: i,
        })
      }
      const result = handleCommand(store, "summaries 2")!
      expect(result.text).toContain("(2 shown)")
    })

    test("escapes pipe characters in content", () => {
      store.upsertSummary({
        id: "pipe-s",
        session_id: "s",
        project_id: "p",
        content: "key | value | other",
        truth_state: "candidate",
        created_at: 1,
      })
      const result = handleCommand(store, "summaries")!
      expect(result.text).toContain("key \\| value \\| other")
    })

    test("replaces newlines in content snippet", () => {
      store.upsertSummary({
        id: "nl-s",
        session_id: "s",
        project_id: "p",
        content: "line1\nline2\nline3",
        truth_state: "candidate",
        created_at: 1,
      })
      const result = handleCommand(store, "summaries")!
      expect(result.text).toContain("line1 line2 line3")
      expect(result.text).not.toContain("line1\n")
    })
  })

  // =========================================================================
  // /memory entities
  // =========================================================================

  describe("entities", () => {
    test("returns 'No entity tags found' on empty store", () => {
      const result = handleCommand(store, "entities")
      expect(result).not.toBeNull()
      expect(result!.text).toBe("No entity tags found.")
    })

    test("lists entities grouped by kind", () => {
      store.upsertChunk(makeChunk("ent-c1", "auth code", { path: "/src/auth.ts" }))
      store.upsertEntities("ent-c1", [
        { kind: "function", value: "authenticate" },
        { kind: "technology", value: "TypeScript" },
        { kind: "path", value: "src/auth.ts" },
      ])
      const result = handleCommand(store, "entities")!
      expect(result.text).toContain("**Entity Tags**")
      expect(result.text).toContain("### function (1)")
      expect(result.text).toContain("### technology (1)")
      expect(result.text).toContain("### path (1)")
      expect(result.text).toContain("**authenticate**")
      expect(result.text).toContain("**TypeScript**")
    })

    test("deduplicates entities and shows count", () => {
      store.upsertChunk(makeChunk("ent-d1", "text1"))
      store.upsertChunk(makeChunk("ent-d2", "text2"))
      store.upsertEntities("ent-d1", [{ kind: "technology", value: "React" }])
      store.upsertEntities("ent-d2", [{ kind: "technology", value: "React" }])

      const result = handleCommand(store, "entities")!
      expect(result.text).toContain("**React** (2 chunks)")
    })

    test("single chunk entity shows singular 'chunk'", () => {
      store.upsertChunk(makeChunk("ent-s1", "text"))
      store.upsertEntities("ent-s1", [{ kind: "function", value: "main" }])

      const result = handleCommand(store, "entities")!
      expect(result.text).toContain("**main** (1 chunk)")
    })

    test("filters by kind", () => {
      store.upsertChunk(makeChunk("ent-k1", "text"))
      store.upsertEntities("ent-k1", [
        { kind: "function", value: "foo" },
        { kind: "class", value: "Bar" },
      ])
      const result = handleCommand(store, "entities kind=function")!
      expect(result.text).toContain("**foo**")
      expect(result.text).not.toContain("Bar")
    })

    test("respects limit parameter", () => {
      store.upsertChunk(makeChunk("ent-lim", "text"))
      store.upsertEntities("ent-lim", [
        { kind: "function", value: "a" },
        { kind: "function", value: "b" },
        { kind: "function", value: "c" },
      ])
      const result = handleCommand(store, "entities limit=2")!
      expect(result.text).toContain("(2 shown)")
      // Verify only 2 entity items are listed — format is "- **value** (N chunk)"
      const entityLines = result.text.split("\n").filter((l) => l.trim().startsWith("- **"))
      expect(entityLines).toHaveLength(2)
    })

    test("sorts by count descending", () => {
      store.upsertChunk(makeChunk("ent-sort1", "t1"))
      store.upsertChunk(makeChunk("ent-sort2", "t2"))
      store.upsertChunk(makeChunk("ent-sort3", "t3"))
      store.upsertEntities("ent-sort1", [{ kind: "technology", value: "Rare" }])
      store.upsertEntities("ent-sort2", [{ kind: "technology", value: "Common" }])
      store.upsertEntities("ent-sort3", [{ kind: "technology", value: "Common" }])

      const result = handleCommand(store, "entities")!
      const commonIdx = result.text.indexOf("**Common**")
      const rareIdx = result.text.indexOf("**Rare**")
      expect(commonIdx).toBeLessThan(rareIdx)
    })
  })

  // =========================================================================
  // /memory files
  // =========================================================================

  describe("files", () => {
    test("returns 'No indexed files found' on empty store", () => {
      const result = handleCommand(store, "files")
      expect(result).not.toBeNull()
      expect(result!.text).toBe("No indexed files found.")
    })

    test("lists files with table header", () => {
      store.upsertFile({
        path: "/project/MEMORY.md",
        source: "memory",
        hash: "abc123def456",
        mtime: new Date("2026-02-01T12:00:00Z").getTime(),
        size: 2048,
      })
      const result = handleCommand(store, "files")!
      expect(result.text).toContain("**Indexed Files** (1)")
      expect(result.text).toContain("| Path | Source | Hash (8) | Modified | Size |")
      expect(result.text).toContain("/project/MEMORY.md")
      expect(result.text).toContain("memory")
      expect(result.text).toContain("`abc123de`")
      expect(result.text).toContain("2026-02-01 12:00")
      expect(result.text).toContain("2.0KB")
    })

    test("shows bytes for small files", () => {
      store.upsertFile({ path: "/small.md", source: "memory", hash: "h1234567", mtime: 1, size: 512 })
      const result = handleCommand(store, "files")!
      expect(result.text).toContain("512B")
    })

    test("shows KB for large files", () => {
      store.upsertFile({ path: "/big.md", source: "memory", hash: "h1234567", mtime: 1, size: 10240 })
      const result = handleCommand(store, "files")!
      expect(result.text).toContain("10.0KB")
    })

    test("lists multiple files", () => {
      store.upsertFile({ path: "/a.md", source: "memory", hash: "h1111111", mtime: 1, size: 100 })
      store.upsertFile({ path: "/b.md", source: "extra", hash: "h2222222", mtime: 2, size: 200 })
      const result = handleCommand(store, "files")!
      expect(result.text).toContain("**Indexed Files** (2)")
      expect(result.text).toContain("/a.md")
      expect(result.text).toContain("/b.md")
      expect(result.text).toContain("extra")
    })
  })

  // =========================================================================
  // /memory inspect <id>
  // =========================================================================

  describe("inspect", () => {
    test("returns not found for missing chunk", () => {
      const result = handleCommand(store, "inspect nonexistent")
      expect(result).not.toBeNull()
      expect(result!.text).toContain("Chunk not found")
    })

    test("shows full chunk detail by exact ID", () => {
      const now = new Date("2026-02-15T14:30:00Z").getTime()
      store.upsertChunk(
        makeChunk("inspect-full-id", "This is the full text of the chunk", {
          path: "/src/memory/store.ts",
          source: "memory",
          start_line: 42,
          end_line: 58,
          truth_state: "validated",
          confidence: 0.95,
          embedding: serialize([1, 2, 3]),
          embedding_model: "openai/text-embedding-3-small",
          created_at: now,
          updated_at: now,
        }),
      )

      const result = handleCommand(store, "inspect inspect-full-id")!
      expect(result.text).toContain("**Chunk: `inspect-full-id`**")
      expect(result.text).toContain("/src/memory/store.ts")
      expect(result.text).toContain("memory")
      expect(result.text).toContain("42-58")
      expect(result.text).toContain("validated")
      expect(result.text).toContain("0.95")
      expect(result.text).toContain("yes (3 dims)")
      expect(result.text).toContain("openai/text-embedding-3-small")
      expect(result.text).toContain("2026-02-15 14:30:00")
      expect(result.text).toContain("This is the full text of the chunk")
    })

    test("shows 'no' for chunks without embedding", () => {
      store.upsertChunk(makeChunk("no-embed-inspect", "text", { embedding: Buffer.alloc(0), embedding_model: "" }))
      const result = handleCommand(store, "inspect no-embed-inspect")!
      expect(result.text).toContain("| Has Embedding | no |")
      expect(result.text).toContain("| Embedding Model | (none) |")
    })

    test("shows 'never' for last_validated_at when null", () => {
      store.upsertChunk(makeChunk("no-val", "text", { last_validated_at: null }))
      const result = handleCommand(store, "inspect no-val")!
      expect(result.text).toContain("| Last Validated | never |")
    })

    test("shows last_validated_at when set", () => {
      const ts = new Date("2026-02-10T08:00:00Z").getTime()
      store.upsertChunk(makeChunk("has-val", "text", { last_validated_at: ts }))
      store.touchValidated("has-val")
      // Re-read to get the actual touchValidated value
      const result = handleCommand(store, "inspect has-val")!
      expect(result.text).not.toContain("| Last Validated | never |")
      // Should show a formatted date string instead
      expect(result.text).toMatch(/\| Last Validated \| \d{4}-\d{2}-\d{2}/)
    })

    test("shows entities when present", () => {
      store.upsertChunk(makeChunk("ent-inspect", "entity text"))
      store.upsertEntities("ent-inspect", [
        { kind: "function", value: "handleCommand" },
        { kind: "technology", value: "SQLite" },
      ])
      const result = handleCommand(store, "inspect ent-inspect")!
      expect(result.text).toContain("**Entities** (2)")
      expect(result.text).toContain("- [function] handleCommand")
      expect(result.text).toContain("- [technology] SQLite")
    })

    test("does not show entities section when none exist", () => {
      store.upsertChunk(makeChunk("no-ent", "just text"))
      const result = handleCommand(store, "inspect no-ent")!
      expect(result.text).not.toContain("**Entities**")
    })

    test("supports prefix match for IDs", () => {
      store.upsertChunk(makeChunk("prefix-match-long-id-12345", "found by prefix"))
      const result = handleCommand(store, "inspect prefix")!
      expect(result.text).toContain("prefix-match-long-id-12345")
      expect(result.text).toContain("found by prefix")
    })

    test("truncates long text at 2000 chars", () => {
      const longText = "x".repeat(3000)
      store.upsertChunk(makeChunk("long-text", longText))
      const result = handleCommand(store, "inspect long-text")!
      expect(result.text).toContain("...(truncated)")
      expect(result.text).not.toContain("x".repeat(3000))
    })

    test("shows full text wrapped in code block", () => {
      store.upsertChunk(makeChunk("code-block", "function hello() { return 42 }"))
      const result = handleCommand(store, "inspect code-block")!
      expect(result.text).toContain("**Text:**")
      expect(result.text).toContain("```")
      expect(result.text).toContain("function hello() { return 42 }")
    })
  })

  // =========================================================================
  // /memory embeddings
  // =========================================================================

  describe("embeddings", () => {
    test("shows zeros on empty store", () => {
      const result = handleCommand(store, "embeddings")
      expect(result).not.toBeNull()
      expect(result!.text).toContain("**Embedding Status**")
      expect(result!.text).toContain("Total chunks: 0")
      expect(result!.text).toContain("With embeddings: 0")
      expect(result!.text).toContain("Empty (no vector): 0")
      expect(result!.text).toContain("No embedding models found")
    })

    test("shows correct counts with mixed chunks", () => {
      store.upsertChunk(
        makeChunk("emb-1", "with embed", {
          embedding: serialize([1, 2, 3]),
          embedding_model: "openai/text-embedding-3-small",
        }),
      )
      store.upsertChunk(
        makeChunk("emb-2", "also embedded", {
          embedding: serialize([4, 5, 6]),
          embedding_model: "openai/text-embedding-3-small",
        }),
      )
      store.upsertChunk(makeChunk("emb-3", "no embed", { embedding: Buffer.alloc(0), embedding_model: "" }))

      const result = handleCommand(store, "embeddings")!
      expect(result.text).toContain("Total chunks: 3")
      expect(result.text).toContain("With embeddings: 2 (66.7%)")
      expect(result.text).toContain("Empty (no vector): 1")
    })

    test("shows model distribution", () => {
      store.upsertChunk(
        makeChunk("m1", "t1", { embedding: serialize([1]), embedding_model: "openai/text-embedding-3-small" }),
      )
      store.upsertChunk(
        makeChunk("m2", "t2", { embedding: serialize([2]), embedding_model: "openai/text-embedding-3-small" }),
      )
      store.upsertChunk(
        makeChunk("m3", "t3", { embedding: serialize([3]), embedding_model: "openai/text-embedding-3-large" }),
      )

      const result = handleCommand(store, "embeddings")!
      expect(result.text).toContain("**By Model:**")
      expect(result.text).toContain("openai/text-embedding-3-small: 2 chunks")
      expect(result.text).toContain("openai/text-embedding-3-large: 1 chunks")
    })

    test("shows cache entry count", () => {
      store.cacheEmbedding({ hash: "cache1", embedding: serialize([1, 2]), model: "m", dims: 256, updated_at: 1 })
      store.cacheEmbedding({ hash: "cache2", embedding: serialize([3, 4]), model: "m", dims: 256, updated_at: 2 })

      const result = handleCommand(store, "embeddings")!
      expect(result.text).toContain("Embedding cache: 2 entries (256 dims)")
    })

    test("shows 100% when all chunks have embeddings", () => {
      store.upsertChunk(makeChunk("all-1", "t", { embedding: serialize([1, 2]) }))
      store.upsertChunk(makeChunk("all-2", "t", { embedding: serialize([3, 4]) }))

      const result = handleCommand(store, "embeddings")!
      expect(result.text).toContain("With embeddings: 2 (100.0%)")
      expect(result.text).toContain("Empty (no vector): 0")
    })
  })

  // =========================================================================
  // Unrecognized command returns null (falls through to help)
  // =========================================================================

  describe("unrecognized", () => {
    test("returns null for unknown subcommand", () => {
      expect(handleCommand(store, "unknown")).toBeNull()
    })

    test("returns null for empty args", () => {
      expect(handleCommand(store, "")).toBeNull()
    })

    test("returns null for status (handled by main handler)", () => {
      expect(handleCommand(store, "status")).toBeNull()
    })

    test("returns null for promote (handled by main handler)", () => {
      expect(handleCommand(store, "promote some-id")).toBeNull()
    })

    test("returns null for sync (handled by main handler)", () => {
      expect(handleCommand(store, "sync")).toBeNull()
    })

    test("returns null for metrics (handled by main handler)", () => {
      expect(handleCommand(store, "metrics")).toBeNull()
    })
  })

  // =========================================================================
  // Integration: populated store with all data types
  // =========================================================================

  describe("integration", () => {
    beforeEach(() => {
      // Populate a realistic store
      store.upsertFile({
        path: "/MEMORY.md",
        source: "memory",
        hash: "abcdef1234567890",
        mtime: Date.now(),
        size: 4096,
      })
      store.upsertFile({
        path: "/docs/notes.md",
        source: "extra",
        hash: "1234567890abcdef",
        mtime: Date.now(),
        size: 512,
      })

      store.upsertChunk(
        makeChunk("chunk-mem-1", "We use TypeScript with Bun runtime", {
          path: "/MEMORY.md",
          source: "memory",
          truth_state: "validated",
          embedding: serialize([0.1, 0.2, 0.3]),
          embedding_model: "openai/text-embedding-3-small",
        }),
      )
      store.upsertChunk(
        makeChunk("chunk-mem-2", "SQLite is used for persistent storage", {
          path: "/MEMORY.md",
          source: "memory",
          truth_state: "validated",
          embedding: serialize([0.4, 0.5, 0.6]),
          embedding_model: "openai/text-embedding-3-small",
        }),
      )
      store.upsertChunk(
        makeChunk("chunk-sess-1", "Session: implemented memory search", {
          path: "session://s1",
          source: "session",
          truth_state: "candidate",
          embedding: serialize([0.7, 0.8, 0.9]),
          embedding_model: "openai/text-embedding-3-small",
        }),
      )
      store.upsertChunk(
        makeChunk("chunk-no-vec", "Draft chunk without embedding", {
          path: "/docs/notes.md",
          source: "extra",
          truth_state: "hypothesis",
          embedding: Buffer.alloc(0),
          embedding_model: "",
        }),
      )

      store.upsertEntities("chunk-mem-1", [
        { kind: "technology", value: "TypeScript" },
        { kind: "technology", value: "Bun" },
      ])
      store.upsertEntities("chunk-mem-2", [{ kind: "technology", value: "SQLite" }])
      store.upsertEntities("chunk-sess-1", [{ kind: "concept", value: "memory search" }])

      store.upsertSummary({
        id: "sum-integration-1",
        session_id: "session-abc-123",
        project_id: "proj-1",
        content: "Implemented hybrid search combining vector and keyword matching",
        truth_state: "candidate",
        created_at: Date.now() - 3600_000,
      })
      store.upsertSummary({
        id: "sum-integration-2",
        session_id: "session-def-456",
        project_id: "proj-1",
        content: "Fixed server-blocking bug in memory plugin registration",
        truth_state: "validated",
        created_at: Date.now(),
      })

      store.cacheEmbedding({
        hash: "cache-int-1",
        embedding: serialize([1, 2, 3]),
        model: "openai/text-embedding-3-small",
        dims: 3,
        updated_at: Date.now(),
      })
    })

    test("chunks shows all chunk types", () => {
      const result = handleCommand(store, "chunks")!
      expect(result.text).toContain("(4 shown)")
      expect(result.text).toContain("TypeScript")
      expect(result.text).toContain("session")
      expect(result.text).toContain("memory")
    })

    test("chunks filtered to session source", () => {
      const result = handleCommand(store, "chunks source=session")!
      expect(result.text).toContain("(1 shown)")
      expect(result.text).toContain("memory search")
    })

    test("summaries shows both summaries", () => {
      const result = handleCommand(store, "summaries")!
      expect(result.text).toContain("(2 shown)")
      expect(result.text).toContain("hybrid search")
      expect(result.text).toContain("server-blocking bug")
    })

    test("entities shows all technologies and concepts", () => {
      const result = handleCommand(store, "entities")!
      expect(result.text).toContain("### technology")
      expect(result.text).toContain("### concept")
      expect(result.text).toContain("**TypeScript**")
      expect(result.text).toContain("**SQLite**")
      expect(result.text).toContain("**Bun**")
      expect(result.text).toContain("**memory search**")
    })

    test("files shows both indexed files", () => {
      const result = handleCommand(store, "files")!
      expect(result.text).toContain("(2)")
      expect(result.text).toContain("/MEMORY.md")
      expect(result.text).toContain("/docs/notes.md")
      expect(result.text).toContain("4.0KB")
      expect(result.text).toContain("512B")
    })

    test("inspect shows chunk with entities", () => {
      const result = handleCommand(store, "inspect chunk-mem-1")!
      expect(result.text).toContain("**Chunk: `chunk-mem-1`**")
      expect(result.text).toContain("**Entities** (2)")
      expect(result.text).toContain("[technology] TypeScript")
      expect(result.text).toContain("[technology] Bun")
      expect(result.text).toContain("We use TypeScript with Bun runtime")
    })

    test("inspect shows chunk without embedding", () => {
      const result = handleCommand(store, "inspect chunk-no-vec")!
      expect(result.text).toContain("| Has Embedding | no |")
      expect(result.text).toContain("hypothesis")
    })

    test("embeddings shows mixed status", () => {
      const result = handleCommand(store, "embeddings")!
      expect(result.text).toContain("Total chunks: 4")
      expect(result.text).toContain("With embeddings: 3 (75.0%)")
      expect(result.text).toContain("Empty (no vector): 1")
      expect(result.text).toContain("openai/text-embedding-3-small: 3 chunks")
      expect(result.text).toContain("Embedding cache: 1 entries (3 dims)")
    })
  })
})
