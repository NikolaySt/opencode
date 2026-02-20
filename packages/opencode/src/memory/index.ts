/**
 * Memory Plugin
 *
 * Built-in plugin that fills the exclusive "memory" slot.
 * Provides persistent cross-session memory via:
 *
 * - MEMORY.md / memory/ knowledge files (indexed with embeddings)
 * - Session summary extraction and indexing (LLM or title mode)
 * - Hybrid search (vector + keyword) tools for agents
 * - Automatic context injection at agent start
 * - File watching for live re-indexing
 * - Maintenance: staleness detection, TTL, contradiction detection,
 *   model migration, orphan cleanup
 *
 * Architecture: Uses bun:sqlite for storage, OpenAI for embeddings,
 * and the plugin API for hooks, tools, services, and cron.
 *
 * IMPORTANT: register() must return quickly to avoid blocking server
 * bootstrap. All network I/O (initial sync, LLM model resolution) is
 * deferred to background tasks or lazy initialization.
 *
 * This is an internal built-in plugin — it imports Instance directly
 * to access worktree and project ID, matching the codebase convention.
 */

import { generateText } from "ai"
import type { PluginApi } from "../plugin/registry"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { Log } from "../util/log"
import * as MemoryStore from "./store"
import * as MemoryConfig from "./config"
import * as Embed from "./embed"
import * as Sync from "./sync"
import * as Watcher from "./watcher"
import * as Inject from "./inject"
import * as Maintain from "./maintain"
import { extract } from "./extract"
import { detectContradictions } from "./maintain"
import { memorySearch, memoryGet } from "./tools"
import * as Metrics from "./metrics"

// Ensure OpenAI provider is registered
import "./embed-openai"

const log = Log.create({ service: "memory" })

/** Timeout for operations that should not block startup (ms) */
const INIT_TIMEOUT = 15_000

/** Cooldown between extractions for the same session (ms) */
const EXTRACTION_COOLDOWN = 5 * 60 * 1000

/** Minimum message count before extraction is worthwhile */
const MIN_MESSAGES_FOR_EXTRACTION = 2

/** Run full maintenance every N extractions */
const MAINTENANCE_EVERY = 5

export const definition = {
  id: "opencode-memory",
  name: "Memory",
  description: "Built-in persistent memory across sessions",
  version: "0.2.0",
  kind: "memory" as const,
}

/**
 * Race a promise against a timeout. Returns undefined on timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) =>
      setTimeout(() => {
        log.warn("operation timed out", { label, ms })
        resolve(undefined)
      }, ms),
    ),
  ])
}

/**
 * Resolve the LLM model for memory operations.
 *
 * 3-tier fallback:
 * 1. Plugin config model (e.g. "anthropic/claude-haiku-4-5")
 * 2. Global small_model / Provider.getSmallModel
 * 3. Provider.defaultModel
 */
async function resolveModel(config: MemoryConfig.ResolvedConfig) {
  log.debug("resolveModel: starting 3-tier resolution", { configModel: config.model ?? "none" })

  // Tier 1: explicit plugin config
  if (config.model) {
    const parsed = Provider.parseModel(config.model)
    log.debug("resolveModel: tier 1 — trying plugin config model", {
      provider: parsed.providerID,
      model: parsed.modelID,
    })
    try {
      const model = await Provider.getModel(parsed.providerID, parsed.modelID)
      log.debug("resolveModel: tier 1 resolved", { provider: parsed.providerID, model: parsed.modelID })
      return model
    } catch (err) {
      log.warn("resolveModel: tier 1 failed, configured model not found", { model: config.model, error: String(err) })
    }
  }

  // Tier 2: global small_model
  log.debug("resolveModel: tier 2 — trying Provider.getSmallModel")
  try {
    const defaultModel = await Provider.defaultModel()
    log.debug("resolveModel: tier 2 — default model resolved", { provider: defaultModel.providerID })
    const small = await Provider.getSmallModel(defaultModel.providerID)
    if (small) {
      log.debug("resolveModel: tier 2 resolved small model")
      return small
    }
    log.debug("resolveModel: tier 2 — no small model available")
  } catch (err) {
    log.debug("resolveModel: tier 2 failed", { error: String(err) })
  }

  // Tier 3: default model
  log.debug("resolveModel: tier 3 — trying Provider.defaultModel")
  try {
    const dm = await Provider.defaultModel()
    const model = await Provider.getModel(dm.providerID, dm.modelID)
    log.debug("resolveModel: tier 3 resolved", { provider: dm.providerID, model: dm.modelID })
    return model
  } catch (err) {
    log.debug("resolveModel: tier 3 failed, no model available", { error: String(err) })
    return undefined
  }
}

