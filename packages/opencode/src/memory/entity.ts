/**
 * Entity Extraction
 *
 * Extracts structured entities from text for searchable tagging.
 * Two modes:
 *
 * - "regex": Fast, zero-cost regex patterns for file paths, identifiers,
 *   and technology keywords. Good enough for most cases.
 *
 * - "llm": Uses a configurable LLM to extract structured entities
 *   (concepts, decisions, file references). Higher quality, costs tokens.
 *
 * Extracted entities are stored in the entities table and enable
 * structured search (e.g., "what do we know about Redis?" or
 * "changes to src/auth/").
 */

import { Log } from "../util/log"
import type { EntityKind } from "./schema"

const log = Log.create({ service: "memory.entity" })

export type Entity = {
  kind: EntityKind
  value: string
}

// =========================================================================
// Regex patterns
// =========================================================================

/** Match file paths like src/auth/handler.ts, ./config.json, /etc/nginx.conf */
const PATH_PATTERN = /(?:^|\s|['"`(])([a-zA-Z0-9_./-]{2,}(?:\.[a-zA-Z]{1,10}))/g

/** Match PascalCase identifiers (class/component names) like AuthService, UserController */
const PASCAL_PATTERN = /\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,})\b/g

/** Match camelCase identifiers like getUserById, handleAuthError */
const CAMEL_PATTERN = /\b([a-z]+(?:[A-Z][a-z]+){2,})\b/g

/** Match snake_case identifiers like get_user_by_id (3+ segments to reduce noise) */
const SNAKE_PATTERN = /\b([a-z]+(?:_[a-z]+){2,})\b/g

// =========================================================================
// Noise filtering
// =========================================================================

/** Common technical suffixes that indicate a PascalCase name is a class/component, not a person */
const TECH_SUFFIXES = new Set([
  "Service",
  "Controller",
  "Handler",
  "Manager",
  "Factory",
  "Provider",
  "Builder",
  "Adapter",
  "Module",
  "Component",
  "Plugin",
  "Client",
  "Server",
  "Router",
  "Store",
  "State",
  "Context",
  "Hook",
  "Test",
  "Spec",
  "Mock",
  "Error",
  "Exception",
  "Event",
  "Type",
  "Schema",
  "Model",
  "View",
  "Worker",
  "Config",
  "Helper",
  "Util",
  "Base",
  "Interface",
  "Abstract",
  "Impl",
  "Proxy",
  "Wrapper",
  "Listener",
  "Middleware",
  "Guard",
  "Pipe",
  "Filter",
  "Resolver",
  "Interceptor",
  "Decorator",
  "Mixin",
  "Trait",
  "Enum",
  "Iterator",
  "Stream",
  "Buffer",
  "Cache",
  "Queue",
  "Stack",
  "Pool",
  "Registry",
  "Index",
  "Loader",
  "Parser",
  "Formatter",
  "Validator",
  "Serializer",
])

/**
 * Detect PascalCase values that are likely proper names (e.g. NikolayStoychev)
 * rather than technical identifiers (e.g. AuthService).
 *
 * Heuristic: exactly 2 segments, both 3+ chars, neither is a known tech suffix.
 */
function isLikelyProperName(value: string): boolean {
  const parts = value.match(/[A-Z][a-z]+/g)
  if (!parts || parts.length !== 2) return false
  if (parts.some((p) => p.length < 3)) return false
  if (parts.some((p) => TECH_SUFFIXES.has(p))) return false
  return true
}

/** Technology keywords — curated list of commonly referenced technologies */
const TECH_KEYWORDS = new Set([
  // Languages
  "typescript",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
  "ruby",
  "swift",
  "kotlin",
  "c++",
  "csharp",
  // Runtimes
  "node",
  "nodejs",
  "bun",
  "deno",
  "jvm",
  // Frameworks
  "react",
  "nextjs",
  "vue",
  "angular",
  "svelte",
  "express",
  "fastify",
  "hono",
  "django",
  "flask",
  "rails",
  "spring",
  "solidjs",
  "astro",
  // Databases
  "postgresql",
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "dynamodb",
  "supabase",
  "drizzle",
  "prisma",
  // Infrastructure
  "docker",
  "kubernetes",
  "k8s",
  "aws",
  "gcp",
  "azure",
  "vercel",
  "cloudflare",
  "nginx",
  "terraform",
  // Tools
  "git",
  "github",
  "gitlab",
  "webpack",
  "vite",
  "esbuild",
  "eslint",
  "prettier",
  "jest",
  "vitest",
  "playwright",
  "cypress",
  // Protocols
  "graphql",
  "grpc",
  "rest",
  "websocket",
  "oauth",
  "jwt",
  "openapi",
  // AI
  "openai",
  "anthropic",
  "gemini",
  "embeddings",
  "rag",
  "llm",
])

