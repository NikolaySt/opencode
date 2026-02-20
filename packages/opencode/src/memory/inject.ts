/**
 * Context Injection
 *
 * Builds the memory context packet injected at agent start via
 * the `agent.start` hook's `prependContext` return value.
 *
 * Priority-based injection with budget allocation:
 *   P1 (30%): MEMORY.md project invariants
 *   P2 (40%): Relevant search results using session query
 *   P3 (20%): Recent validated/candidate summaries
 *   P4 (10%): Entity-matched context
 *
 * Budget overflow from one priority flows to the next.
 * Truncation happens at section boundaries, never mid-content.
 *
 * Context-aware scaling:
 *   When the caller provides contextLimit + usedTokens, the injection
 *   budget is dynamically clamped so memory never pushes the prompt
 *   over the model's context window.  When the remaining budget is
 *   tight (< 50% of configured maxTokens), a compressed mode kicks in
 *   that emits fewer, shorter items.  When remaining budget is below
 *   MIN_INJECTION_TOKENS the injection is skipped entirely.
 */

import path from "path"
import { Log } from "../util/log"
import type { Store } from "./store"
import type { EmbeddingProvider } from "./embed"
import { search } from "./search"
import { extractRegex } from "./entity"
import * as Metrics from "./metrics"

const log = Log.create({ service: "memory.inject" })

const CHARS_PER_TOKEN = 4

/** Normal-mode limits */
const SUMMARY_LIMIT = 5
const SEARCH_LIMIT = 5
const ENTITY_SEARCH_LIMIT = 3
const SNIPPET_LEN = 300
const SUMMARY_FIRST_LINE = 200

/** Compressed-mode limits */
const COMPRESSED_SEARCH_LIMIT = 2
const COMPRESSED_SUMMARY_LIMIT = 2
const COMPRESSED_SNIPPET_LEN = 100
const COMPRESSED_SUMMARY_FIRST_LINE = 100

/**
 * Tokens reserved as a safety margin between memory injection and the
 * model's context ceiling.  Covers output tokens, system prompt overhead,
 * and other plugins that may also inject content.
 */
const SAFETY_MARGIN_TOKENS = 5000

/**
 * Below this many available tokens, injection is skipped entirely —
 * injecting a tiny fragment has negative value (noise vs. signal).
 */
const MIN_INJECTION_TOKENS = 200

/**
 * When the effective budget drops below this fraction of the configured
 * maxTokens, switch to compressed mode with fewer, shorter items.
 */
const COMPRESSED_THRESHOLD = 0.5

/**
 * Build a section that fits within a character budget.
 * Returns the section text and the number of chars used.
 */
function fitSection(header: string, items: string[], budget: number): { text: string; used: number } {
  if (items.length === 0 || budget <= header.length + 4) return { text: "", used: 0 }

  const lines: string[] = []
  let used = header.length + 2 // header + newlines
  for (const item of items) {
    const cost = item.length + 1
    if (used + cost > budget && lines.length > 0) break
    lines.push(item)
    used += cost
  }
  if (lines.length === 0) return { text: "", used: 0 }
  const text = `${header}\n\n${lines.join("\n")}`
  return { text, used: text.length }
}

export type BuildParams = {
  store: Store
  provider: EmbeddingProvider
  worktree: string
  projectID: string
  maxTokens: number
  query?: string
  /** Model context window size in tokens (e.g. 200000). Optional. */
  contextLimit?: number
  /** Tokens already consumed by the current session. Optional. */
  usedTokens?: number
}

/**
 * Compute the effective token budget for injection.
 *
 * When contextLimit and usedTokens are both provided the budget is
 * clamped so memory + the safety margin fits within the remaining
 * context window.  Returns `undefined` when the budget is too small
 * to produce useful context (< MIN_INJECTION_TOKENS).
 */
export function effectiveBudget(params: {
  maxTokens: number
  contextLimit?: number
  usedTokens?: number
}): { tokens: number; compressed: boolean } | undefined {
  // No context awareness — use configured max
  if (!params.contextLimit || params.contextLimit === 0) return { tokens: params.maxTokens, compressed: false }
  // No usage data — first turn, context is nearly empty
  if (params.usedTokens === undefined) return { tokens: params.maxTokens, compressed: false }

  const available = params.contextLimit - params.usedTokens - SAFETY_MARGIN_TOKENS
  if (available < MIN_INJECTION_TOKENS) return undefined

  const clamped = Math.min(params.maxTokens, available)
  const compressed = clamped < params.maxTokens * COMPRESSED_THRESHOLD
  return { tokens: clamped, compressed }
}

