import { describe, expect, test } from "bun:test"
import {
  createPluginRegistry,
  createPluginRecord,
  type PluginHttpHandler,
  type PluginHttpRouteHandler,
} from "../../src/plugin/registry"

function setup() {
  const factory = createPluginRegistry()
  const record = createPluginRecord({
    id: "http-plugin",
    source: "/http/plugin.ts",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  })
  factory.registry.plugins.push(record)
  const api = factory.createApi(record, { config: {} })
  return { factory, record, api }
}

describe("plugin.http", () => {
  describe("route registration", () => {
    test("routes are namespaced under /plugins/{id}", () => {
      const { factory, api } = setup()
      api.registerHttpRoute({ path: "/health", handler: async () => new Response("ok") })
      expect(factory.registry.httpRoutes[0].path).toBe("/plugins/http-plugin/health")
    })

    test("routes without leading slash are normalized", () => {
      const { factory, api } = setup()
      api.registerHttpRoute({ path: "data", handler: async () => new Response("ok") })
      expect(factory.registry.httpRoutes[0].path).toBe("/plugins/http-plugin/data")
    })

    test("duplicate route paths are rejected", () => {
      const { factory, api } = setup()
      api.registerHttpRoute({ path: "/x", handler: async () => new Response("1") })
      api.registerHttpRoute({ path: "/x", handler: async () => new Response("2") })
      expect(factory.registry.httpRoutes.length).toBe(1)
      expect(factory.registry.diagnostics.length).toBeGreaterThan(0)
    })
  })

  describe("handler registration", () => {
    test("generic handler increments httpHandlers count", () => {
      const { record, api } = setup()
      api.registerHttpHandler(async () => null)
      api.registerHttpHandler(async () => null)
      expect(record.httpHandlers).toBe(2)
    })
  })

  describe("route handler dispatch (unit)", () => {
    test("route handler returns response for matching path", async () => {
      const { factory, api } = setup()
      api.registerHttpRoute({
        path: "/echo",
        handler: async (req) => new Response(`echo: ${new URL(req.url).pathname}`),
      })

      const route = factory.registry.httpRoutes[0]
      const req = new Request("http://localhost/plugins/http-plugin/echo")
      const res = await route.handler(req)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("echo: /plugins/http-plugin/echo")
    })

    test("generic handler can return null to pass through", async () => {
      const { factory, api } = setup()
      api.registerHttpHandler(async () => null)
      const handler = factory.registry.httpHandlers[0]
      const req = new Request("http://localhost/plugins/http-plugin/unknown")
      const res = await handler.handler(req)
      expect(res).toBeNull()
    })

    test("generic handler can return a response", async () => {
      const { factory, api } = setup()
      api.registerHttpHandler(async (req) => {
        if (new URL(req.url).pathname.includes("catch")) return new Response("caught")
        return null
      })
      const handler = factory.registry.httpHandlers[0]
      const req = new Request("http://localhost/plugins/http-plugin/catch-me")
      const res = await handler.handler(req)
      expect(res).not.toBeNull()
      expect(await res!.text()).toBe("caught")
    })
  })
})
