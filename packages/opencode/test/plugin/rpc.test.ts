import { describe, test, expect } from "bun:test"
import {
  createRpcDispatcher,
  qualifyRpcMethod,
  type RpcMethodRegistration,
  type RpcContext,
} from "../../src/plugin/rpc"

function reg(name: string, handler?: (params: unknown, ctx: RpcContext) => Promise<unknown>): RpcMethodRegistration {
  return {
    pluginId: "test",
    method: {
      name,
      handler: handler ?? (async (params) => params),
      description: `Test method ${name}`,
    },
    qualifiedName: `test.${name}`,
    source: "/test",
  }
}

describe("qualifyRpcMethod", () => {
  test("qualifies short name", () => {
    expect(qualifyRpcMethod("alpha", "analyze")).toBe("alpha.analyze")
  })

  test("preserves already-qualified name", () => {
    expect(qualifyRpcMethod("alpha", "beta.analyze")).toBe("beta.analyze")
  })
})

describe("createRpcDispatcher", () => {
  test("call registered method returns result", async () => {
    const dispatcher = createRpcDispatcher([reg("echo", async (params) => ({ echoed: params }))])
    const result = await dispatcher.call("test.echo", { msg: "hi" }, { config: {} })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result).toEqual({ echoed: { msg: "hi" } })
  })

  test("call unknown method returns error", async () => {
    const dispatcher = createRpcDispatcher([])
    const result = await dispatcher.call("nonexistent", {}, { config: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("unknown rpc method")
  })

  test("handler error returns error result", async () => {
    const dispatcher = createRpcDispatcher([
      reg("fail", async () => {
        throw new Error("rpc boom")
      }),
    ])
    const result = await dispatcher.call("test.fail", {}, { config: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("rpc boom")
  })

  test("handler receives context", async () => {
    let captured: unknown
    const dispatcher = createRpcDispatcher([
      reg("ctx", async (_, ctx) => {
        captured = ctx
        return null
      }),
    ])
    await dispatcher.call("test.ctx", null, { callerId: "other", sessionID: "s1", config: { key: "val" } })
    expect(captured).toEqual({ callerId: "other", sessionID: "s1", config: { key: "val" } })
  })

  test("list returns all registered methods", () => {
    const dispatcher = createRpcDispatcher([
      reg("analyze"),
      { ...reg("process"), pluginId: "beta", qualifiedName: "beta.process" },
    ])
    const list = dispatcher.list()
    expect(list.length).toBe(2)
    expect(list[0].name).toBe("test.analyze")
    expect(list[1].name).toBe("beta.process")
  })

  test("has returns true for registered methods", () => {
    const dispatcher = createRpcDispatcher([reg("analyze")])
    expect(dispatcher.has("test.analyze")).toBe(true)
    expect(dispatcher.has("missing")).toBe(false)
  })

  test("later registration overwrites earlier", async () => {
    const dispatcher = createRpcDispatcher([
      reg("dup", async () => "first"),
      { ...reg("dup", async () => "second"), qualifiedName: "test.dup" },
    ])
    const result = await dispatcher.call("test.dup", null, { config: {} })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result).toBe("second")
  })

  test("async handler is properly awaited", async () => {
    const dispatcher = createRpcDispatcher([
      reg("slow", async () => {
        await new Promise((r) => setTimeout(r, 20))
        return "done"
      }),
    ])
    const result = await dispatcher.call("test.slow", null, { config: {} })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result).toBe("done")
  })
})
