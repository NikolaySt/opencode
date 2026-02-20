import { describe, expect, test } from "bun:test"
import { extractRegex, extractLLM, extract } from "../../src/memory/entity"

describe("memory.entity.extractRegex", () => {
  test("extracts file paths with slashes", () => {
    const entities = extractRegex("Modified src/auth/handler.ts and config/db.json")
    const paths = entities.filter((e) => e.kind === "path")
    expect(paths).toHaveLength(2)
    expect(paths.map((p) => p.value).sort()).toEqual(["config/db.json", "src/auth/handler.ts"])
  })

  test("extracts file paths by known extension", () => {
    const entities = extractRegex("Updated schema.sql and config.toml")
    const paths = entities.filter((e) => e.kind === "path")
    expect(paths.some((p) => p.value.includes("schema.sql"))).toBe(true)
    expect(paths.some((p) => p.value.includes("config.toml"))).toBe(true)
  })

  test("extracts PascalCase class names", () => {
    const entities = extractRegex("The AuthService calls UserController for validation")
    const classes = entities.filter((e) => e.kind === "class")
    expect(classes.some((c) => c.value === "AuthService")).toBe(true)
    expect(classes.some((c) => c.value === "UserController")).toBe(true)
  })

  test("extracts camelCase function names (3+ segments)", () => {
    const entities = extractRegex("Call getUserById to fetch the record")
    const fns = entities.filter((e) => e.kind === "function")
    expect(fns.some((f) => f.value === "getUserById")).toBe(true)
  })

  test("extracts snake_case identifiers (3+ segments)", () => {
    const entities = extractRegex("The get_user_by_id function is used")
    const fns = entities.filter((e) => e.kind === "function")
    expect(fns.some((f) => f.value === "get_user_by_id")).toBe(true)
  })

  test("extracts technology keywords", () => {
    const entities = extractRegex("We use typescript with react and postgresql")
    const techs = entities.filter((e) => e.kind === "technology")
    expect(techs.some((t) => t.value === "typescript")).toBe(true)
    expect(techs.some((t) => t.value === "react")).toBe(true)
    expect(techs.some((t) => t.value === "postgresql")).toBe(true)
  })

  test("deduplicates entities", () => {
    const entities = extractRegex("Use typescript. Yes, typescript is great. TypeScript rules.")
    const techs = entities.filter((e) => e.kind === "technology" && e.value === "typescript")
    expect(techs).toHaveLength(1)
  })

  test("extracts technology keywords at end of sentence with period", () => {
    // After the period split fix, "react." should now match "react"
    const entities = extractRegex("We use react. It is great.")
    const techs = entities.filter((e) => e.kind === "technology")
    expect(techs.some((t) => t.value === "react")).toBe(true)
  })

  test("extracts technology keywords followed by period at sentence end", () => {
    const entities = extractRegex("The project is built with typescript.")
    const techs = entities.filter((e) => e.kind === "technology")
    expect(techs.some((t) => t.value === "typescript")).toBe(true)
  })

  test("returns empty for text with no code entities", () => {
    const entities = extractRegex("The quick brown fox jumps over the lazy dog.")
    // Plain English text should produce zero entities
    expect(entities).toHaveLength(0)
  })

  test("handles empty string", () => {
    expect(extractRegex("")).toHaveLength(0)
  })
})

describe("memory.entity.extractLLM", () => {
  test("parses valid JSON from generate function", async () => {
    const generate = async (_prompt: string) =>
      JSON.stringify([
        { kind: "technology", value: "redis" },
        { kind: "path", value: "src/cache.ts" },
      ])

    const entities = await extractLLM("Redis caching in src/cache.ts", generate)
    expect(entities).toHaveLength(2)
    expect(entities[0].kind).toBe("technology")
    expect(entities[0].value).toBe("redis")
  })

  test("handles markdown code blocks in response", async () => {
    const generate = async (_prompt: string) => '```json\n[{"kind": "class", "value": "AuthService"}]\n```'

    const entities = await extractLLM("AuthService handles auth", generate)
    expect(entities).toHaveLength(1)
    expect(entities[0].kind).toBe("class")
  })

  test("falls back to regex on invalid JSON", async () => {
    const generate = async (_prompt: string) => "This is not JSON at all"
    const entities = await extractLLM("Uses typescript with react", generate)
    // Should fall back to regex and find exactly 2 technology keywords
    expect(entities).toHaveLength(2)
    const values = entities.map((e) => e.value).sort()
    expect(values).toEqual(["react", "typescript"])
  })

  test("falls back to regex on generate error", async () => {
    const generate = async (_prompt: string): Promise<string> => {
      throw new Error("API error")
    }
    const entities = await extractLLM("Uses typescript with react", generate)
    expect(entities).toHaveLength(2)
    const values = entities.map((e) => e.value).sort()
    expect(values).toEqual(["react", "typescript"])
  })

  test("returns empty for non-array JSON (object)", async () => {
    const generate = async (_prompt: string) => JSON.stringify({ kind: "technology", value: "redis" })
    const entities = await extractLLM("Uses typescript and react", generate)
    // Non-array JSON returns empty (line: !Array.isArray(parsed) return [])
    expect(entities).toHaveLength(0)
  })

  test("filters entries missing kind or value", async () => {
    const generate = async (_prompt: string) =>
      JSON.stringify([
        { kind: "technology", value: "redis" },
        { kind: "technology" }, // missing value — filtered by !item.value
        { value: "orphan" }, // missing kind — filtered by !item.kind
        { kind: "concept", value: "caching" }, // valid concept kind
      ])

    const entities = await extractLLM("Redis caching", generate)
    // Should keep redis and caching (valid entries), filter the others
    expect(entities).toHaveLength(2)
    const values = entities.map((e) => e.value).sort()
    expect(values).toEqual(["caching", "redis"])
  })

  test("filters invalid kinds", async () => {
    const generate = async (_prompt: string) =>
      JSON.stringify([
        { kind: "technology", value: "redis" },
        { kind: "invalid_kind", value: "foo" },
      ])

    const entities = await extractLLM("Redis test", generate)
    expect(entities).toHaveLength(1)
    expect(entities[0].kind).toBe("technology")
  })

  test("handles empty array response", async () => {
    const generate = async (_prompt: string) => "[]"
    const entities = await extractLLM("Nothing here", generate)
    expect(entities).toHaveLength(0)
  })
})

