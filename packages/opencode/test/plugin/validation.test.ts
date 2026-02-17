import { describe, expect, test } from "bun:test"
import { validatePluginConfig } from "../../src/plugin/validation"

describe("plugin.validation", () => {
  test("passes when no schema provided", () => {
    const result = validatePluginConfig({ value: { foo: 1 } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ foo: 1 })
  })

  test("passes when no schema and no value", () => {
    const result = validatePluginConfig({})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeUndefined()
  })

  test("passes valid object against object schema", () => {
    const result = validatePluginConfig({
      schema: { type: "object", required: ["name"] },
      value: { name: "test" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ name: "test" })
  })

  test("fails when value is not an object but schema expects object", () => {
    const result = validatePluginConfig({
      schema: { type: "object" },
      value: "string",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContain("expected an object")
  })

  test("treats null as empty object (defaults)", () => {
    const result = validatePluginConfig({
      schema: { type: "object" },
      value: null,
    })
    // null is coerced to {} via ?? operator, so it passes
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({})
  })

  test("fails when value is array and schema expects object", () => {
    const result = validatePluginConfig({
      schema: { type: "object" },
      value: [1, 2],
    })
    expect(result.ok).toBe(false)
  })

  test("fails when required field is missing", () => {
    const result = validatePluginConfig({
      schema: { type: "object", required: ["apiKey", "region"] },
      value: { apiKey: "secret" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.length).toBe(1)
      expect(result.errors[0]).toContain("region")
    }
  })

  test("fails when multiple required fields missing", () => {
    const result = validatePluginConfig({
      schema: { type: "object", required: ["a", "b", "c"] },
      value: {},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBe(3)
  })

  test("defaults to empty object when value is undefined", () => {
    const result = validatePluginConfig({
      schema: { type: "object" },
      value: undefined,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({})
  })

  test("passes non-object schema type without type checking", () => {
    const result = validatePluginConfig({
      schema: { type: "string" },
      value: "hello",
    })
    expect(result.ok).toBe(true)
  })

  test("ignores non-string entries in required array", () => {
    const result = validatePluginConfig({
      schema: { type: "object", required: [42, "name"] },
      value: { name: "ok" },
    })
    expect(result.ok).toBe(true)
  })
})
