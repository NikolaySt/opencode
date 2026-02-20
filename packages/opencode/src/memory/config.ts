/**
 * Memory Configuration
 *
 * Defines the shape of memory-specific configuration that lives under
 * the `plugins.entries["opencode-memory"].config` key in opencode.json.
 */

export type MemoryConfig = {
  enabled?: boolean
  /** LLM model for extraction/entity calls, e.g. "anthropic/claude-haiku-4-5" */
  model?: string
  paths?: string[]
  embedding?: {
    provider?: string
    model?: string
    dimensions?: number
  }
  search?: {
    maxResults?: number
    minScore?: number
    vectorWeight?: number
    textWeight?: number
  }
  sync?: {
    onSessionStart?: boolean
    onSearch?: boolean
    watch?: boolean
    watchDebounceMs?: number
  }
  injection?: {
    enabled?: boolean
    maxTokens?: number
    /** Max injection budget as a percentage of the model's context window (e.g. 2 = 2%). Optional. */
    maxTokensPercent?: number
  }
  extraction?: {
    enabled?: boolean
    autoPromote?: boolean
    /** "title" = store session title only, "llm" = LLM extraction call */
    mode?: "title" | "llm"
    /** "regex" = fast regex, "llm" = LLM-based structured extraction */
    entityExtraction?: "regex" | "llm"
    /** Entity values to exclude from extraction (e.g. usernames) */
    ignoredEntities?: string[]
  }
  maintenance?: {
    /** Days before candidate summaries are deprecated (default 90) */
    summaryTTLDays?: number
    /** Maximum number of summaries per project (default 100) */
    maxSummaries?: number
    /** Auto-deprecate stale summaries (default true) */
    autoDeprecate?: boolean
    /** Detect contradicting entries (default true) */
    contradictionDetection?: boolean
    /** Days before deprecated entries are hard-deleted (default 180) */
    deprecatedCleanupDays?: number
  }
}

export type ResolvedConfig = {
  enabled: boolean
  model?: string
  paths: string[]
  embedding: { provider: string; model: string; dimensions?: number }
  search: { maxResults: number; minScore: number; vectorWeight: number; textWeight: number }
  sync: { onSessionStart: boolean; onSearch: boolean; watch: boolean; watchDebounceMs: number }
  injection: { enabled: boolean; maxTokens: number; maxTokensPercent?: number }
  extraction: {
    enabled: boolean
    autoPromote: boolean
    mode: "title" | "llm"
    entityExtraction: "regex" | "llm"
    ignoredEntities: string[]
  }
  maintenance: {
    summaryTTLDays: number
    maxSummaries: number
    autoDeprecate: boolean
    contradictionDetection: boolean
    deprecatedCleanupDays: number
  }
}

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  paths: [],
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
  },
  search: {
    maxResults: 8,
    minScore: 0.2,
    vectorWeight: 0.7,
    textWeight: 0.3,
  },
  sync: {
    onSessionStart: true,
    onSearch: true,
    watch: true,
    watchDebounceMs: 1500,
  },
  injection: {
    enabled: true,
    maxTokens: 2000,
  },
  extraction: {
    enabled: true,
    autoPromote: false,
    mode: "llm",
    entityExtraction: "regex",
    ignoredEntities: [],
  },
  maintenance: {
    summaryTTLDays: 90,
    maxSummaries: 100,
    autoDeprecate: true,
    contradictionDetection: true,
    deprecatedCleanupDays: 180,
  },
}

export function resolve(input?: Record<string, unknown>): ResolvedConfig {
  if (!input) return structuredClone(DEFAULTS)
  const embed = (input.embedding ?? {}) as Record<string, unknown>
  const srch = (input.search ?? {}) as Record<string, unknown>
  const sy = (input.sync ?? {}) as Record<string, unknown>
  const inj = (input.injection ?? {}) as Record<string, unknown>
  const ext = (input.extraction ?? {}) as Record<string, unknown>
  const mnt = (input.maintenance ?? {}) as Record<string, unknown>
  return {
    enabled: (input.enabled as boolean | undefined) ?? DEFAULTS.enabled,
    model: input.model as string | undefined,
    paths: (input.paths as string[] | undefined) ?? DEFAULTS.paths,
    embedding: {
      provider: (embed.provider as string | undefined) ?? DEFAULTS.embedding.provider,
      model: (embed.model as string | undefined) ?? DEFAULTS.embedding.model,
      dimensions: embed.dimensions as number | undefined,
    },
    search: {
      maxResults: (srch.maxResults as number | undefined) ?? DEFAULTS.search.maxResults,
      minScore: (srch.minScore as number | undefined) ?? DEFAULTS.search.minScore,
      vectorWeight: (srch.vectorWeight as number | undefined) ?? DEFAULTS.search.vectorWeight,
      textWeight: (srch.textWeight as number | undefined) ?? DEFAULTS.search.textWeight,
    },
    sync: {
      onSessionStart: (sy.onSessionStart as boolean | undefined) ?? DEFAULTS.sync.onSessionStart,
      onSearch: (sy.onSearch as boolean | undefined) ?? DEFAULTS.sync.onSearch,
      watch: (sy.watch as boolean | undefined) ?? DEFAULTS.sync.watch,
      watchDebounceMs: (sy.watchDebounceMs as number | undefined) ?? DEFAULTS.sync.watchDebounceMs,
    },
    injection: {
      enabled: (inj.enabled as boolean | undefined) ?? DEFAULTS.injection.enabled,
      maxTokens: (inj.maxTokens as number | undefined) ?? DEFAULTS.injection.maxTokens,
      maxTokensPercent: inj.maxTokensPercent as number | undefined,
    },
    extraction: {
      enabled: (ext.enabled as boolean | undefined) ?? DEFAULTS.extraction.enabled,
      autoPromote: (ext.autoPromote as boolean | undefined) ?? DEFAULTS.extraction.autoPromote,
      mode: (ext.mode as "title" | "llm" | undefined) ?? DEFAULTS.extraction.mode,
      entityExtraction: (ext.entityExtraction as "regex" | "llm" | undefined) ?? DEFAULTS.extraction.entityExtraction,
      ignoredEntities: (ext.ignoredEntities as string[] | undefined) ?? DEFAULTS.extraction.ignoredEntities,
    },
    maintenance: {
      summaryTTLDays: (mnt.summaryTTLDays as number | undefined) ?? DEFAULTS.maintenance.summaryTTLDays,
      maxSummaries: (mnt.maxSummaries as number | undefined) ?? DEFAULTS.maintenance.maxSummaries,
      autoDeprecate: (mnt.autoDeprecate as boolean | undefined) ?? DEFAULTS.maintenance.autoDeprecate,
      contradictionDetection:
        (mnt.contradictionDetection as boolean | undefined) ?? DEFAULTS.maintenance.contradictionDetection,
      deprecatedCleanupDays:
        (mnt.deprecatedCleanupDays as number | undefined) ?? DEFAULTS.maintenance.deprecatedCleanupDays,
    },
  }
}