describe("memory.entity.extractRegex noise filtering", () => {
  test("filters likely proper names from PascalCase", () => {
    const entities = extractRegex("NikolayStoychev committed the code")
    const classes = entities.filter((e) => e.kind === "class")
    expect(classes.some((c) => c.value === "NikolayStoychev")).toBe(false)
  })

  test("filters other proper names like JohnSmith", () => {
    const entities = extractRegex("JohnSmith reviewed the PR")
    const classes = entities.filter((e) => e.kind === "class")
    expect(classes.some((c) => c.value === "JohnSmith")).toBe(false)
  })

  test("does not filter technical PascalCase like AuthService", () => {
    const entities = extractRegex("The AuthService handles auth")
    const classes = entities.filter((e) => e.kind === "class")
    expect(classes.some((c) => c.value === "AuthService")).toBe(true)
  })

  test("does not filter PascalCase with tech suffix like UserController", () => {
    const entities = extractRegex("UserController manages users")
    const classes = entities.filter((e) => e.kind === "class")
    expect(classes.some((c) => c.value === "UserController")).toBe(true)
  })

  test("does not filter 3+ segment PascalCase like MyAuthService", () => {
    const entities = extractRegex("MyAuthService is used here")
    const classes = entities.filter((e) => e.kind === "class")
    // 3+ segments → not a 2-segment proper name
    expect(classes.some((c) => c.value === "MyAuthService")).toBe(true)
  })

  test("respects ignoredEntities set", () => {
    const ignored = new Set(["typescript"])
    const entities = extractRegex("We use typescript and react", ignored)
    expect(entities.some((e) => e.value === "typescript")).toBe(false)
    expect(entities.some((e) => e.value === "react")).toBe(true)
  })

  test("ignoredEntities is case-insensitive", () => {
    // "TYPESCRIPT" in ignored set should match "typescript" entity (both lowercased)
    const entities = extractRegex("We use typescript and react", new Set(["TYPESCRIPT"]))
    expect(entities.some((e) => e.value === "typescript")).toBe(false)
    expect(entities.some((e) => e.value === "react")).toBe(true)
  })

  test("empty ignored set does not affect results", () => {
    const withIgnored = extractRegex("We use typescript", new Set())
    const without = extractRegex("We use typescript")
    expect(withIgnored.length).toBe(without.length)
  })
})

describe("memory.entity.extract with ignoredEntities in LLM mode", () => {
  test("filters ignored entities from LLM extraction results", async () => {
    const generate = async (_prompt: string) =>
      JSON.stringify([
        { kind: "technology", value: "redis" },
        { kind: "technology", value: "typescript" },
        { kind: "class", value: "AuthService" },
      ])

    const ignored = new Set(["redis"])
    const entities = await extract("Redis and TypeScript with AuthService", "llm", generate, ignored)
    // "redis" should be filtered out
    expect(entities.some((e) => e.value === "redis")).toBe(false)
    // "typescript" and "AuthService" should remain
    expect(entities.some((e) => e.value === "typescript")).toBe(true)
    expect(entities.some((e) => e.value === "AuthService")).toBe(true)
  })
})

describe("memory.entity.extract dispatcher", () => {
  test("uses regex mode when specified", async () => {
    const entities = await extract("Uses typescript and react", "regex")
    const techs = entities.filter((e) => e.kind === "technology")
    expect(techs).toHaveLength(2)
    expect(techs.map((t) => t.value).sort()).toEqual(["react", "typescript"])
  })

  test("uses llm mode when specified with generate", async () => {
    const generate = async (_prompt: string) => JSON.stringify([{ kind: "technology", value: "redis" }])

    const entities = await extract("Redis caching", "llm", generate)
    expect(entities).toHaveLength(1)
    expect(entities[0].value).toBe("redis")
  })

  test("falls back to regex when llm mode has no generate", async () => {
    const entities = await extract("Uses typescript and react", "llm")
    // Should use regex fallback since no generate function provided
    const techs = entities.filter((e) => e.kind === "technology")
    expect(techs).toHaveLength(2)
    expect(techs.map((t) => t.value).sort()).toEqual(["react", "typescript"])
  })
})