export async function build(params: BuildParams): Promise<string | undefined> {
  const budget = effectiveBudget(params)
  if (!budget) {
    log.info("injection skipped: context budget too tight", {
      contextLimit: params.contextLimit,
      usedTokens: params.usedTokens,
    })
    Metrics.record("injections")
    Metrics.record("injectionSkippedOverflow")
    return undefined
  }

  if (budget.tokens < params.maxTokens) {
    log.info("injection budget scaled", {
      configured: params.maxTokens,
      effective: budget.tokens,
      compressed: budget.compressed,
    })
    Metrics.record("injectionBudgetScaled")
  }

  const searchLimit = budget.compressed ? COMPRESSED_SEARCH_LIMIT : SEARCH_LIMIT
  const summaryLimit = budget.compressed ? COMPRESSED_SUMMARY_LIMIT : SUMMARY_LIMIT
  const snippetLen = budget.compressed ? COMPRESSED_SNIPPET_LEN : SNIPPET_LEN
  const summaryFirstLine = budget.compressed ? COMPRESSED_SUMMARY_FIRST_LINE : SUMMARY_FIRST_LINE

  const totalBudget = budget.tokens * CHARS_PER_TOKEN
  let remaining = totalBudget
  const sections: string[] = []

  // P1 (30%): MEMORY.md project invariants
  const p1Budget = Math.floor(totalBudget * 0.3)
  for (const name of ["MEMORY.md", "memory.md"]) {
    const filepath = path.join(params.worktree, name)
    const file = Bun.file(filepath)
    if (await file.exists()) {
      const content = await file.text()
      const p1Limit = budget.compressed ? Math.min(p1Budget, 800) : p1Budget
      // Take content up to the first ## heading or p1Limit, whichever is shorter
      const firstH2 = content.indexOf("\n## ")
      const slice = firstH2 > 0 ? content.slice(0, firstH2) : content.slice(0, p1Limit)
      const trimmed = slice.trim()
      if (trimmed) {
        const section = `### Key Knowledge\n\n${trimmed}`
        if (section.length <= remaining) {
          sections.push(section)
          remaining -= section.length
        } else if (remaining > 25) {
          const truncated = section.slice(0, remaining - 25) + "\n\n[...truncated]"
          sections.push(truncated)
          remaining = 0
        } else {
          sections.push(section.slice(0, remaining))
          remaining = 0
        }
      }
      break
    }
  }

  // P2 (40%): Relevant search results using query
  if (remaining > 0 && params.query) {
    const p2Budget = Math.min(Math.floor(totalBudget * 0.4), remaining)
    try {
      const results = await search({
        store: params.store,
        provider: params.provider,
        query: params.query,
        options: { maxResults: searchLimit, minScore: 0.25 },
      })
      if (results.length > 0) {
        const items = results.map((r) => {
          const snippet = r.text.slice(0, snippetLen).replace(/\n/g, " ")
          return `- [${r.path}#L${r.startLine}] (${r.truthState}) ${snippet}`
        })
        const { text, used } = fitSection("### Relevant Context", items, p2Budget)
        if (text) {
          sections.push(text)
          remaining -= used
        }
      }
    } catch (err) {
      log.warn("injection search failed", { error: String(err) })
    }
  }

  // P3 (20%): Recent validated/candidate summaries
  if (remaining > 0) {
    const p3Budget = Math.min(Math.floor(totalBudget * 0.2), remaining)
    const summaries = params.store.recentSummaries(params.projectID, summaryLimit)
    if (summaries.length > 0) {
      const items = summaries.map((s) => {
        const date = new Date(s.created_at).toISOString().slice(0, 10)
        const first = s.content.split("\n")[0] ?? s.content
        return `- [${date}] ${first.slice(0, summaryFirstLine)}`
      })
      const { text, used } = fitSection("### Recent Sessions", items, p3Budget)
      if (text) {
        sections.push(text)
        remaining -= used
      }
    }
  }

  // P4 (10%): Entity-matched context from query (skipped in compressed mode)
  if (remaining > 0 && params.query && !budget.compressed) {
    const p4Budget = Math.min(Math.floor(totalBudget * 0.1), remaining)
    const queryEntities = extractRegex(params.query)
    if (queryEntities.length > 0) {
      const items: string[] = []
      const seen = new Set<string>()
      for (const entity of queryEntities.slice(0, 3)) {
        const chunks = params.store.searchByEntity(entity.kind, entity.value, ENTITY_SEARCH_LIMIT)
        for (const c of chunks) {
          if (seen.has(c.id)) continue
          seen.add(c.id)
          const snippet = c.text.slice(0, 200).replace(/\n/g, " ")
          items.push(`- [${entity.kind}:${entity.value}] ${snippet}`)
        }
      }
      if (items.length > 0) {
        const { text, used } = fitSection("### Related Entities", items, p4Budget)
        if (text) {
          sections.push(text)
          remaining -= used
        }
      }
    }
  }

  Metrics.record("injections")
  if (sections.length === 0) {
    Metrics.record("injectionMisses")
    return undefined
  }

  const result = `## Project Memory\n\n${sections.join("\n\n")}`
  Metrics.record("injectionHits")
  Metrics.record("injectionChars", result.length)
  return result
}
