import { describe, test, expect } from "bun:test"
import {
  createSessionMap,
  sessionKey,
  startChannels,
  type ChannelAdapter,
  type ChannelMessage,
  type ChannelResponse,
} from "../../src/plugin/channel"
import { createPluginRegistry } from "../../src/plugin/registry"

describe("ChannelSessionMap", () => {
  test("set and get", () => {
    const map = createSessionMap()
    map.set("channel:slack:U123", "sess-1")
    expect(map.get("channel:slack:U123")).toBe("sess-1")
  })

  test("returns undefined for missing keys", () => {
    const map = createSessionMap()
    expect(map.get("missing")).toBeUndefined()
  })

  test("delete removes entry", () => {
    const map = createSessionMap()
    map.set("key", "val")
    expect(map.delete("key")).toBe(true)
    expect(map.get("key")).toBeUndefined()
  })

  test("keys returns all keys", () => {
    const map = createSessionMap()
    map.set("a", "1")
    map.set("b", "2")
    expect(map.keys()).toEqual(["a", "b"])
  })
})

describe("sessionKey", () => {
  const msg: ChannelMessage = {
    channel: "slack",
    source: { id: "U123", name: "user", group: "C456" },
    content: "hello",
    threadID: "T789",
  }

  test("source scope uses source id", () => {
    expect(sessionKey(msg, "source")).toBe("channel:slack:U123")
  })

  test("group scope uses group and thread", () => {
    expect(sessionKey(msg, "group")).toBe("channel:slack:C456:T789")
  })

  test("group scope without thread omits thread", () => {
    const noThread = { ...msg, threadID: undefined }
    expect(sessionKey(noThread, "group")).toBe("channel:slack:C456")
  })

  test("group scope without group falls back to source", () => {
    const noGroup: ChannelMessage = {
      channel: "slack",
      source: { id: "U123" },
      content: "hi",
    }
    expect(sessionKey(noGroup, "group")).toBe("channel:slack:U123")
  })

  test("global scope ignores source and group", () => {
    expect(sessionKey(msg, "global")).toBe("channel:slack:global")
  })

  test("default scope is source", () => {
    expect(sessionKey(msg)).toBe("channel:slack:U123")
  })
})

describe("startChannels", () => {
  function adapter(id: string, overrides?: Partial<ChannelAdapter>): ChannelAdapter {
    return {
      id,
      name: id,
      connect: async () => {},
      ...overrides,
    }
  }

  function reg(id: string, overrides?: Partial<ChannelAdapter>) {
    return {
      pluginId: `plugin-${id}`,
      adapter: adapter(id, overrides),
      source: `/plugins/${id}`,
    }
  }

  test("connects channels and returns handle", async () => {
    const connected: string[] = []
    const handle = startChannels({
      channels: [
        reg("slack", {
          connect: async () => {
            connected.push("slack")
          },
        }),
        reg("discord", {
          connect: async () => {
            connected.push("discord")
          },
        }),
      ],
      config: {},
      deliver: async () => ({ content: "ok" }),
    })
    await handle.ready
    expect(connected).toContain("slack")
    expect(connected).toContain("discord")
    expect(connected.length).toBe(2)
    await handle.stop()
  })

  test("stop disconnects in reverse order", async () => {
    const order: string[] = []
    const handle = startChannels({
      channels: [
        reg("a", {
          connect: async () => {},
          disconnect: async () => {
            order.push("a")
          },
        }),
        reg("b", {
          connect: async () => {},
          disconnect: async () => {
            order.push("b")
          },
        }),
      ],
      config: {},
      deliver: async () => ({ content: "ok" }),
    })
    await handle.ready
    await handle.stop()
    expect(order).toEqual(["b", "a"])
  })

  test("connect failure does not prevent other channels", async () => {
    const connected: string[] = []
    const handle = startChannels({
      channels: [
        reg("bad", {
          connect: async () => {
            throw new Error("fail")
          },
        }),
        reg("good", {
          connect: async () => {
            connected.push("good")
          },
        }),
      ],
      config: {},
      deliver: async () => ({ content: "ok" }),
    })
    await handle.ready
    expect(connected).toEqual(["good"])
    await handle.stop()
  })

  test("health check for connected channel", async () => {
    const handle = startChannels({
      channels: [
        reg("healthy", {
          connect: async () => {},
          health: async () => ({ ok: true }),
        }),
      ],
      config: {},
      deliver: async () => ({ content: "ok" }),
    })
    await handle.ready
    const result = await handle.health("healthy")
    expect(result.ok).toBe(true)
    await handle.stop()
  })

  test("health check for unknown channel returns error", async () => {
    const handle = startChannels({
      channels: [],
      config: {},
      deliver: async () => ({ content: "ok" }),
    })
    const result = await handle.health("missing")
    expect(result.ok).toBe(false)
    expect(result.error).toBe("channel not found")
    await handle.stop()
  })

  test("deliver function is passed to channel context", async () => {
    let response: { content: string } | undefined
    const handle = startChannels({
      channels: [
        reg("test", {
          connect: async (ctx) => {
            response = await ctx.deliver({
              channel: "test",
              source: { id: "user1" },
              content: "hello",
            })
          },
        }),
      ],
      config: {},
      deliver: async (msg) => {
        return { content: `echo: ${msg.content}` }
      },
    })
    await handle.ready
    expect(response).toBeDefined()
    expect(response!.content).toBe("echo: hello")
    await handle.stop()
  })

  test("double stop is safe", async () => {
    const handle = startChannels({
      channels: [
        reg("safe", {
          connect: async () => {},
          disconnect: async () => {},
        }),
      ],
      config: {},
      deliver: async () => ({ content: "ok" }),
    })
    await handle.ready
    await handle.stop()
    // Second stop should be a no-op, not throw
    await handle.stop()
  })

  test("disconnect handler sees non-aborted signal", async () => {
    let abortedDuringDisconnect = true
    const handle = startChannels({
      channels: [
        reg("signal-test", {
          connect: async () => {},
          disconnect: async (ctx) => {
            abortedDuringDisconnect = ctx.abort.aborted
          },
        }),
      ],
      config: {},
      deliver: async () => ({ content: "ok" }),
    })
    await handle.ready
    await handle.stop()
    // The abort signal should NOT be aborted during disconnect
    expect(abortedDuringDisconnect).toBe(false)
  })
})

