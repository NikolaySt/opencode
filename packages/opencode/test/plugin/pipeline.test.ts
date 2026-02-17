import { describe, test, expect } from "bun:test"
import {
  assemble,
  compile,
  createPipeline,
  STAGE,
  type PipelineStage,
  type PipelineContext,
  type PipelineStageRegistration,
} from "../../src/plugin/pipeline"

function stage(name: string, fn?: (ctx: PipelineContext) => void): PipelineStage {
  return {
    name,
    handler: async (ctx, next) => {
      fn?.(ctx)
      await next()
    },
  }
}

function ctx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    sessionID: "test-session",
    abort: new AbortController().signal,
    metadata: {},
    ...overrides,
  }
}

function reg(
  name: string,
  position: PipelineStageRegistration["position"],
  fn?: (ctx: PipelineContext) => void,
): PipelineStageRegistration {
  return {
    pluginId: "test-plugin",
    stage: stage(name, fn),
    position,
    source: "/test",
  }
}

describe("assemble", () => {
  test("returns builtins unchanged when no registrations", () => {
    const builtins = [stage("a"), stage("b"), stage("c")]
    const result = assemble(builtins, [])
    expect(result.map((s) => s.name)).toEqual(["a", "b", "c"])
  })

  test("inserts before target", () => {
    const builtins = [stage("a"), stage("b"), stage("c")]
    const result = assemble(builtins, [reg("x", { type: "before", target: "b" })])
    expect(result.map((s) => s.name)).toEqual(["a", "x", "b", "c"])
  })

  test("inserts after target", () => {
    const builtins = [stage("a"), stage("b"), stage("c")]
    const result = assemble(builtins, [reg("x", { type: "after", target: "b" })])
    expect(result.map((s) => s.name)).toEqual(["a", "b", "x", "c"])
  })

  test("replaces target", () => {
    const builtins = [stage("a"), stage("b"), stage("c")]
    const result = assemble(builtins, [reg("b-replacement", { type: "replace", target: "b" })])
    expect(result.map((s) => s.name)).toEqual(["a", "b-replacement", "c"])
  })

  test("unknown target is skipped gracefully", () => {
    const builtins = [stage("a")]
    const result = assemble(builtins, [reg("x", { type: "before", target: "missing" })])
    expect(result.map((s) => s.name)).toEqual(["a"])
  })

  test("multiple befores at same target preserve registration order", () => {
    const builtins = [stage("a"), stage("b")]
    const result = assemble(builtins, [
      reg("x1", { type: "before", target: "b" }),
      reg("x2", { type: "before", target: "b" }),
    ])
    expect(result.map((s) => s.name)).toEqual(["a", "x1", "x2", "b"])
  })

  test("multiple afters at same target preserve registration order", () => {
    const builtins = [stage("a"), stage("b"), stage("c")]
    const result = assemble(builtins, [
      reg("x1", { type: "after", target: "b" }),
      reg("x2", { type: "after", target: "b" }),
    ])
    expect(result.map((s) => s.name)).toEqual(["a", "b", "x1", "x2", "c"])
  })

  test("replace then insert before/after the replacement", () => {
    const builtins = [stage("a"), stage("b"), stage("c")]
    const result = assemble(builtins, [
      reg("new-b", { type: "replace", target: "b" }),
      reg("before-new-b", { type: "before", target: "new-b" }),
      reg("after-new-b", { type: "after", target: "new-b" }),
    ])
    expect(result.map((s) => s.name)).toEqual(["a", "before-new-b", "new-b", "after-new-b", "c"])
  })
})