function unique(entities: Entity[]): Entity[] {
  const seen = new Set<string>()
  return entities.filter((e) => {
    const key = `${e.kind}:${e.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Extract entities using regex patterns. Fast, zero API cost.
 *
 * Pass an optional `ignored` set to exclude specific entity values
 * (e.g. usernames configured in `extraction.ignoredEntities`).
 */
export function extractRegex(text: string, ignored?: Set<string>): Entity[] {
  const entities: Entity[] = []
  const lower = text.toLowerCase()

  // File paths
  for (const match of text.matchAll(PATH_PATTERN)) {
    const value = match[1]
    // Filter noise: must contain at least one slash or be a known extension
    if (value.includes("/") || /\.(ts|js|tsx|jsx|py|rs|go|md|json|yaml|yml|toml|sql|sh)$/.test(value)) {
      entities.push({ kind: "path", value })
    }
  }

  // PascalCase identifiers
  for (const match of text.matchAll(PASCAL_PATTERN)) {
    const value = match[1]
    if (isLikelyProperName(value)) continue
    entities.push({ kind: "class", value })
  }

  // camelCase identifiers (only if 3+ segments to reduce noise)
  for (const match of text.matchAll(CAMEL_PATTERN)) {
    entities.push({ kind: "function", value: match[1] })
  }

  // snake_case identifiers
  for (const match of text.matchAll(SNAKE_PATTERN)) {
    entities.push({ kind: "function", value: match[1] })
  }

  // Technology keywords
  const words = lower.split(/[\s,;:.()[\]{}'"\/]+/)
  for (const word of words) {
    if (TECH_KEYWORDS.has(word)) {
      entities.push({ kind: "technology", value: word })
    }
  }

  const deduped = unique(entities)
  if (!ignored || ignored.size === 0) return deduped
  const blocked = new Set([...ignored].map((v) => v.toLowerCase()))
  return deduped.filter((e) => !blocked.has(e.value.toLowerCase()))
}

/**
 * Build the LLM extraction prompt.
 */
export const ENTITY_EXTRACTION_PROMPT = `Extract structured entities from the following text. Return a JSON array where each item has "kind" and "value".

Kinds:
- "path": file paths, directory paths, module paths
- "function": function names, method names
- "class": class names, component names, type names
- "technology": libraries, frameworks, databases, protocols, tools
- "concept": architecture decisions, design patterns, conventions

Rules:
- Only extract entities that are specifically mentioned or discussed
- For paths, use the exact path as written
- For concepts, use short descriptive phrases (3-6 words)
- Return at most 20 entities
- Return [] if no meaningful entities found

Text:
`

/**
 * Extract entities using an LLM call. Higher quality, costs tokens.
 *
 * The caller provides a generate function so this module doesn't
 * depend on the provider system directly.
 */
export async function extractLLM(text: string, generate: (prompt: string) => Promise<string>): Promise<Entity[]> {
  try {
    const response = await generate(ENTITY_EXTRACTION_PROMPT + text)
    // Parse JSON from the response — handle markdown code blocks
    const cleaned = response
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    const entities: Entity[] = []
    for (const item of parsed) {
      if (!item.kind || !item.value) continue
      const kind = item.kind as string
      if (!["path", "function", "class", "technology", "concept"].includes(kind)) continue
      entities.push({ kind: kind as EntityKind, value: String(item.value) })
    }
    return unique(entities)
  } catch (err) {
    log.warn("LLM entity extraction failed, falling back to regex", { error: String(err) })
    return extractRegex(text)
  }
}

/**
 * Extract entities using the configured mode.
 */
export async function extract(
  text: string,
  mode: "regex" | "llm",
  generate?: (prompt: string) => Promise<string>,
  ignored?: Set<string>,
): Promise<Entity[]> {
  if (mode === "llm" && generate) {
    const entities = await extractLLM(text, generate)
    if (!ignored || ignored.size === 0) return entities
    const blocked = new Set([...ignored].map((v) => v.toLowerCase()))
    return entities.filter((e) => !blocked.has(e.value.toLowerCase()))
  }
  return extractRegex(text, ignored)
}
