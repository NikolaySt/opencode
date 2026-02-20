import { describe, expect, test, beforeEach } from "bun:test"
import * as Metrics from "../../src/memory/metrics"

describe("memory.metrics", () => {
  beforeEach(() => {
    Metrics.reset()
  })

  test("record increments counter by 1 by default", () => {
    Metrics.record("searches")
    Metrics.record("searches")
    expect(Metrics.get("searches")).toBe(2)
  })

  test("record increments counter by custom value", () => {
    Metrics.record("injectionChars", 500)
    Metrics.record("injectionChars", 300)
    expect(Metrics.get("injectionChars")).toBe(800)
  })

  test("get returns 0 for unrecorded metrics", () => {
    expect(Metrics.get("embeddingErrors")).toBe(0)
  })

  test("snapshot returns all metric keys", () => {
    Metrics.record("injections", 5)
    Metrics.record("searchHits", 10)
    const snap = Metrics.snapshot()
    expect(snap.injections).toBe(5)
    expect(snap.searchHits).toBe(10)
    expect(snap.embeddingCalls).toBe(0)
  })

  test("snapshot contains exactly all expected keys", () => {
    const snap = Metrics.snapshot()
    const keys = Object.keys(snap).sort()
    const expectedKeys = [
      "embeddingCacheHits",
      "embeddingCacheMisses",
      "embeddingCalls",
      "embeddingErrors",
      "embeddingLatencyMs",
      "embeddingTexts",
      "extractionEmpty",
      "extractionLLM",
      "extractionTitle",
      "extractions",
      "injectionBudgetScaled",
      "injectionChars",
      "injectionHits",
      "injectionMisses",
      "injectionSkippedOverflow",
      "injections",
      "maintenanceCleanedUp",
      "maintenanceMigrated",
      "maintenancePromoted",
      "maintenanceRuns",
      "maintenanceStaleDeprecated",
      "maintenanceStaleDisputed",
      "maintenanceSummariesDeleted",
      "searchHits",
      "searchLatencyMs",
      "searchMisses",
      "searches",
    ].sort()
    expect(keys).toEqual(expectedKeys)
  })

  test("reset clears all counters to zero", () => {
    Metrics.record("injections", 100)
    Metrics.record("searches", 50)
    Metrics.record("embeddingErrors", 3)
    Metrics.reset()
    expect(Metrics.get("injections")).toBe(0)
    expect(Metrics.get("searches")).toBe(0)
    expect(Metrics.get("embeddingErrors")).toBe(0)
    // Verify all values in snapshot are zero
    const snap = Metrics.snapshot()
    for (const [key, value] of Object.entries(snap)) {
      expect(value).toBe(0)
    }
  })

  test("snapshot is a copy, not a reference", () => {
    Metrics.record("searches", 5)
    const snap1 = Metrics.snapshot()
    Metrics.record("searches", 10)
    const snap2 = Metrics.snapshot()
    expect(snap1.searches).toBe(5)
    expect(snap2.searches).toBe(15)
  })
})
