/**
 * Markdown Chunking
 *
 * Character-budget, line-oriented text splitter with improvements
 * over OpenClaw's chunkMarkdown():
 *
 * - Preserves heading context by prepending the most recent heading
 *   hierarchy to chunks that don't start with one
 * - SHA-256 hash per chunk for change detection
 * - Overlap carry from tail of previous chunk for continuity
 * - Handles single lines exceeding the budget (never drops content)
 */

const DEFAULT_TOKENS = 400
const DEFAULT_OVERLAP = 80
const CHARS_PER_TOKEN = 4

export type Chunk = {
  text: string
  hash: string
  startLine: number
  endLine: number
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line)
}

function headingDepth(line: string): number {
  const match = line.match(/^(#{1,6})\s/)
  return match ? match[1].length : 0
}

export function chunk(content: string, opts?: { tokens?: number; overlap?: number }): Chunk[] {
  if (!content.trim()) return []

  const budget = (opts?.tokens ?? DEFAULT_TOKENS) * CHARS_PER_TOKEN
  const overlapBudget = (opts?.overlap ?? DEFAULT_OVERLAP) * CHARS_PER_TOKEN
  const lines = content.split("\n")

  const results: Chunk[] = []
  let current: string[] = []
  let currentLen = 0
  let chunkStartLine = 1
  // Track the most recent heading at each depth level
  const headings: string[] = []

  function flush() {
    if (current.length === 0) return
    const raw = current.join("\n")
    if (!raw.trim()) {
      current = []
      currentLen = 0
      return
    }

    // Prepend heading context if the chunk doesn't start with one
    let text = raw
    if (!isHeading(current[0]) && headings.length > 0) {
      const context = headings.filter(Boolean).join("\n")
      if (context) text = context + "\n\n" + raw
    }

    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(text)
    results.push({
      text,
      hash: hasher.digest("hex"),
      startLine: chunkStartLine,
      endLine: chunkStartLine + current.length - 1,
    })

    current = []
    currentLen = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineLen = line.length + 1

    // Update heading context before processing the line
    if (isHeading(line)) {
      const depth = headingDepth(line)
      headings[depth - 1] = line
      headings.length = depth
    }

    // Would this line overflow? Flush first, then start a new chunk.
    // Exception: if current is empty, always accept the line (handles
    // single lines > budget so we never drop content).
    if (current.length > 0 && currentLen + lineLen > budget) {
      // Build overlap from the tail of the chunk we're about to flush
      let overlapLen = 0
      const overlapLines: string[] = []
      for (let j = current.length - 1; j >= 0; j--) {
        const len = current[j].length + 1
        if (overlapLen + len > overlapBudget && overlapLines.length > 0) break
        overlapLines.unshift(current[j])
        overlapLen += len
      }

      flush()

      // Carry overlap into the new chunk
      chunkStartLine = i + 1 - overlapLines.length
      for (const ol of overlapLines) {
        current.push(ol)
        currentLen += ol.length + 1
      }
    }

    // Track start line of the first real line in this chunk
    if (current.length === 0) {
      chunkStartLine = i + 1
    }

    current.push(line)
    currentLen += lineLen
  }

  flush()
  return results
}