/**
 * Create a generate function for LLM extraction/entity calls.
 * Returns undefined if no model is available.
 */
async function createGenerate(config: MemoryConfig.ResolvedConfig) {
  log.debug("createGenerate: resolving model")
  const model = await resolveModel(config)
  if (!model) {
    log.debug("createGenerate: no model available, returning undefined")
    return undefined
  }

  log.debug("createGenerate: getting language model interface", {
    providerID: model.providerID,
    model: model.id,
  })
  const language = await Provider.getLanguage(model)
  log.debug("createGenerate: ready", { providerID: model.providerID, model: model.id })

  return async (prompt: string): Promise<string> => {
    log.debug("generate: calling LLM", {
      promptLength: prompt.length,
      providerID: model.providerID,
      model: model.id,
    })
    const result = await generateText({
      model: language,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxOutputTokens: 2000,
    })
    log.debug("generate: LLM response received", {
      responseLength: result.text.length,
      finishReason: result.finishReason,
      providerID: model.providerID,
      model: model.id,
    })
    return result.text
  }
}

/**
 * Read the first user message from a session to use as the injection query.
 */
async function firstUserMessage(sessionID: string): Promise<string | undefined> {
  try {
    const msgs = await Session.messages({ sessionID, limit: 5 })
    // msgs is oldest-first after reverse in Session.messages
    for (const msg of msgs) {
      if (msg.info.role === "user") {
        // Extract text content from parts
        for (const part of msg.parts) {
          if (part.type === "text") return part.text
        }
      }
    }
  } catch {
    // Session might not be accessible
  }
  return undefined
}

/**
 * Per-session extraction state tracking.
 */
type ExtractionState = {
  extractedAt: number
  messageCount: number
}

/**
 * Handle browse/inspect subcommands for `/memory`.
 * Exported so tests can call it directly without the full PluginApi.
 * Returns `{ text }` if the args matched a subcommand, or `null` if not handled.
 */
