import { describe, expect, test } from "bun:test"
import { chunk } from "../../src/memory/chunk"

describe("memory.chunk", () => {
  test("empty content returns no chunks", () => {
    expect(chunk("")).toEqual([])
    expect(chunk("   \n  ")).toEqual([])
  })

  test("single short paragraph produces one chunk", () => {
    const result = chunk("Hello world\nThis is a test")
    expect(result).toHaveLength(1)
    expect(result[0].text).toContain("Hello world")
    expect(result[0].startLine).toBe(1)
    expect(result[0].endLine).toBe(2)
    expect(result[0].hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("each chunk gets a unique sha256 hash", () => {
    const result = chunk("line a\nline b")
    expect(result[0].hash).toMatch(/^[0-9a-f]{64}$/)
    const result2 = chunk("different content")
    expect(result2[0].hash).not.toBe(result[0].hash)
  })

  test("identical content produces identical hash", () => {
    const a = chunk("same content here")
    const b = chunk("same content here")
    expect(a[0].hash).toBe(b[0].hash)
  })

  test("splits long content into multiple chunks", () => {
    // tokens=10 => budget = 40 chars, each line ~20 chars
    const lines = Array.from({ length: 10 }, (_, i) => `This is line number ${i}`)
    const result = chunk(lines.join("\n"), { tokens: 10, overlap: 0 })
    expect(result.length).toBeGreaterThanOrEqual(4) // 10 lines × ~21 chars each / 40 char budget
    // Verify no content is lost — all lines appear in some chunk
    const allText = result.map((c) => c.text).join("\n")
    for (const line of lines) {
      expect(allText).toContain(line)
    }
  })

  test("preserves heading context in subsequent chunks", () => {
    const content = [
      "# Main Heading",
      "",
      "Some introductory text that fills up the first chunk.",
      "",
      "More text that goes into a second chunk because we use a small token budget.",
      "And even more text to fill the budget completely beyond the limit.",
      "Extra line to force the split over the budget boundary here.",
    ].join("\n")

    const result = chunk(content, { tokens: 20, overlap: 0 })
    expect(result.length).toBeGreaterThan(1)
    // The first chunk should start with the heading
    expect(result[0].text).toContain("# Main Heading")
    // Second chunk: if it doesn't organically start with # heading,
    // the chunker must have prepended the heading as context
    expect(result[1].text).toContain("# Main Heading")
  })

  test("heading hierarchy is maintained across depths", () => {
    const content = [
      "# Top Level",
      "## Sub Level",
      "Some text under sub level",
      "More text under sub level to fill up",
      "Even more text to go past the budget boundary now",
      "And additional content that forces a new chunk split",
    ].join("\n")

    const result = chunk(content, { tokens: 15, overlap: 0 })
    expect(result.length).toBeGreaterThan(1)
    // First chunk must contain both headings
    expect(result[0].text).toContain("# Top Level")
    expect(result[0].text).toContain("## Sub Level")
    // Later chunks must include heading context
    for (const c of result.slice(1)) {
      // Every later chunk should contain "# Top Level" (either prepended or organic)
      expect(c.text).toContain("# Top Level")
    }
  })

  test("overlap carries lines from previous chunk", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`)
    const content = lines.join("\n")
    const result = chunk(content, { tokens: 15, overlap: 5 })
    // With 20 lines at ~7 chars each and budget of 60 chars, we should get multiple chunks
    expect(result.length).toBeGreaterThanOrEqual(3) // 20 lines × ~7 chars / 60 budget + overlap

    // Last lines of chunk 0 should appear at the start of chunk 1
    const c0lines = result[0].text.split("\n").filter((l) => l.startsWith("Line "))
    const c1lines = result[1].text.split("\n").filter((l) => l.startsWith("Line "))
    // Overlap lines from the end of c0 must appear at the beginning of c1
    const tail = c0lines.slice(-5)
    const head = c1lines.slice(0, 6)
    const overlap = tail.filter((l) => head.includes(l))
    expect(overlap.length).toBeGreaterThanOrEqual(2)
    // Verify overlap creates more shared lines than no-overlap
    const noOverlapResult = chunk(content, { tokens: 15, overlap: 0 })
    const nc0 = noOverlapResult[0].text.split("\n").filter((l) => l.startsWith("Line "))
    const nc1 = noOverlapResult[1].text.split("\n").filter((l) => l.startsWith("Line "))
    const noOverlapCount = nc0.filter((l) => nc1.includes(l)).length
    expect(overlap.length).toBeGreaterThan(noOverlapCount)
  })

  test("single line exceeding budget is not dropped", () => {
    const longLine = "x".repeat(2000)
    const result = chunk(longLine, { tokens: 10 })
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe(longLine)
  })

  test("line numbers are 1-indexed", () => {
    const result = chunk("first\nsecond\nthird")
    expect(result[0].startLine).toBe(1)
    expect(result[0].endLine).toBe(3)
  })

  test("custom token and overlap options", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Content line ${i}`)
    const small = chunk(lines.join("\n"), { tokens: 5, overlap: 0 })
    const large = chunk(lines.join("\n"), { tokens: 100, overlap: 0 })
    // Smaller budget should produce more chunks
    expect(small.length).toBeGreaterThan(large.length)
    // Verify concrete expectations: 50 lines × ~15 chars
    // tokens=5 → budget=20 chars → ~50 chunks; tokens=100 → budget=400 chars → ~2 chunks
    expect(small.length).toBeGreaterThanOrEqual(10)
    expect(large.length).toBeLessThanOrEqual(10)
  })

  test("whitespace-only lines do not produce chunks", () => {
    const result = chunk("   \n\t\n  \n")
    expect(result).toEqual([])
  })

  test("trailing newlines do not create empty trailing chunk", () => {
    const result = chunk("Hello world\n\n\n")
    expect(result).toHaveLength(1)
    // Text should be trimmed
    expect(result[0].text.trim()).toBe("Hello world")
  })

  test("mixed whitespace and content produces correct chunks", () => {
    const content = "\n\n\nActual content\n\n\n"
    const result = chunk(content)
    expect(result).toHaveLength(1)
    expect(result[0].text).toContain("Actual content")
  })

  test("deeper heading replaces shallower in hierarchy", () => {
    const content = [
      "# H1",
      "## H2",
      "### H3",
      "Text under H3 that will fill the chunk nicely here",
      "## New H2",
      "Text under New H2 that forces a split after this",
      "And more text to make the chunk overflow its budget",
      "Even more text to ensure we definitely get multiple chunks",
      "Yet another line to really force chunk boundaries now please",
    ].join("\n")

    const result = chunk(content, { tokens: 8, overlap: 0 })
    expect(result.length).toBeGreaterThan(2)

    // Core invariant: NO chunk that contains text from the "## New H2" section
    // should have "### H3" in its heading context. The ## New H2 heading
    // should replace ## H2 and clear ### H3.
    const newH2ChunkIdx = result.findIndex((c) => c.text.includes("New H2"))
    expect(newH2ChunkIdx).toBeGreaterThanOrEqual(0)

    // Check all chunks from the New H2 point onward
    for (let i = newH2ChunkIdx; i < result.length; i++) {
      expect(result[i].text).not.toContain("### H3")
    }
  })
})
