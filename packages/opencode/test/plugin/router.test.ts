import { describe, test, expect } from "bun:test"
import { resolveRoute, type RouteRegistration } from "../../src/plugin/router"
import type { ChannelMessage } from "../../src/plugin/channel"

function route(id: string, overrides: Partial<RouteRegistration["route"]>): RouteRegistration {
  return {
    pluginId: "test",
    route: {
      id,
      match: { type: "default" },
      agent: "build",
      ...overrides,
    },
    source: "/test",
  }
}

function msg(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    channel: "slack",
    source: { id: "U123", group: "C456" },
    content: "hello world",
    ...overrides,
  }
}

describe("resolveRoute", () => {
  test("source match takes priority", () => {
    const routes = [
      route("channel-wide", { match: { type: "channel", channel: "slack" }, agent: "general" }),
      route("exact-user", {
        match: { type: "source", channel: "slack", sourceId: "U123" },
        agent: "vip-agent",
        priority: 10,
      }),
    ]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.agent).toBe("vip-agent")
    expect(result.matchedBy).toBe("source:slack:U123")
    expect(result.routeId).toBe("exact-user")
  })

  test("group match", () => {
    const routes = [
      route("group-route", { match: { type: "group", channel: "slack", groupId: "C456" }, agent: "team-agent" }),
    ]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.agent).toBe("team-agent")
    expect(result.matchedBy).toBe("group:slack:C456")
  })

  test("pattern match with string", () => {
    const routes = [route("deploy-route", { match: { type: "pattern", pattern: "deploy" }, agent: "devops" })]
    const result = resolveRoute(routes, msg({ content: "please deploy to staging" }), "build")
    expect(result.agent).toBe("devops")
    expect(result.matchedBy).toContain("pattern")
  })

  test("pattern match with RegExp", () => {
    const routes = [route("urgent", { match: { type: "pattern", pattern: /^URGENT:/i }, agent: "priority" })]
    const result = resolveRoute(routes, msg({ content: "URGENT: fix the bug" }), "build")
    expect(result.agent).toBe("priority")
  })

  test("pattern does not match", () => {
    const routes = [route("deploy", { match: { type: "pattern", pattern: "deploy" }, agent: "devops" })]
    const result = resolveRoute(routes, msg({ content: "hello" }), "build")
    expect(result.agent).toBe("build")
    expect(result.matchedBy).toBe("system-default")
  })

  test("channel match", () => {
    const routes = [route("all-discord", { match: { type: "channel", channel: "discord" }, agent: "discord-agent" })]
    const result = resolveRoute(routes, msg({ channel: "discord" }), "build")
    expect(result.agent).toBe("discord-agent")
    expect(result.matchedBy).toBe("channel:discord")
  })

  test("default route", () => {
    const routes = [route("fallback", { match: { type: "default" }, agent: "fallback-agent" })]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.agent).toBe("fallback-agent")
    expect(result.matchedBy).toBe("default")
  })

  test("no routes falls back to system default", () => {
    const result = resolveRoute([], msg(), "build")
    expect(result.agent).toBe("build")
    expect(result.matchedBy).toBe("system-default")
    expect(result.routeId).toBe("")
  })

  test("priority ordering", () => {
    const routes = [
      route("low", { match: { type: "channel", channel: "slack" }, agent: "low-agent", priority: 1 }),
      route("high", { match: { type: "channel", channel: "slack" }, agent: "high-agent", priority: 10 }),
    ]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.agent).toBe("high-agent")
    expect(result.routeId).toBe("high")
  })

  test("session scope affects session key", () => {
    const routes = [
      route("global", { match: { type: "channel", channel: "slack" }, agent: "agent", sessionScope: "global" }),
    ]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.sessionKey).toBe("channel:slack:global")
  })

  test("group session scope", () => {
    const routes = [
      route("group", { match: { type: "channel", channel: "slack" }, agent: "agent", sessionScope: "group" }),
    ]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.sessionKey).toBe("channel:slack:C456")
  })

  test("source session scope (default)", () => {
    const routes = [route("source", { match: { type: "channel", channel: "slack" }, agent: "agent" })]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.sessionKey).toBe("channel:slack:U123")
  })

  test("metadata is passed through", () => {
    const routes = [route("meta", { match: { type: "default" }, agent: "agent", metadata: { tier: "premium" } })]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.metadata).toEqual({ tier: "premium" })
  })

  test("channel mismatch does not match", () => {
    const routes = [route("discord-only", { match: { type: "channel", channel: "discord" }, agent: "discord-agent" })]
    const result = resolveRoute(routes, msg({ channel: "slack" }), "build")
    expect(result.matchedBy).toBe("system-default")
  })

  test("group mismatch does not match", () => {
    const routes = [
      route("other-group", { match: { type: "group", channel: "slack", groupId: "C999" }, agent: "agent" }),
    ]
    const result = resolveRoute(routes, msg(), "build")
    expect(result.matchedBy).toBe("system-default")
  })

  test("invalid regex pattern skips route gracefully", () => {
    const routes = [
      route("bad-regex", { match: { type: "pattern", pattern: "[invalid(" }, agent: "bad" }),
      route("fallback", { match: { type: "default" }, agent: "safe" }),
    ]
    // Should not throw — the bad regex is caught and the next route matches
    const result = resolveRoute(routes, msg(), "build")
    expect(result.agent).toBe("safe")
    expect(result.matchedBy).toBe("default")
  })
})
