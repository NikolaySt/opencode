import { describe, expect, test } from "bun:test"
import {
  createPluginRegistry,
  createPluginRecord,
  type PluginApi,
  type PluginChatCommandDefinition,
} from "../../src/plugin/registry"

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
  const api = factory.createApi(record, { config: { foo: 1 }, pluginConfig: { key: "val" } })
  return { factory, record, api }
}

describe("plugin.registry", () => {
  describe("createPluginRecord", () => {
    test("sets defaults", () => {
      const record = createPluginRecord({
        id: "my-plugin",
        source: "/path/to/plugin.ts",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      })
      expect(record.name).toBe("my-plugin")
      expect(record.status).toBe("loaded")
      expect(record.toolNames).toEqual([])
      expect(record.hookCount).toBe(0)
      expect(record.services).toEqual([])
    })

    test("uses name when provided", () => {
      const record = createPluginRecord({
        id: "my-plugin",
        name: "My Plugin",
        source: "/path",
        origin: "config",
        enabled: false,
        configSchema: false,
      })
      expect(record.name).toBe("My Plugin")
      expect(record.status).toBe("disabled")
    })
  })

  describe("createApi", () => {
    test("exposes plugin metadata", () => {
      const { api } = setup()
      expect(api.id).toBe("test-plugin")
      expect(api.source).toBe("/test/plugin.ts")
      expect(api.pluginConfig).toEqual({ key: "val" })
    })

    test("registerTool adds to registry", () => {
      const { factory, api } = setup()
      const tool = { description: "a tool", args: {}, execute: async () => "ok" }
      api.registerTool(tool, { name: "my-tool" })
      expect(factory.registry.tools.length).toBe(1)
      expect(factory.registry.tools[0].name).toBe("my-tool")
    })

    test("registerTool falls back to record id for name", () => {
      const { factory, api } = setup()
      const tool = { description: "a tool", args: {}, execute: async () => "ok" }
      api.registerTool(tool)
      expect(factory.registry.tools[0].name).toBe("test-plugin")
    })

    test("registerTool warns on duplicate name", () => {
      const { factory, api } = setup()
      const tool = { description: "a tool", args: {}, execute: async () => "ok" }
      api.registerTool(tool, { name: "dup-tool" })
      api.registerTool(tool, { name: "dup-tool" })
      // Both are registered (override allowed), but a warning diagnostic is pushed
      expect(factory.registry.tools.length).toBe(2)
      expect(factory.registry.diagnostics.some((d) => d.message.includes("duplicate tool registration"))).toBe(true)
      expect(factory.registry.diagnostics.find((d) => d.message.includes("duplicate"))?.level).toBe("warn")
    })

    test("on registers typed hooks", () => {
      const { factory, api, record } = setup()
      api.on("session.created", () => {})
      api.on("tool.before", () => {})
      expect(factory.registry.typedHooks.length).toBe(2)
      expect(record.hookCount).toBe(2)
    })

    test("on with priority", () => {
      const { factory, api } = setup()
      api.on("session.created", () => {}, { priority: 10 })
      expect(factory.registry.typedHooks[0].priority).toBe(10)
    })

    test("registerCli adds to registry", () => {
      const { factory, api, record } = setup()
      api.registerCli(async () => {}, { commands: ["stats", "report"] })
      expect(factory.registry.cliRegistrars.length).toBe(1)
      expect(record.cliCommands).toEqual(["stats", "report"])
    })

    test("registerChatCommand adds to registry", () => {
      const { factory, api, record } = setup()
      api.registerChatCommand({ name: "ping", description: "pong", handler: async () => ({ text: "pong" }) })
      expect(factory.registry.chatCommands.length).toBe(1)
      expect(record.chatCommands).toEqual(["ping"])
    })

    test("registerChatCommand rejects empty name", () => {
      const { factory, api, record } = setup()
      api.registerChatCommand({ name: "  ", description: "empty", handler: async () => ({ text: "" }) })
      expect(factory.registry.chatCommands.length).toBe(0)
      expect(factory.registry.diagnostics.some((d) => d.message.includes("missing name"))).toBe(true)
    })

    test("registerHttpHandler adds to registry", () => {
      const { factory, api, record } = setup()
      api.registerHttpHandler(async () => null)
      expect(factory.registry.httpHandlers.length).toBe(1)
      expect(record.httpHandlers).toBe(1)
    })

    test("registerHttpRoute normalizes path", () => {
      const { factory, api } = setup()
      api.registerHttpRoute({ path: "/status", handler: async () => new Response("ok") })
      expect(factory.registry.httpRoutes[0].path).toBe("/plugins/test-plugin/status")
    })

    test("registerHttpRoute rejects duplicates", () => {
      const { factory, api } = setup()
      api.registerHttpRoute({ path: "/dup", handler: async () => new Response("1") })
      api.registerHttpRoute({ path: "/dup", handler: async () => new Response("2") })
      expect(factory.registry.httpRoutes.length).toBe(1)
      expect(factory.registry.diagnostics.some((d) => d.message.includes("already registered"))).toBe(true)
    })

    test("registerService adds to registry", () => {
      const { factory, api, record } = setup()
      api.registerService({ id: "worker", start: async () => {} })
      expect(factory.registry.services.length).toBe(1)
      expect(record.services).toEqual(["worker"])
    })

    test("registerService with empty id pushes diagnostic", () => {
      const { factory, api } = setup()
      api.registerService({ id: "  ", start: async () => {} })
      expect(factory.registry.services.length).toBe(0)
      expect(factory.registry.diagnostics.some((d) => d.message.includes("service registration missing id"))).toBe(true)
    })

    test("logger methods do not throw", () => {
      const { api } = setup()
      expect(() => api.logger.info("test")).not.toThrow()
      expect(() => api.logger.warn("test")).not.toThrow()
      expect(() => api.logger.error("test")).not.toThrow()
      expect(() => api.logger.debug?.("test")).not.toThrow()
    })
  })

  describe("registerToolFactory", () => {
    test("adds factory to registry", () => {
      const { factory, api, record } = setup()
      api.registerToolFactory(() => ({ description: "dynamic tool", args: {}, execute: async () => "ok" }), {
        names: ["dyn-tool"],
      })
      expect(factory.registry.toolFactories.length).toBe(1)
      expect(factory.registry.toolFactories[0].pluginId).toBe("test-plugin")
      expect(factory.registry.toolFactories[0].names).toEqual(["dyn-tool"])
      expect(record.toolNames).toContain("dyn-tool")
    })

    test("factory receives plugin config", () => {
      const { factory, record } = setup()
      const api = factory.createApi(record, { config: {}, pluginConfig: { key: "secret" } })
      api.registerToolFactory(() => null)
      expect(factory.registry.toolFactories[0].pluginConfig).toEqual({ key: "secret" })
    })

    test("factory with no names adds empty array", () => {
      const { factory, api } = setup()
      api.registerToolFactory(() => null)
      expect(factory.registry.toolFactories[0].names).toEqual([])
    })

    test("factory can return array of tools", () => {
      const { factory, api } = setup()
      api.registerToolFactory(
        () => [
          { description: "tool a", args: {}, execute: async () => "a" },
          { description: "tool b", args: {}, execute: async () => "b" },
        ],
        { names: ["tool-a", "tool-b"] },
      )
      expect(factory.registry.toolFactories.length).toBe(1)
    })
  })

  describe("pushDiagnostic", () => {
    test("adds diagnostics to registry", () => {
      const { factory } = setup()
      factory.pushDiagnostic({ level: "warn", message: "test warning", source: "/test.ts" })
      expect(factory.registry.diagnostics.length).toBe(1)
      expect(factory.registry.diagnostics[0].level).toBe("warn")
    })
  })
})
