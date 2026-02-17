import { describe, test, expect } from "bun:test"
import {
  applyDecorators,
  type ToolDecoratorRegistration,
  type ToolExecuteFn,
  type ToolResult,
} from "../../src/plugin/decorator"

function execute(output: string): ToolExecuteFn {
  return async () => ({ title: "test", output, metadata: {} })
}

function reg(
  tool: string | RegExp | "*",
  decorator: ToolDecoratorRegistration["decorator"]["decorator"],
  priority?: number,
): ToolDecoratorRegistration {
  return {
    pluginId: "test",
    decorator: { tool, decorator, priority },
    source: "/test",
  }
}

const ctx = { sessionID: "s1", agent: "build", tool: "bash" }

describe("applyDecorators", () => {
  test("no matching decorators returns original", async () => {
    const fn = execute("hello")
    const result = applyDecorators([], "bash", "Run shell", fn)
    expect(result).toBe(fn)
  })

  test("exact name match applies decorator", async () => {
    const decorated = applyDecorators(
      [
        reg("bash", (original) => async (args, ctx) => {
          const result = await original(args, ctx)
          return { ...result, output: `[wrapped] ${result.output}` }
        }),
      ],
      "bash",
      "Run shell",
      execute("hello"),
    )
    const result = await decorated({}, ctx)
    expect(result.output).toBe("[wrapped] hello")
  })

  test("regex match applies decorator", async () => {
    const decorated = applyDecorators(
      [
        reg(/^bash/, (original) => async (args, ctx) => {
          const result = await original(args, ctx)
          return { ...result, output: `[regex] ${result.output}` }
        }),
      ],
      "bash",
      "Run shell",
      execute("cmd"),
    )
    const result = await decorated({}, ctx)
    expect(result.output).toBe("[regex] cmd")
  })

  test("wildcard matches all tools", async () => {
    const decorated = applyDecorators(
      [
        reg("*", (original) => async (args, ctx) => {
          const result = await original(args, ctx)
          return { ...result, output: `[all] ${result.output}` }
        }),
      ],
      "read",
      "Read file",
      execute("content"),
    )
    const result = await decorated({}, { ...ctx, tool: "read" })
    expect(result.output).toBe("[all] content")
  })

  test("non-matching decorator is skipped", async () => {
    const decorated = applyDecorators(
      [
        reg("edit", (original) => async (args, ctx) => {
          const result = await original(args, ctx)
          return { ...result, output: `[edit] ${result.output}` }
        }),
      ],
      "bash",
      "Run shell",
      execute("hello"),
    )
    const result = await decorated({}, ctx)
    expect(result.output).toBe("hello")
  })

  test("priority ordering: lower priority wraps first (inner)", async () => {
    const decorated = applyDecorators(
      [
        reg(
          "*",
          (original) => async (args, ctx) => {
            const result = await original(args, ctx)
            return { ...result, output: `[outer:${result.output}]` }
          },
          10,
        ),
        reg(
          "*",
          (original) => async (args, ctx) => {
            const result = await original(args, ctx)
            return { ...result, output: `[inner:${result.output}]` }
          },
          1,
        ),
      ],
      "bash",
      "Run shell",
      execute("core"),
    )
    const result = await decorated({}, ctx)
    // inner wraps core, then outer wraps inner
    expect(result.output).toBe("[outer:[inner:core]]")
  })

  test("decorator can modify arguments", async () => {
    let capturedArgs: Record<string, unknown> = {}
    const decorated = applyDecorators(
      [
        reg("bash", (original) => async (args, ctx) => {
          return original({ ...args, command: `safe: ${args.command}` }, ctx)
        }),
      ],
      "bash",
      "Run shell",
      async (args) => {
        capturedArgs = args
        return { title: "test", output: "ok", metadata: {} }
      },
    )
    await decorated({ command: "rm -rf /" }, ctx)
    expect(capturedArgs.command).toBe("safe: rm -rf /")
  })

  test("decorator can short-circuit (skip original)", async () => {
    let originalCalled = false
    const decorated = applyDecorators(
      [
        reg("bash", () => async () => {
          return { title: "Blocked", output: "nope", metadata: { blocked: true } }
        }),
      ],
      "bash",
      "Run shell",
      async () => {
        originalCalled = true
        return { title: "test", output: "ok", metadata: {} }
      },
    )
    const result = await decorated({}, ctx)
    expect(result.output).toBe("nope")
    expect(originalCalled).toBe(false)
  })

  test("decorator receives tool info", async () => {
    let capturedInfo: { tool: string; description: string } | undefined
    applyDecorators(
      [
        reg("bash", (original, info) => {
          capturedInfo = info
          return original
        }),
      ],
      "bash",
      "Run shell commands",
      execute("ok"),
    )
    expect(capturedInfo?.tool).toBe("bash")
    expect(capturedInfo?.description).toBe("Run shell commands")
  })

  test("broken decorator does not break others", async () => {
    const decorated = applyDecorators(
      [
        reg(
          "*",
          () => {
            throw new Error("broken decorator")
          },
          1,
        ),
        reg(
          "*",
          (original) => async (args, ctx) => {
            const result = await original(args, ctx)
            return { ...result, output: `[good] ${result.output}` }
          },
          10,
        ),
      ],
      "bash",
      "Run shell",
      execute("hello"),
    )
    const result = await decorated({}, ctx)
    expect(result.output).toBe("[good] hello")
  })

  test("multiple matching decorators all apply", async () => {
    const decorated = applyDecorators(
      [
        reg("bash", (original) => async (args, ctx) => {
          const result = await original(args, ctx)
          return { ...result, output: `[a:${result.output}]` }
        }),
        reg("*", (original) => async (args, ctx) => {
          const result = await original(args, ctx)
          return { ...result, output: `[b:${result.output}]` }
        }),
      ],
      "bash",
      "Run shell",
      execute("core"),
    )
    const result = await decorated({}, ctx)
    // both have default priority 0, applied in registration order
    // "bash" match wraps first (inner), "*" wraps second (outer)
    expect(result.output).toBe("[b:[a:core]]")
  })
})
