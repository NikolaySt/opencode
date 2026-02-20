/**
 * Memory Tools
 *
 * Plugin tools that agents call to query the memory system:
 *
 * - memory_search: Hybrid semantic + keyword search with composable filters
 * - memory_get: Read specific lines from a memory file
 *
 * Security: memory_get restricts reads to within the project worktree
 * and the memory/ directory to prevent path traversal.
 */

import { z } from "zod"
import path from "path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { Store } from "./store"
import type { EmbeddingProvider } from "./embed"
import type { EntityKind } from "./schema"
import { search } from "./search"

/**
 * Infer the entity kind from a raw entity string.
 * - Contains "/" or known code extension → "path"
 * - PascalCase → "class"
 * - camelCase or snake_case → "function"
 * - Fallback → "technology"
 */
export function inferEntityKind(value: string): EntityKind {
  if (value.includes("/") || /\.\w{1,10}$/.test(value)) return "path"
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(value)) return "class"
  if (/^[a-z]+(?:[A-Z][a-z]+){2,}$/.test(value)) return "function"
  if (/^[a-z]+(?:_[a-z]+){2,}$/.test(value)) return "function"
  return "technology"
}

export function memorySearch(store: Store, provider: EmbeddingProvider): ToolDefinition {
  return tool({
    description:
      "Search project memory for prior decisions, architecture, conventions, and session history. " +
      "Use before answering questions about prior work or project-specific patterns. " +
      "Supports filtering by source, file path, entity, and truth state.",
    args: {
      query: z.string().describe("Natural language search query"),
      maxResults: z.number().optional().describe("Maximum results to return (default: 8)"),
      source: z
        .enum(["memory", "sessions"])
        .optional()
        .describe("Filter by source: 'memory' for knowledge files, 'sessions' for extracted session knowledge"),
      pathGlob: z.string().optional().describe("Filter by file path glob pattern, e.g. '**/src/auth/*'"),
      entity: z.string().optional().describe("Filter by entity name, e.g. 'AuthService', 'Redis', 'src/config.ts'"),
      truthState: z
        .enum(["validated", "candidate", "hypothesis", "deprecated", "disputed"])
        .optional()
        .describe("Filter by knowledge confidence level"),
    },
    async execute(args, _ctx) {
      const results = await search({
        store,
        provider,
        query: args.query,
        options: {
          maxResults: args.maxResults,
          source: args.source,
          pathGlob: args.pathGlob,
          entity: args.entity ? { kind: inferEntityKind(args.entity), value: args.entity } : undefined,
          truthState: args.truthState,
        },
      })

      if (results.length === 0) {
        return "No relevant memory entries found."
      }

      const formatted = results.map((r, i) => {
        const loc = `Source: ${r.path}#L${r.startLine}-L${r.endLine}`
        const score = `Score: ${r.score.toFixed(3)} | State: ${r.truthState}`
        return `### Result ${i + 1}\n${loc}\n${score}\n\n${r.text}`
      })

      return formatted.join("\n\n---\n\n")
    },
  })
}

export function memoryGet(worktree: string): ToolDefinition {
  return tool({
    description:
      "Read specific lines from a memory file. Use after memory_search to fetch full context for a relevant snippet.",
    args: {
      path: z.string().describe("Path to the memory file (absolute or relative to project root)"),
      from: z.number().optional().describe("Starting line number (1-indexed, default: 1)"),
      lines: z.number().optional().describe("Number of lines to read (default: 50)"),
    },
    async execute(args, _ctx) {
      const filepath = path.isAbsolute(args.path) ? args.path : path.resolve(worktree, args.path)
      const resolved = path.resolve(filepath)

      // Security: restrict reads to within the worktree
      const normalWorktree = path.resolve(worktree)
      if (!resolved.startsWith(normalWorktree + path.sep) && resolved !== normalWorktree) {
        return `Access denied: ${args.path} is outside the project directory.`
      }

      const file = Bun.file(resolved)
      const exists = await file.exists()
      if (!exists) return `File not found: ${args.path}`

      const content = await file.text()
      const allLines = content.split("\n")
      const from = Math.max(1, args.from ?? 1)
      const count = Math.min(Math.max(1, args.lines ?? 50), 200)
      const slice = allLines.slice(from - 1, from - 1 + count)

      const numbered = slice.map((line, i) => `${from + i}: ${line}`).join("\n")
      return `File: ${args.path} (lines ${from}-${from + slice.length - 1} of ${allLines.length})\n\n${numbered}`
    },
  })
}