describe("registerChannel via PluginApi", () => {
  test("registers channel in registry", () => {
    const { registry, createApi } = createPluginRegistry()
    const record = {
      id: "test-plugin",
      name: "Test",
      source: "/test",
      origin: "config" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: [],
      hookCount: 0,
      cliCommands: [],
      chatCommands: [],
      httpHandlers: 0,
      services: [],
      configSchema: false,
    }
    registry.plugins.push(record)
    const api = createApi(record, { config: {} })

    api.registerChannel({
      id: "mqtt",
      name: "MQTT",
      connect: async () => {},
    })

    expect(registry.channels.length).toBe(1)
    expect(registry.channels[0].adapter.id).toBe("mqtt")
    expect(registry.channels[0].pluginId).toBe("test-plugin")
  })

  test("rejects duplicate channel ids", () => {
    const { registry, createApi } = createPluginRegistry()
    const record = {
      id: "test-plugin",
      name: "Test",
      source: "/test",
      origin: "config" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: [],
      hookCount: 0,
      cliCommands: [],
      chatCommands: [],
      httpHandlers: 0,
      services: [],
      configSchema: false,
    }
    registry.plugins.push(record)
    const api = createApi(record, { config: {} })

    api.registerChannel({ id: "slack", name: "Slack", connect: async () => {} })
    api.registerChannel({ id: "slack", name: "Slack2", connect: async () => {} })

    expect(registry.channels.length).toBe(1)
    expect(registry.diagnostics.length).toBe(1)
    expect(registry.diagnostics[0].message).toContain("already registered")
  })

  test("rejects empty channel id", () => {
    const { registry, createApi } = createPluginRegistry()
    const record = {
      id: "test-plugin",
      name: "Test",
      source: "/test",
      origin: "config" as const,
      enabled: true,
      status: "loaded" as const,
      toolNames: [],
      hookCount: 0,
      cliCommands: [],
      chatCommands: [],
      httpHandlers: 0,
      services: [],
      configSchema: false,
    }
    registry.plugins.push(record)
    const api = createApi(record, { config: {} })

    api.registerChannel({ id: "", name: "Bad", connect: async () => {} })

    expect(registry.channels.length).toBe(0)
    expect(registry.diagnostics.length).toBe(1)
    expect(registry.diagnostics[0].message).toContain("missing id")
  })
})
