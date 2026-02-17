import { describe, expect, test } from "bun:test"
import { resolveSlotDecision, EXCLUSIVE_SLOTS } from "../../src/plugin/slots"

describe("plugin.slots", () => {
  test("non-memory plugins are always enabled", () => {
    const result = resolveSlotDecision({ id: "foo", kind: "tool", slot: undefined, selectedId: null })
    expect(result.enabled).toBe(true)
    expect(result.selected).toBeUndefined()
  })

  test("undefined kind is always enabled", () => {
    const result = resolveSlotDecision({ id: "foo", kind: undefined, slot: undefined, selectedId: null })
    expect(result.enabled).toBe(true)
  })

  test("memory plugin is selected when no config and no prior selection", () => {
    const result = resolveSlotDecision({ id: "mem-a", kind: "memory", slot: undefined, selectedId: null })
    expect(result.enabled).toBe(true)
    expect(result.selected).toBe(true)
  })

  test("memory plugin is disabled when another is already selected", () => {
    const result = resolveSlotDecision({ id: "mem-b", kind: "memory", slot: undefined, selectedId: "mem-a" })
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain("mem-a")
  })

  test("explicit slot config selects the named plugin", () => {
    const result = resolveSlotDecision({ id: "mem-a", kind: "memory", slot: "mem-a", selectedId: null })
    expect(result.enabled).toBe(true)
    expect(result.selected).toBe(true)
  })

  test("explicit slot config disables non-matching plugin", () => {
    const result = resolveSlotDecision({ id: "mem-b", kind: "memory", slot: "mem-a", selectedId: null })
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain("mem-a")
  })

  test("same selected id does not disable itself", () => {
    const result = resolveSlotDecision({ id: "mem-a", kind: "memory", slot: undefined, selectedId: "mem-a" })
    expect(result.enabled).toBe(true)
    expect(result.selected).toBe(true)
  })

  test("EXCLUSIVE_SLOTS includes memory", () => {
    expect(EXCLUSIVE_SLOTS).toContain("memory")
  })
})
