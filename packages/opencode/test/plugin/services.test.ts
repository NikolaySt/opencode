import { describe, expect, test } from "bun:test"
import { startPluginServices } from "../../src/plugin/services"
import { createPluginRegistry, createPluginRecord } from "../../src/plugin/registry"

describe("plugin.services", () => {
  test("starts and stops a service", async () => {
    const { registry } = createPluginRegistry()
    const record = createPluginRecord({
      id: "test",
      source: "/test.ts",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    })
    registry.plugins.push(record)

    let started = false
    let stopped = false

    registry.services.push({
      pluginId: "test",
      service: {
        id: "bg-worker",
        async start() {
          started = true
        },
        async stop() {
          stopped = true
        },
      },
      source: "/test.ts",
    })

    const handle = await startPluginServices({ registry, config: {} })
    expect(started).toBe(true)
    expect(stopped).toBe(false)

    await handle.stop()
    expect(stopped).toBe(true)
  })

  test("handles service start failure gracefully", async () => {
    const { registry } = createPluginRegistry()
    registry.services.push({
      pluginId: "broken",
      service: {
        id: "broken-svc",
        async start() {
          throw new Error("start failed")
        },
      },
      source: "/broken.ts",
    })

    // Should not throw — error is caught and logged internally
    const handle = await startPluginServices({ registry, config: {} })
    expect(handle).toBeDefined()
    expect(handle.stop).toBeInstanceOf(Function)
    await handle.stop()
  })

  test("stops services in reverse order", async () => {
    const { registry } = createPluginRegistry()
    const order: string[] = []

    registry.services.push({
      pluginId: "a",
      service: {
        id: "svc-a",
        async start() {},
        async stop() {
          order.push("a")
        },
      },
      source: "/a.ts",
    })
    registry.services.push({
      pluginId: "b",
      service: {
        id: "svc-b",
        async start() {},
        async stop() {
          order.push("b")
        },
      },
      source: "/b.ts",
    })

    const handle = await startPluginServices({ registry, config: {} })
    await handle.stop()
    expect(order).toEqual(["b", "a"])
  })

  test("passes abort signal to services", async () => {
    const { registry } = createPluginRegistry()
    let signal: AbortSignal | undefined

    registry.services.push({
      pluginId: "sig",
      service: {
        id: "sig-svc",
        async start(ctx) {
          signal = ctx.abort
        },
      },
      source: "/sig.ts",
    })

    const handle = await startPluginServices({ registry, config: {} })
    expect(signal).toBeDefined()
    expect(signal!.aborted).toBe(false)

    await handle.stop()
    expect(signal!.aborted).toBe(true)
  })

  test("passes plugin config to services", async () => {
    const { registry } = createPluginRegistry()
    let received: Record<string, unknown> | undefined

    registry.services.push({
      pluginId: "cfg",
      service: {
        id: "cfg-svc",
        async start(ctx) {
          received = ctx.pluginConfig
        },
      },
      pluginConfig: { apiKey: "secret" },
      source: "/cfg.ts",
    })

    const handle = await startPluginServices({ registry, config: {} })
    expect(received).toEqual({ apiKey: "secret" })
    await handle.stop()
  })
})