export function handleCommand(store: MemoryStore.Store, args: string): { text: string } | null {
  // ---------------------------------------------------------------
  // /memory chunks [source=X] [truth=X] [limit=N]
  // ---------------------------------------------------------------
  if (args === "chunks" || args.startsWith("chunks ")) {
    const rest = args.slice("chunks".length).trim()
    const params: { source?: string; truthState?: string; limit: number } = { limit: 25 }
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      const [key, val] = token.split("=")
      if (key === "source" && val) params.source = val
      if (key === "truth" && val) params.truthState = val
      if (key === "limit" && val) params.limit = Math.min(parseInt(val, 10) || 25, 100)
    }
    const filter: Record<string, unknown> = {}
    if (params.source) filter.source = params.source
    if (params.truthState) filter.truthState = params.truthState
    const chunks = store.chunksByFilter(filter as any).slice(0, params.limit)
    if (chunks.length === 0) return { text: "No chunks found." }
    const lines = [
      `**Memory Chunks** (${chunks.length} shown)`,
      "",
      "| ID (8) | Source | Path | Truth | Embed | Model | Text |",
      "|--------|--------|------|-------|-------|-------|------|",
    ]
    for (const c of chunks) {
      const hasEmbed = c.embedding && c.embedding.byteLength > 0 ? "yes" : "no"
      const model = c.embedding_model || "-"
      const snippet = c.text.slice(0, 60).replace(/\n/g, " ").replace(/\|/g, "\\|")
      lines.push(
        `| \`${c.id.slice(0, 8)}\` | ${c.source} | ${c.path.split("/").pop() || c.path} | ${c.truth_state} | ${hasEmbed} | ${model.split("/").pop() || model} | ${snippet} |`,
      )
    }
    lines.push("", "Use `/memory inspect <id>` for full details.")
    return { text: lines.join("\n") }
  }

  // ---------------------------------------------------------------
  // /memory summaries
  // ---------------------------------------------------------------
  if (args === "summaries" || args.startsWith("summaries ")) {
    const rest = args.slice("summaries".length).trim()
    const limit = rest ? Math.min(parseInt(rest, 10) || 30, 100) : 30
    const summaries = store.allSummaries(limit)
    if (summaries.length === 0) return { text: "No session summaries found." }
    const lines = [
      `**Session Summaries** (${summaries.length} shown)`,
      "",
      "| ID (8) | Session (8) | Truth | Created | Content |",
      "|--------|-------------|-------|---------|---------|",
    ]
    for (const s of summaries) {
      const date = new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ")
      const snippet = s.content.slice(0, 80).replace(/\n/g, " ").replace(/\|/g, "\\|")
      lines.push(
        `| \`${s.id.slice(0, 8)}\` | \`${s.session_id.slice(0, 8)}\` | ${s.truth_state} | ${date} | ${snippet} |`,
      )
    }
    return { text: lines.join("\n") }
  }

  // ---------------------------------------------------------------
  // /memory entities [kind=X] [limit=N]
  // ---------------------------------------------------------------
  if (args === "entities" || args.startsWith("entities ")) {
    const rest = args.slice("entities".length).trim()
    let kind: string | undefined
    let limit = 100
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      const [key, val] = token.split("=")
      if (key === "kind" && val) kind = val
      if (key === "limit" && val) limit = Math.min(parseInt(val, 10) || 100, 500)
    }
    const entities = store.allEntities(limit, kind as any)
    if (entities.length === 0) return { text: "No entity tags found." }
    // Group by kind
    const grouped: Record<string, Array<{ value: string; path: string; chunk_id: string }>> = {}
    for (const e of entities) {
      if (!grouped[e.kind]) grouped[e.kind] = []
      grouped[e.kind].push({ value: e.value, path: e.path, chunk_id: e.chunk_id })
    }
    const lines = [`**Entity Tags** (${entities.length} shown)`, ""]
    for (const [k, items] of Object.entries(grouped)) {
      lines.push(`### ${k} (${items.length})`)
      // Deduplicate by value, show count
      const counts: Record<string, number> = {}
      for (const item of items) counts[item.value] = (counts[item.value] || 0) + 1
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
      for (const [val, count] of sorted.slice(0, 30)) {
        lines.push(`- **${val}** (${count} chunk${count > 1 ? "s" : ""})`)
      }
      if (sorted.length > 30) lines.push(`- ...and ${sorted.length - 30} more`)
      lines.push("")
    }
    return { text: lines.join("\n") }
  }

  // ---------------------------------------------------------------
  // /memory files
  // ---------------------------------------------------------------
  if (args === "files") {
    const files = store.allFiles()
    if (files.length === 0) return { text: "No indexed files found." }
    const lines = [
      `**Indexed Files** (${files.length})`,
      "",
      "| Path | Source | Hash (8) | Modified | Size |",
      "|------|--------|----------|----------|------|",
    ]
    for (const f of files) {
      const date = new Date(f.mtime).toISOString().slice(0, 16).replace("T", " ")
      const size = f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`
      lines.push(`| ${f.path} | ${f.source} | \`${f.hash.slice(0, 8)}\` | ${date} | ${size} |`)
    }
    return { text: lines.join("\n") }
  }

  // ---------------------------------------------------------------
  // /memory inspect <id>
  // ---------------------------------------------------------------
  if (args.startsWith("inspect ")) {
    const id = args.slice("inspect ".length).trim()
    if (!id) return { text: "Usage: `/memory inspect <chunk-id>`" }
    // Try full ID first, then prefix match
    let chunk = store.getChunk(id)
    if (!chunk) {
      const all = store.allChunks()
      chunk = all.find((c) => c.id.startsWith(id)) ?? null
    }
    if (!chunk) return { text: `Chunk not found: \`${id}\`` }
    const entities = store.entitiesForChunk(chunk.id)
    const hasEmbed = chunk.embedding && chunk.embedding.byteLength > 0
    const embedDims = hasEmbed ? chunk.embedding.byteLength / 8 : 0
    const created = new Date(chunk.created_at).toISOString().slice(0, 19).replace("T", " ")
    const updated = new Date(chunk.updated_at).toISOString().slice(0, 19).replace("T", " ")
    const validated = chunk.last_validated_at
      ? new Date(chunk.last_validated_at).toISOString().slice(0, 19).replace("T", " ")
      : "never"
    const textPreview = chunk.text.length > 2000 ? chunk.text.slice(0, 2000) + "\n...(truncated)" : chunk.text
    const lines = [
      `**Chunk: \`${chunk.id}\`**`,
      "",
      "| Field | Value |",
      "|-------|-------|",
      `| Path | ${chunk.path} |`,
      `| Source | ${chunk.source} |`,
      `| Lines | ${chunk.start_line}-${chunk.end_line} |`,
      `| Hash | \`${chunk.hash}\` |`,
      `| Truth State | ${chunk.truth_state} |`,
      `| Confidence | ${chunk.confidence} |`,
      `| Has Embedding | ${hasEmbed ? `yes (${embedDims} dims)` : "no"} |`,
      `| Embedding Model | ${chunk.embedding_model || "(none)"} |`,
      `| Created | ${created} |`,
      `| Updated | ${updated} |`,
      `| Last Validated | ${validated} |`,
      "",
    ]
    if (entities.length > 0) {
      lines.push(`**Entities** (${entities.length})`)
      for (const e of entities) lines.push(`- [${e.kind}] ${e.value}`)
      lines.push("")
    }
    lines.push("**Text:**", "```", textPreview, "```")
    return { text: lines.join("\n") }
  }

  // ---------------------------------------------------------------
  // /memory embeddings
  // ---------------------------------------------------------------
  if (args === "embeddings") {
    const es = store.embeddingStats()
    const pct = es.total > 0 ? ((es.withEmbedding / es.total) * 100).toFixed(1) : "N/A"
    const lines = [
      "**Embedding Status**",
      "",
      `- Total chunks: ${es.total}`,
      `- With embeddings: ${es.withEmbedding} (${pct}%)`,
      `- Empty (no vector): ${es.empty}`,
      `- Embedding cache: ${es.cacheEntries} entries${es.cacheDims > 0 ? ` (${es.cacheDims} dims)` : ""}`,
      "",
    ]
    const models = Object.entries(es.byModel)
    if (models.length > 0) {
      lines.push("**By Model:**")
      for (const [model, count] of models) lines.push(`- ${model}: ${count} chunks`)
    } else {
      lines.push("No embedding models found (no chunks have been embedded yet).")
    }
    return { text: lines.join("\n") }
  }

  return null
}

