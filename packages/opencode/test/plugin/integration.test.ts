import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { discover } from "../../src/plugin/discovery"
import { createPluginRegistry, createPluginRecord } from "../../src/plugin/registry"
import { createHookRunner } from "../../src/plugin/hooks"
import { startPluginServices } from "../../src/plugin/services"
import { validatePluginConfig } from "../../src/plugin/validation"
import { resolveSlotDecision } from "../../src/plugin/slots"
import * as ChatCommand from "../../src/command/chat-command"

describe("plugin.integration", () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-integration-"))
    ChatCommand.clear()
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    ChatCommand.clear()
  })

  test("discover -> load -> register -> run hook (full lifecycle)", async () => {
    // 1. Write a plugin file to disk
    const extDir = path.join(tmpDir, ".opencode", "extensions")
    fs.mkdirSync(extDir, { recursive: true })
    const pluginSource = `
      let hookCalled = false
      export default {
        id: "integration-test",
        name: "Integration Test Plugin",
        version: "0.1.0",
        register(api) {
          api.on("session.created", () => { hookCalled = true })
          api.registerChatCommand({
            name: "inttest",
            description: "integration test command",
            handler: async () => ({ text: "integration ok" }),
          })
          api.registerService({
            id: "int-svc",
            start: async () => {},
            stop: async () => {},
          })
        },
      }
      export function wasHookCalled() { return hookCalled }
    `
    fs.writeFileSync(path.join(extDir, "int-plugin.ts"), pluginSource)

    // 2. Discover
    const discovered = discover({
      workspaceDir: tmpDir,
      configDirectories: [path.join(tmpDir, ".opencode")],
    })
    expect(discovered.candidates.length).toBe(1)
    expect(discovered.candidates[0].idHint).toBe("int-plugin")

    // 3. Load module
    const candidate = discovered.candidates[0]
    const mod = await import(candidate.source)

    // 4. Resolve export and register
    const factory = createPluginRegistry()
    const record = createPluginRecord({
      id: candidate.idHint,
      source: candidate.source,
      origin: candidate.origin,
      enabled: true,
      configSchema: false,
    })

    const resolved = mod.default
    expect(typeof resolved.register).toBe("function")

    const api = factory.createApi(record, { config: {} })
    resolved.register(api)
    factory.registry.plugins.push(record)

    // 5. Verify registrations
    expect(record.hookCount).toBe(1)
    expect(record.chatCommands).toEqual(["inttest"])
    expect(record.services).toEqual(["int-svc"])

    // 6. Run hook
    const runner = createHookRunner(factory.registry)
    await runner.runSessionCreated({ sessionID: "test-session" })

    // Verify hook was actually called by importing the module's state
    const { wasHookCalled } = await import(candidate.source)
    expect(wasHookCalled()).toBe(true)

    // 7. Register chat command and test it
    ChatCommand.clear()
    for (const reg of factory.registry.chatCommands) {
      ChatCommand.register(reg.pluginId, reg.command)
    }
    const matched = ChatCommand.match("/inttest")
    expect(matched).not.toBeNull()
    expect(matched!.command.name).toBe("inttest")

    // 8. Start and stop services
    const handle = await startPluginServices({ registry: factory.registry, config: {} })
    await handle.stop()
  })

  test("slot resolution integrates with registry flow", () => {
    const factory = createPluginRegistry()
    let selected: string | null = null

    // First memory plugin wins
    const decision1 = resolveSlotDecision({ id: "mem-1", kind: "memory", slot: undefined, selectedId: selected })
    expect(decision1.enabled).toBe(true)
    if (decision1.selected) selected = "mem-1"

    // Second memory plugin loses
    const decision2 = resolveSlotDecision({ id: "mem-2", kind: "memory", slot: undefined, selectedId: selected })
    expect(decision2.enabled).toBe(false)
  })

  test("validation integrates with registry flow", () => {
    const valid = validatePluginConfig({
      schema: { type: "object", required: ["endpoint"] },
      value: { endpoint: "https://api.example.com" },
    })
    expect(valid.ok).toBe(true)

    const invalid = validatePluginConfig({
      schema: { type: "object", required: ["endpoint"] },
      value: {},
    })
    expect(invalid.ok).toBe(false)
  })

  test("hook timeout fires for hung handler", async () => {
    const factory = createPluginRegistry()
    const record = createPluginRecord({
      id: "slow-plugin",
      source: "/slow.ts",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    })
    factory.registry.plugins.push(record)
    const api = factory.createApi(record, { config: {} })

    api.on("session.created", async () => {
      await new Promise((r) => setTimeout(r, 5000))
    })

    // Use a 50ms timeout to trigger quickly
    const runner = createHookRunner(factory.registry, { timeoutMs: 50 })
    // Should not throw (catchErrors: true by default), but should complete
    await runner.runSessionCreated({ sessionID: "timeout-test" })
  })

  test("service timeout fires for hung start", async () => {
    const factory = createPluginRegistry()
    factory.registry.services.push({
      pluginId: "slow",
      service: {
        id: "slow-svc",
        start: async () => {
          await new Promise((r) => setTimeout(r, 5000))
        },
      },
      source: "/slow.ts",
    })

    // 50ms timeout — the start should timeout
    const handle = await startPluginServices({
      registry: factory.registry,
      config: {},
      timeoutMs: 50,
    })
    await handle.stop()
  })

  test("chat command aliases work in integration", async () => {
    ChatCommand.clear()
    const factory = createPluginRegistry()
    const record = createPluginRecord({
      id: "alias-plugin",
      source: "/alias.ts",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    })
    factory.registry.plugins.push(record)
    const api = factory.createApi(record, { config: {} })

    api.registerChatCommand({
      name: "deploy",
      description: "deploy the app",
      aliases: ["ship", "push"],
      handler: async () => ({ text: "deployed" }),
    })

    for (const reg of factory.registry.chatCommands) {
      ChatCommand.register(reg.pluginId, reg.command)
    }

    expect(ChatCommand.match("/deploy")).not.toBeNull()
    expect(ChatCommand.match("/ship")).not.toBeNull()
    expect(ChatCommand.match("/push")).not.toBeNull()
    expect(ChatCommand.match("/nonexistent")).toBeNull()

    // List should not duplicate
    const listed = ChatCommand.list()
    expect(listed.length).toBe(1)
    expect(listed[0].name).toBe("deploy")

    ChatCommand.clear()
  })

  test("tool factory registration in full lifecycle", () => {
    const factory = createPluginRegistry()
    const record = createPluginRecord({
      id: "factory-plugin",
      source: "/factory.ts",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    })
    factory.registry.plugins.push(record)
    const api = factory.createApi(record, { config: {}, pluginConfig: { model: "gpt-4" } })

    api.registerToolFactory(
      (ctx) => {
        if (!ctx.agent) return null
        return { description: `tool for ${ctx.agent}`, args: {}, execute: async () => "ok" }
      },
      { names: ["dynamic-tool"] },
    )

    expect(factory.registry.toolFactories.length).toBe(1)
    expect(record.toolNames).toContain("dynamic-tool")

    // Invoke the factory with agent context
    const tool = factory.registry.toolFactories[0].factory({ config: {}, agent: "code" })
    expect(tool).not.toBeNull()
    expect((tool as { description: string }).description).toBe("tool for code")

    // Invoke without agent — should return null
    const noTool = factory.registry.toolFactories[0].factory({ config: {} })
    expect(noTool).toBeNull()
  })

  test("tool.result.persist hook modifies output in integration", async () => {
    const factory = createPluginRegistry()
    const record = createPluginRecord({
      id: "persist-plugin",
      source: "/persist.ts",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    })
    factory.registry.plugins.push(record)
    const api = factory.createApi(record, { config: {} })

    api.on("tool.result.persist", (event) => {
      if (event.tool === "bash") {
        return { output: event.output.replace(/secret/g, "***"), metadata: { ...event.metadata, redacted: true } }
      }
    })

    const runner = createHookRunner(factory.registry)
    const result = await runner.runToolResultPersist({
      sessionID: "s",
      tool: "bash",
      callID: "c1",
      output: "the secret value is secret",
      title: "bash",
      metadata: { key: "val" },
      input: { command: "echo secret" },
    })

    expect(result?.output).toBe("the *** value is ***")
    expect(result?.metadata).toEqual({ key: "val", redacted: true })
  })
})