describe("compile", () => {
  test("executes stages in order", async () => {
    const order: string[] = []
    const pipeline = compile([
      {
        name: "a",
        handler: async (_, next) => {
          order.push("a")
          await next()
        },
      },
      {
        name: "b",
        handler: async (_, next) => {
          order.push("b")
          await next()
        },
      },
      {
        name: "c",
        handler: async (_, next) => {
          order.push("c")
          await next()
        },
      },
    ])
    await pipeline(ctx())
    expect(order).toEqual(["a", "b", "c"])
  })

  test("stage can short-circuit by not calling next", async () => {
    const order: string[] = []
    const pipeline = compile([
      {
        name: "a",
        handler: async (_, next) => {
          order.push("a")
          await next()
        },
      },
      {
        name: "b",
        handler: async () => {
          order.push("b-stop")
        },
      },
      {
        name: "c",
        handler: async (_, next) => {
          order.push("c")
          await next()
        },
      },
    ])
    await pipeline(ctx())
    expect(order).toEqual(["a", "b-stop"])
  })

  test("stages share context", async () => {
    const pipeline = compile([
      {
        name: "writer",
        handler: async (c, next) => {
          c.metadata.value = 42
          await next()
        },
      },
      {
        name: "reader",
        handler: async (c, next) => {
          c.metadata.doubled = (c.metadata.value as number) * 2
          await next()
        },
      },
    ])
    const c = ctx()
    await pipeline(c)
    expect(c.metadata.value).toBe(42)
    expect(c.metadata.doubled).toBe(84)
  })

  test("error in stage propagates", async () => {
    const pipeline = compile([
      {
        name: "fail",
        handler: async () => {
          throw new Error("boom")
        },
      },
    ])
    await expect(pipeline(ctx())).rejects.toThrow("boom")
  })

  test("empty pipeline resolves immediately", async () => {
    const pipeline = compile([])
    await pipeline(ctx()) // should not throw
  })

  test("calling next() multiple times throws", async () => {
    const pipeline = compile([
      {
        name: "double-next",
        handler: async (_, next) => {
          await next()
          await next() // second call
        },
      },
    ])
    await expect(pipeline(ctx())).rejects.toThrow("next() called multiple times")
  })

  test("post-next code runs after downstream completes", async () => {
    const order: string[] = []
    const pipeline = compile([
      {
        name: "a",
        handler: async (_, next) => {
          order.push("a-before")
          await next()
          order.push("a-after")
        },
      },
      {
        name: "b",
        handler: async (_, next) => {
          order.push("b")
          await next()
        },
      },
    ])
    await pipeline(ctx())
    expect(order).toEqual(["a-before", "b", "a-after"])
  })

  test("finalNext is called after all stages", async () => {
    let called = false
    const pipeline = compile([
      {
        name: "a",
        handler: async (_, next) => {
          await next()
        },
      },
    ])
    await pipeline(ctx(), async () => {
      called = true
    })
    expect(called).toBe(true)
  })
})

describe("createPipeline", () => {
  test("assembles and compiles in one step", async () => {
    const order: string[] = []
    const builtins = [
      {
        name: "a",
        handler: async (_: PipelineContext, next: () => Promise<void>) => {
          order.push("a")
          await next()
        },
      },
      {
        name: "b",
        handler: async (_: PipelineContext, next: () => Promise<void>) => {
          order.push("b")
          await next()
        },
      },
    ]
    const regs: PipelineStageRegistration[] = [reg("x", { type: "before", target: "b" }, () => order.push("x"))]
    const pipeline = createPipeline(builtins, regs)
    await pipeline(ctx())
    expect(order).toEqual(["a", "x", "b"])
  })
})

describe("STAGE constants", () => {
  test("all stage names are defined", () => {
    expect(STAGE.VALIDATE).toBe("validate")
    expect(STAGE.CHAT_COMMAND).toBe("chat-command")
    expect(STAGE.CREATE_MESSAGE).toBe("create-message")
    expect(STAGE.RESOLVE_AGENT).toBe("resolve-agent")
    expect(STAGE.RESOLVE_TOOLS).toBe("resolve-tools")
    expect(STAGE.BUILD_SYSTEM).toBe("build-system")
    expect(STAGE.AGENT_START).toBe("agent-start")
    expect(STAGE.PRE_SEND).toBe("pre-send")
    expect(STAGE.PROCESS).toBe("process")
    expect(STAGE.POST_PROCESS).toBe("post-process")
    expect(STAGE.COMPACTION_CHECK).toBe("compaction-check")
  })
})
