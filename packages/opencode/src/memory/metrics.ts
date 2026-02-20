/**
 * Memory Metrics
 *
 * Lightweight in-memory metrics tracker for the memory subsystem.
 * Tracks counters and accumulators for injection, search, extraction,
 * maintenance, and embedding operations.
 *
 * Resets on process restart — no persistence needed.
 */

export type MetricKey =
  | "injections"
  | "injectionHits"
  | "injectionMisses"
  | "injectionChars"
  | "searches"
  | "searchHits"
  | "searchMisses"
  | "searchLatencyMs"
  | "extractions"
  | "extractionEmpty"
  | "extractionLLM"
  | "extractionTitle"
  | "maintenanceRuns"
  | "maintenanceStaleDeprecated"
  | "maintenanceStaleDisputed"
  | "maintenanceSummariesDeleted"
  | "maintenancePromoted"
  | "maintenanceMigrated"
  | "maintenanceCleanedUp"
  | "embeddingCalls"
  | "embeddingTexts"
  | "embeddingErrors"
  | "embeddingLatencyMs"
  | "embeddingCacheHits"
  | "embeddingCacheMisses"
  | "injectionBudgetScaled"
  | "injectionSkippedOverflow"

const counters = new Map<MetricKey, number>()

export function record(key: MetricKey, value = 1) {
  counters.set(key, (counters.get(key) ?? 0) + value)
}

export function get(key: MetricKey): number {
  return counters.get(key) ?? 0
}

const ALL_KEYS: MetricKey[] = [
  "injections",
  "injectionHits",
  "injectionMisses",
  "injectionChars",
  "searches",
  "searchHits",
  "searchMisses",
  "searchLatencyMs",
  "extractions",
  "extractionEmpty",
  "extractionLLM",
  "extractionTitle",
  "maintenanceRuns",
  "maintenanceStaleDeprecated",
  "maintenanceStaleDisputed",
  "maintenanceSummariesDeleted",
  "maintenancePromoted",
  "maintenanceMigrated",
  "maintenanceCleanedUp",
  "embeddingCalls",
  "embeddingTexts",
  "embeddingErrors",
  "embeddingLatencyMs",
  "embeddingCacheHits",
  "embeddingCacheMisses",
  "injectionBudgetScaled",
  "injectionSkippedOverflow",
]

export type Snapshot = Record<MetricKey, number>

export function snapshot(): Snapshot {
  const result = {} as Snapshot
  for (const key of ALL_KEYS) {
    result[key] = counters.get(key) ?? 0
  }
  return result
}

export function reset() {
  counters.clear()
}