export async function register(api: PluginApi) {
  log.debug("register: starting memory plugin registration")
  const config = MemoryConfig.resolve(api.pluginConfig)

  if (!config.enabled) {
    api.logger.info("memory plugin disabled by config")
    return
  }

  // Access project info directly from Instance (built-in plugin privilege)
  const worktree = Instance.worktree
  const projectID = Instance.project.id
  log.debug("register: project resolved", { projectID, worktree })

  const store = MemoryStore.create(projectID)
  store.open()
  log.debug("register: store opened", { stats: store.stats() })

  // Create embedding provider, forwarding config (model, dimensions, baseURL, apiKey)
  let provider: Embed.EmbeddingProvider
  try {
    log.debug("register: creating embedding provider", {
      provider: config.embedding.provider,
      model: config.embedding.model,
    })
    provider = Embed.create(config.embedding.provider, {
      model: config.embedding.model,
      ...(config.embedding.dimensions ? { dimensions: config.embedding.dimensions } : {}),
    })
    log.debug("register: embedding provider created", {
      model: provider.model(),
      dimensions: provider.dimensions(),
    })
  } catch (err) {
    log.warn("register: embedding provider creation failed", {
      provider: config.embedding.provider,
      error: String(err),
    })
    api.logger.warn(`embedding provider "${config.embedding.provider}" not available: ${String(err)}`)
    api.logger.info("memory plugin requires an embedding provider. Set OPENAI_API_KEY to enable.")
    store.close()
    return
  }

  const entityMode = config.extraction.entityExtraction
  const extractionMode = config.extraction.mode
  const ignoredEntities = new Set(config.extraction.ignoredEntities)
  log.debug("register: extraction config", {
    extractionMode,
    entityMode,
    ignoredEntities: config.extraction.ignoredEntities.length,
  })

  // LLM generate function is resolved lazily — not during registration.
  // This avoids blocking server startup if the provider system is slow
  // or if the model resolution requires network calls.
  let generate: ((prompt: string) => Promise<string>) | undefined
  let generateResolved = false

  async function getGenerate() {
    if (generateResolved) return generate
    generateResolved = true
    log.debug("getGenerate: lazily resolving LLM generate function")
    try {
      generate = await withTimeout(createGenerate(config), INIT_TIMEOUT, "createGenerate")
      if (generate) {
        log.info("getGenerate: LLM generate function ready")
      } else {
        log.info("getGenerate: no LLM model available (extraction will use title mode, entities will use regex)")
      }
    } catch (err) {
      log.warn("getGenerate: failed to create LLM generate function", { error: String(err) })
    }
    return generate
  }

  // Instance-scoped file watcher
  const watcher = Watcher.create()

  // Register tools — these are synchronous and don't block
  api.registerTool(memorySearch(store, provider), { name: "memory_search" })
  api.registerTool(memoryGet(worktree), { name: "memory_get" })
  log.debug("register: tools registered (memory_search, memory_get)")

  // Track whether initial sync has been attempted
  let initialSyncDone = false

  // Inject context at agent start
  if (config.injection.enabled) {
    api.on("agent.start", async (event) => {
      log.debug("hook:agent.start: fired", { session: event.sessionID })

      // Run initial sync lazily on first agent.start (deferred from registration
      // to avoid blocking server startup with network I/O)
      if (!initialSyncDone && config.sync.onSessionStart) {
        initialSyncDone = true
        log.debug("hook:agent.start: running deferred initial sync")
        try {
          const gen = await getGenerate()
          const result = await Sync.sync({
            store,
            provider,
            worktree,
            extra: config.paths,
            entityMode,
            generate: gen,
            ignoredEntities,
          })
          watcher.clearDirty()
          log.info("hook:agent.start: initial sync complete", {
            indexed: result.indexed,
            unchanged: result.unchanged,
            removed: result.removed,
            errors: result.errors.length,
          })
        } catch (err) {
          log.warn("hook:agent.start: initial sync failed", { error: String(err) })
        }
      }

      // Lazy re-sync if files changed since last sync
      if (config.sync.onSearch && watcher.isDirty()) {
        log.debug("hook:agent.start: watcher dirty, running lazy sync")
        try {
          const gen = await getGenerate()
          const result = await Sync.sync({
            store,
            provider,
            worktree,
            extra: config.paths,
            entityMode,
            generate: gen,
            ignoredEntities,
          })
          watcher.clearDirty()
          log.debug("hook:agent.start: lazy sync complete", { indexed: result.indexed })
        } catch (err) {
          log.warn("hook:agent.start: lazy sync failed", { error: String(err) })
        }
      }

      // Read the first user message as the query for contextual injection
      const query = await firstUserMessage(event.sessionID)
      log.debug("hook:agent.start: building injection context", { hasQuery: !!query })

      // Estimate context budget from model limits and last assistant token usage
      let contextLimit: number | undefined
      let usedTokens: number | undefined
      try {
        const model = await Provider.getModel(event.model.providerID, event.model.modelID)
        contextLimit = model.limit.context || undefined
      } catch {
        // Model lookup can fail for custom/unknown models — proceed without limit
      }

      if (contextLimit) {
        try {
          const msgs = await Session.messages({ sessionID: event.sessionID, limit: 50 })
          const last = msgs.findLast((m) => m.info.role === "assistant" && !m.info.summary)
          if (last && last.info.role === "assistant") {
            const t = last.info.tokens
            usedTokens = t.total || t.input + t.output + t.cache.read + t.cache.write
          }
        } catch {
          // Session message lookup can fail early in lifecycle
        }
        log.debug("hook:agent.start: context budget", { contextLimit, usedTokens })
      }

      // Apply maxTokensPercent cap when configured
      let maxTokens = config.injection.maxTokens
      if (config.injection.maxTokensPercent && contextLimit) {
        const pctCap = Math.floor((contextLimit * config.injection.maxTokensPercent) / 100)
        maxTokens = Math.min(maxTokens, pctCap)
      }

      const context = await Inject.build({
        store,
        provider,
        worktree,
        projectID,
        maxTokens,
        query,
        contextLimit,
        usedTokens,
      })

      if (!context) {
        log.debug("hook:agent.start: no context to inject (empty)")
        return
      }
      log.debug("hook:agent.start: injecting context", { length: context.length })
      return { prependContext: context }
    })
    log.debug("register: agent.start hook registered")
  }

  // ==========================================================================
  // Session knowledge extraction
  // ==========================================================================
  //
  // Extraction is triggered by agent.finish (primary) and session.archived
  // (fallback). A per-session cooldown prevents redundant re-extractions
  // during multi-turn conversations.
  // ==========================================================================

  const extractionCooldowns = new Map<string, ExtractionState>()
  let extractionCount = 0

  /**
   * Core extraction logic shared by agent.finish and session.archived hooks.
   * Reads session messages, builds a summary, runs LLM extraction, and
   * stores the result as a searchable chunk with entity tags.
   *
   * Returns true if extraction was performed.
   */
  async function extractSession(sessionID: string, trigger: string): Promise<boolean> {
    const session = await Session.get(sessionID)
    if (!session) {
      log.info(`${trigger}: session not found`, { session: sessionID })
      return false
    }

    // Skip sessions that still have the default auto-generated title
    if (Session.isDefaultTitle(session.title)) {
      log.debug(`${trigger}: default title, skipping extraction`, { session: sessionID })
      return false
    }

    let summary = session.title ?? ""
    log.debug(`${trigger}: session loaded`, { title: session.title, mode: extractionMode })

    // In LLM mode, read session messages for richer extraction
    if (extractionMode === "llm") {
      try {
        const msgs = await Session.messages({ sessionID, limit: 50 })
        log.debug(`${trigger}: loaded session messages`, { count: msgs.length })
        const parts: string[] = []
        for (const msg of msgs) {
          const role = msg.info.role
          for (const part of msg.parts) {
            if (part.type === "text") {
              parts.push(`[${role}]: ${part.text.slice(0, 500)}`)
            }
          }
        }
        if (parts.length > 0) {
          summary = `Session title: ${session.title}\n\n${parts.join("\n\n")}`
        }
      } catch (err) {
        log.warn(`${trigger}: failed to read session messages`, { error: String(err) })
      }
    }

    if (!summary || summary.trim() === "NONE") {
      log.info(`${trigger}: no meaningful summary, skipping extraction`, { session: sessionID })
      return false
    }

    const gen = await getGenerate()
    log.debug(`${trigger}: running extraction`, {
      session: sessionID,
      summaryLength: summary.length,
      hasGenerate: !!gen,
    })

    const extracted = await extract({
      store,
      provider,
      sessionID,
      projectID,
      summary,
      mode: extractionMode,
      entityMode,
      generate: gen,
      ignoredEntities,
    })

    log.debug(`${trigger}: extraction result`, { extracted, session: sessionID })

    // Run contradiction detection on the newly extracted entry
    if (extracted && config.maintenance.contradictionDetection) {
      const chunkId = `summary:${sessionID}`
      log.debug(`${trigger}: running contradiction detection`, { chunkId })
      detectContradictions(store, chunkId)
    }

    return extracted
  }

  if (config.extraction.enabled) {
    // -----------------------------------------------------------------------
    // Primary trigger: agent.finish
    // Fires after every agent turn. Uses a per-session cooldown to avoid
    // redundant extractions during multi-step tool-call conversations.
    // -----------------------------------------------------------------------
    api.on("agent.finish", async (event) => {
      log.debug("hook:agent.finish: fired", {
        session: event.sessionID,
        agent: event.agent,
        success: event.success,
        durationMs: event.durationMs,
      })

      // Skip failed agent turns — no useful knowledge to extract
      if (!event.success) {
        log.debug("hook:agent.finish: agent failed, skipping", { session: event.sessionID })
        return
      }

      try {
        // Check message count — skip trivial sessions
        const msgs = await Session.messages({ sessionID: event.sessionID, limit: 100 })
        if (msgs.length < MIN_MESSAGES_FOR_EXTRACTION) {
          log.debug("hook:agent.finish: too few messages, skipping", {
            session: event.sessionID,
            count: msgs.length,
          })
          return
        }

        // Check cooldown — skip if recently extracted with same message count
        const now = Date.now()
        const prev = extractionCooldowns.get(event.sessionID)
        if (prev && now - prev.extractedAt < EXTRACTION_COOLDOWN && msgs.length === prev.messageCount) {
          log.debug("hook:agent.finish: cooldown active, skipping", {
            session: event.sessionID,
            elapsedMs: now - prev.extractedAt,
            messageCount: msgs.length,
          })
          return
        }

        const extracted = await extractSession(event.sessionID, "hook:agent.finish")

        if (extracted) {
          extractionCooldowns.set(event.sessionID, { extractedAt: Date.now(), messageCount: msgs.length })
          extractionCount++
          log.info("hook:agent.finish: extraction complete", {
            session: event.sessionID,
            extractionCount,
          })

          // Prune expired cooldown entries to prevent unbounded growth
          if (extractionCooldowns.size > 50) {
            const now = Date.now()
            for (const [sid, state] of extractionCooldowns) {
              if (now - state.extractedAt > EXTRACTION_COOLDOWN * 2) {
                extractionCooldowns.delete(sid)
              }
            }
          }

          // Run maintenance periodically, not after every extraction
          if (extractionCount % MAINTENANCE_EVERY === 0) {
            log.debug("hook:agent.finish: running periodic maintenance", { extractionCount })
            try {
              await Maintain.run({ store, provider, worktree, projectID, config })
              log.debug("hook:agent.finish: maintenance complete")
            } catch (err) {
              log.warn("hook:agent.finish: maintenance failed", { error: String(err) })
            }
          }
        }
      } catch (err) {
        log.warn("hook:agent.finish: extraction failed", { session: event.sessionID, error: String(err) })
      }
    })
    log.debug("register: agent.finish hook registered")

    // -----------------------------------------------------------------------
    // Fallback trigger: session.archived
    // Fires when a session is explicitly archived via the API (rare in TUI).
    // Bypasses cooldown to ensure final extraction always runs.
    // -----------------------------------------------------------------------
    api.on("session.archived", async (event) => {
      log.debug("hook:session.archived: fired", { session: event.sessionID })
      try {
        const extracted = await extractSession(event.sessionID, "hook:session.archived")
        if (extracted) {
          extractionCooldowns.delete(event.sessionID) // Clean up cooldown entry
          extractionCount++
        }
      } catch (err) {
        log.warn("hook:session.archived: extraction failed", { session: event.sessionID, error: String(err) })
      }
    })
    log.debug("register: session.archived hook registered")
  }

  // Register cleanup service — always, so store.close() runs on shutdown.
  // If watch is enabled, the watcher is started/stopped alongside it.
  api.registerService({
    id: "memory-watcher",
    start: async (_ctx) => {
      log.debug("service:memory-watcher: starting", { watch: config.sync.watch })
      if (config.sync.watch) watcher.start(worktree, config.sync.watchDebounceMs, config.paths)
    },
    stop: async (_ctx) => {
      log.debug("service:memory-watcher: stopping")
      watcher.stop()
      store.close()
    },
  })

  // Register periodic maintenance cron (replaces bare gc())
  api.registerCron({
    id: "memory-maintenance",
    schedule: { kind: "interval", ms: 60 * 60 * 1000 },
    action: {
      type: "custom",
      handler: async () => {
        log.debug("cron:maintenance: starting hourly maintenance")
        try {
          await Maintain.run({
            store,
            provider,
            worktree,
            projectID,
            config,
          })
          log.debug("cron:maintenance: complete")
        } catch (err) {
          log.warn("cron:maintenance: failed", { error: String(err) })
        }
      },
    },
  })

  // Register chat command for manual memory management
  api.registerChatCommand({
    name: "memory",
    description: "View memory status and manage knowledge entries",
    acceptsArgs: true,
    async handler(ctx) {
      const args = ctx.args?.trim() ?? ""

      if (args === "status" || args === "") {
        const s = store.stats()
        const truthEntries = Object.entries(s.chunksByTruth)
          .map(([state, count]) => `${state}: ${count}`)
          .join(", ")
        const sourceEntries = Object.entries(s.chunksBySource)
          .map(([src, count]) => `${src}: ${count}`)
          .join(", ")
        return {
          text: [
            "**Memory Status**",
            `- Files indexed: ${s.files}`,
            `- Chunks stored: ${s.chunks}${truthEntries ? ` (${truthEntries})` : ""}`,
            `- Chunk sources: ${sourceEntries || "none"}`,
            `- Session summaries: ${s.summaries}`,
            `- Entity tags: ${s.entities}`,
            `- Cached embeddings: ${s.cacheEntries}`,
            `- Project: ${projectID}`,
            `- Provider: ${config.embedding.provider}/${config.embedding.model}`,
            `- Extraction mode: ${extractionMode} (entity: ${entityMode})`,
            `- Extraction trigger: agent.finish (cooldown: ${EXTRACTION_COOLDOWN / 1000}s)`,
            `- Extractions performed: ${extractionCount}`,
            `- Sessions with cooldown: ${extractionCooldowns.size}`,
            `- Maintenance every: ${MAINTENANCE_EVERY} extractions`,
            `- LLM model: ${config.model ?? "auto"}`,
            `- Ignored entities: ${config.extraction.ignoredEntities.length}`,
            `- Initial sync done: ${initialSyncDone}`,
            `- LLM generate resolved: ${generateResolved}`,
            `- LLM generate available: ${!!generate}`,
          ].join("\n"),
        }
      }

      if (args === "sync") {
        log.debug("cmd:sync: starting manual sync")
        const gen = await getGenerate()
        const result = await Sync.sync({
          store,
          provider,
          worktree,
          extra: config.paths,
          entityMode,
          generate: gen,
          ignoredEntities,
        })
        initialSyncDone = true
        log.debug("cmd:sync: complete", result)
        return {
          text: [
            "**Memory Sync Complete**",
            `- Indexed: ${result.indexed} files`,
            `- Removed: ${result.removed} stale entries`,
            `- Unchanged: ${result.unchanged} files`,
            ...(result.errors.length > 0 ? [`- Errors: ${result.errors.join(", ")}`] : []),
          ].join("\n"),
        }
      }

      if (args === "metrics") {
        const m = Metrics.snapshot()
        const injRate = m.injections > 0 ? ((m.injectionHits / m.injections) * 100).toFixed(1) : "N/A"
        const searchRate = m.searches > 0 ? ((m.searchHits / m.searches) * 100).toFixed(1) : "N/A"
        const avgSearchMs = m.searches > 0 ? Math.round(m.searchLatencyMs / m.searches) : 0
        const cacheTotal = m.embeddingCacheHits + m.embeddingCacheMisses
        const cacheRate = cacheTotal > 0 ? ((m.embeddingCacheHits / cacheTotal) * 100).toFixed(1) : "N/A"
        const avgEmbedMs = m.embeddingCalls > 0 ? Math.round(m.embeddingLatencyMs / m.embeddingCalls) : 0
        return {
          text: [
            "**Memory Metrics (this session)**",
            "",
            "Injection:",
            `- Total: ${m.injections} (hits: ${m.injectionHits}, misses: ${m.injectionMisses})`,
            `- Characters injected: ${m.injectionChars.toLocaleString()}`,
            `- Hit rate: ${injRate}%`,
            "",
            "Search:",
            `- Total: ${m.searches} (hits: ${m.searchHits}, misses: ${m.searchMisses})`,
            `- Avg latency: ${avgSearchMs}ms`,
            `- Hit rate: ${searchRate}%`,
            "",
            "Extraction:",
            `- Total: ${m.extractions} (LLM: ${m.extractionLLM}, title: ${m.extractionTitle}, empty: ${m.extractionEmpty})`,
            "",
            "Embedding:",
            `- API calls: ${m.embeddingCalls} (texts: ${m.embeddingTexts})`,
            `- Cache: ${m.embeddingCacheHits} hits / ${m.embeddingCacheMisses} misses (${cacheRate}% hit rate)`,
            `- Avg latency: ${avgEmbedMs}ms`,
            `- Errors: ${m.embeddingErrors}`,
            "",
            "Maintenance:",
            `- Runs: ${m.maintenanceRuns}`,
            `- Stale: ${m.maintenanceStaleDeprecated} deprecated, ${m.maintenanceStaleDisputed} disputed`,
            `- Summaries deleted: ${m.maintenanceSummariesDeleted}`,
            `- Promoted: ${m.maintenancePromoted}`,
            `- Migrated: ${m.maintenanceMigrated}`,
            `- Cleaned up: ${m.maintenanceCleanedUp}`,
          ].join("\n"),
        }
      }

      if (args === "gc") {
        store.gc()
        return { text: "Garbage collection complete." }
      }

      if (args === "maintain") {
        log.debug("cmd:maintain: starting manual maintenance")
        const report = await Maintain.run({ store, provider, worktree, projectID, config })
        log.debug("cmd:maintain: complete", report)
        return {
          text: [
            "**Maintenance Complete**",
            `- Stale deprecated: ${report.staleDeprecated}`,
            `- Stale disputed: ${report.staleDisputed}`,
            `- Summaries deleted: ${report.summariesDeleted}`,
            `- Promoted: ${report.promoted}`,
            `- Migrated: ${report.migrated}`,
            `- Cleaned up: ${report.cleanedUp}`,
          ].join("\n"),
        }
      }

      if (args === "conflicts") {
        const disputed = store.chunksByFilter({ truthState: "disputed" })
        const deprecated = store.chunksByFilter({ truthState: "deprecated" })
        if (disputed.length === 0 && deprecated.length === 0) {
          return { text: "No conflicts found. All entries are clean." }
        }
        const lines = ["**Memory Conflicts**", ""]
        for (const chunk of disputed.slice(0, 10)) {
          const snippet = chunk.text.slice(0, 80).replace(/\n/g, " ")
          lines.push(`- [disputed] ${chunk.id}: ${snippet}`)
        }
        for (const chunk of deprecated.slice(0, 10)) {
          const snippet = chunk.text.slice(0, 80).replace(/\n/g, " ")
          lines.push(`- [deprecated] ${chunk.id}: ${snippet}`)
        }
        if (disputed.length + deprecated.length > 20) {
          lines.push(`\n...and ${disputed.length + deprecated.length - 20} more`)
        }
        return { text: lines.join("\n") }
      }

      // Delegate browse/inspect subcommands to exported handler
      const result = handleCommand(store, args)
      if (result) return result

      if (args.startsWith("promote ")) {
        const id = args.slice("promote ".length).trim()
        if (!id) return { text: "Usage: `/memory promote <chunk-id>`" }
        const chunk = store.getChunk(id)
        if (!chunk) return { text: `Chunk not found: ${id}` }
        store.updateTruthState(id, "validated", 1.0)
        store.touchValidated(id)
        return { text: `Promoted \`${id}\` to validated with confidence 1.0.` }
      }

      return {
        text: [
          "**Memory Commands**",
          "",
          "Status & diagnostics:",
          "- `/memory` or `/memory status` - Overview stats",
          "- `/memory metrics` - Runtime metrics (injection, search, extraction, embedding)",
          "- `/memory embeddings` - Vector embedding health & model distribution",
          "",
          "Browse data:",
          "- `/memory chunks [source=X] [truth=X] [limit=N]` - List chunks",
          "- `/memory summaries [limit]` - List session summaries",
          "- `/memory entities [kind=X] [limit=N]` - List entity tags by kind",
          "- `/memory files` - List indexed source files",
          "- `/memory inspect <id>` - Full detail for a chunk (supports prefix match)",
          "",
          "Actions:",
          "- `/memory sync` - Re-index knowledge files",
          "- `/memory gc` - Run garbage collection",
          "- `/memory maintain` - Run full maintenance cycle",
          "- `/memory conflicts` - Show disputed/deprecated entries",
          "- `/memory promote <id>` - Promote a chunk to validated",
        ].join("\n"),
      }
    },
  })

  log.info("register: memory plugin loaded (non-blocking)", { stats: store.stats() })
}
