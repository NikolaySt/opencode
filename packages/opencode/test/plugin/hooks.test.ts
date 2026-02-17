import { describe, expect, test } from "bun:test"
import { createHookRunner } from "../../src/plugin/hooks"
import { createPluginRegistry, createPluginRecord } from "../../src/plugin/registry"

function setup() {
  const factory = createPluginRegistry()
  const record = createPluginRecord({
    id: "test-plugin",
    source: "/test/plugin.ts",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  })
  factory.registry.plugins.push(record)
  const api = factory.createApi(record, { config: {} })
  return { registry: factory.registry, record, api }
}

describe("plugin.hooks", () => {
  describe("void hooks", () => {
    test("runs session.created hook", async () => {
      const { registry, api } = setup()
      let called = false
      api.on("session.created", () => {
        called = true
      })
      const runner = createHookRunner(registry)
      await runner.runSessionCreated({ sessionID: "sess-1" })
      expect(called).toBe(true)
    })

    test("runs multiple handlers in parallel", async () => {
      const { registry, api } = setup()
      const order: number[] = []
      api.on("agent.finish", async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push(1)
      })
      api.on("agent.finish", () => {
        order.push(2)
      })
      const runner = createHookRunner(registry)
      await runner.runAgentFinish({ sessionID: "s", agent: "code", success: true })
      // Sync handler (2) completes before the sleeping handler (1) — proves parallel execution
      expect(order).toEqual([2, 1])
    })

    test("catches errors by default", async () => {
      const { registry, api } = setup()
      let called = false
      api.on("session.archived", () => {
        called = true
        throw new Error("boom")
      })
      const runner = createHookRunner(registry)
      // Should not throw even though handler throws
      await runner.runSessionArchived({ sessionID: "s" })
      expect(called).toBe(true)
    })

    test("throws errors when catchErrors is false", async () => {
      const { registry, api } = setup()
      api.on("session.archived", () => {
        throw new Error("boom")
      })
      const runner = createHookRunner(registry, { catchErrors: false })
      await expect(runner.runSessionArchived({ sessionID: "s" })).rejects.toThrow("boom")
    })

    test("all handlers run even when one throws with catchErrors=false", async () => {
      const factory = createPluginRegistry()
      const rec1 = createPluginRecord({
        id: "p1",
        source: "/p1.ts",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      })
      const rec2 = createPluginRecord({
        id: "p2",
        source: "/p2.ts",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      })
      factory.registry.plugins.push(rec1, rec2)
      const api1 = factory.createApi(rec1, { config: {} })
      const api2 = factory.createApi(rec2, { config: {} })

      let handler2Ran = false
      api1.on("session.archived", () => {
        throw new Error("handler1 fails")
      })
      api2.on("session.archived", async () => {
        await new Promise((r) => setTimeout(r, 5))
        handler2Ran = true
      })

      const runner = createHookRunner(factory.registry, { catchErrors: false })
      await expect(runner.runSessionArchived({ sessionID: "s" })).rejects.toThrow()
      // Despite the rejection, handler2 should have completed thanks to allSettled
      expect(handler2Ran).toBe(true)
    })
  })

  describe("modifying hooks", () => {
    test("agent.start returns merged result", async () => {
      const { registry, api } = setup()
      api.on("agent.start", () => ({ systemPrompt: "extra context" }))
      const runner = createHookRunner(registry)
      const result = await runner.runAgentStart({
        sessionID: "s",
        agent: "code",
        model: { providerID: "anthropic", modelID: "claude-4" },
      })
      expect(result?.systemPrompt).toBe("extra context")
    })

    test("agent.start merges prependContext from multiple handlers", async () => {
      const factory = createPluginRegistry()
      const rec1 = createPluginRecord({
        id: "p1",
        source: "/p1.ts",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      })
      const rec2 = createPluginRecord({
        id: "p2",
        source: "/p2.ts",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      })
      factory.registry.plugins.push(rec1, rec2)
      const api1 = factory.createApi(rec1, { config: {} })
      const api2 = factory.createApi(rec2, { config: {} })

      api1.on("agent.start", () => ({ prependContext: "context A" }))
      api2.on("agent.start", () => ({ prependContext: "context B" }))

      const runner = createHookRunner(factory.registry)
      const result = await runner.runAgentStart({
        sessionID: "s",
        agent: "code",
        model: { providerID: "anthropic", modelID: "claude-4" },
      })
      expect(result?.prependContext).toContain("context A")
      expect(result?.prependContext).toContain("context B")
    })

    test("tool.block returns merged result", async () => {
      const { registry, api } = setup()
      api.on("tool.block", () => ({ block: true, reason: "denied by policy" }))
      const runner = createHookRunner(registry)
      const result = await runner.runToolBlock({
        tool: "bash",
        args: { command: "rm -rf /" },
        sessionID: "s",
      })
      expect(result?.block).toBe(true)
      expect(result?.reason).toBe("denied by policy")
    })

    test("message.sending returns merged result", async () => {
      const { registry, api } = setup()
      api.on("message.sending", () => ({ content: "modified content" }))
      const runner = createHookRunner(registry)
      const result = await runner.runMessageSending({
        sessionID: "s",
        content: "original",
      })
      expect(result?.content).toBe("modified content")
    })
  })

  describe("priority ordering", () => {
    test("higher priority runs first in modifying hooks", async () => {
      const { registry, api } = setup()
      api.on("agent.start", () => ({ systemPrompt: "low" }), { priority: 1 })
      api.on("agent.start", () => ({ systemPrompt: "high" }), { priority: 10 })
      const runner = createHookRunner(registry)
      const result = await runner.runAgentStart({
        sessionID: "s",
        agent: "code",
        model: { providerID: "a", modelID: "b" },
      })
      // Last writer wins in modifying hooks, so low priority (runs second) wins
      expect(result?.systemPrompt).toBe("low")
    })
  })

  describe("message.sent hook", () => {
    test("fires as void hook", async () => {
      const { registry, api } = setup()
      let received: { messageID: string; success: boolean } | undefined
      api.on("message.sent", (event) => {
        received = { messageID: event.messageID, success: event.success }
      })
      const runner = createHookRunner(registry)
      await runner.runMessageSent({ sessionID: "s", messageID: "msg-1", success: true })
      expect(received).toBeDefined()
      expect(received!.messageID).toBe("msg-1")
      expect(received!.success).toBe(true)
    })

    test("receives error information", async () => {
      const { registry, api } = setup()
      let received: { error?: string; durationMs?: number } | undefined
      api.on("message.sent", (event) => {
        received = { error: event.error, durationMs: event.durationMs }
      })
      const runner = createHookRunner(registry)
      await runner.runMessageSent({
        sessionID: "s",
        messageID: "msg-2",
        success: false,
        error: "timeout",
        durationMs: 5000,
      })
      expect(received?.error).toBe("timeout")
      expect(received?.durationMs).toBe(5000)
    })
  })

  describe("tool.result.persist hook", () => {
    test("returns modified output", async () => {
      const { registry, api } = setup()
      api.on("tool.result.persist", () => ({ output: "redacted" }))
      const runner = createHookRunner(registry)
      const result = await runner.runToolResultPersist({
        sessionID: "s",
        tool: "bash",
        callID: "call-1",
        output: "secret data",
        title: "bash result",
        metadata: {},
        input: { command: "echo hi" },
      })
      expect(result?.output).toBe("redacted")
    })

    test("merges metadata from multiple handlers", async () => {
      const factory = createPluginRegistry()
      const rec1 = createPluginRecord({
        id: "p1",
        source: "/p1.ts",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      })
      const rec2 = createPluginRecord({
        id: "p2",
        source: "/p2.ts",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      })
      factory.registry.plugins.push(rec1, rec2)
      const api1 = factory.createApi(rec1, { config: {} })
      const api2 = factory.createApi(rec2, { config: {} })

      api1.on("tool.result.persist", () => ({ metadata: { tagged: true } }))
      api2.on("tool.result.persist", () => ({ metadata: { source: "plugin" } }))

      const runner = createHookRunner(factory.registry)
      const result = await runner.runToolResultPersist({
        sessionID: "s",
        tool: "read",
        callID: "c1",
        output: "file contents",
        title: "read",
        metadata: {},
        input: { path: "/file.ts" },
      })
      expect(result?.metadata).toEqual({ tagged: true, source: "plugin" })
    })

    test("preserves original values when handler returns undefined", async () => {
      const { registry, api } = setup()
      api.on("tool.result.persist", () => {})
      const runner = createHookRunner(registry)
      const result = await runner.runToolResultPersist({
        sessionID: "s",
        tool: "bash",
        callID: "c1",
        output: "original",
        title: "original title",
        metadata: { key: "val" },
        input: {},
      })
      expect(result).toBeUndefined()
    })
  })

  describe("utility", () => {
    test("hasHooks returns false for empty registry", () => {
      const factory = createPluginRegistry()
      const runner = createHookRunner(factory.registry)
      expect(runner.hasHooks("session.created")).toBe(false)
    })

    test("hasHooks returns true when hooks exist", () => {
      const { registry, api } = setup()
      api.on("session.created", () => {})
      const runner = createHookRunner(registry)
      expect(runner.hasHooks("session.created")).toBe(true)
    })

    test("count returns correct number", () => {
      const { registry, api } = setup()
      api.on("tool.before", () => {})
      api.on("tool.before", () => {})
      api.on("tool.after", () => {})
      const runner = createHookRunner(registry)
      expect(runner.count("tool.before")).toBe(2)
      expect(runner.count("tool.after")).toBe(1)
      expect(runner.count("server.start")).toBe(0)
    })
  })
})
