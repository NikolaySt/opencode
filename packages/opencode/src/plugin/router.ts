/**
 * Agent Router
 *
 * Programmable message-to-agent dispatch. Routes are registered by
 * plugins and matched in priority order against inbound messages.
 * Supports exact source/group matches, content pattern matches,
 * channel-wide matches, and a default fallback.
 */

import { Log } from "../util/log"
import { sessionKey, type ChannelMessage } from "./channel"

const log = Log.create({ service: "plugin.router" })

// ============================================================================
// Types
// ============================================================================

export type RouteMatch =
  | { type: "source"; channel: string; sourceId: string }
  | { type: "group"; channel: string; groupId: string }
  | { type: "pattern"; pattern: string | RegExp }
  | { type: "channel"; channel: string }
  | { type: "default" }

export type RouteDefinition = {
  id: string
  match: RouteMatch
  agent: string
  priority?: number
  sessionScope?: "source" | "group" | "global"
  metadata?: Record<string, unknown>
}

export type RouteRegistration = {
  pluginId: string
  route: RouteDefinition
  source: string
}

export type ResolvedRoute = {
  agent: string
  sessionKey: string
  matchedBy: string
  routeId: string
  metadata?: Record<string, unknown>
}

// ============================================================================
// Router
// ============================================================================

export function resolveRoute(routes: RouteRegistration[], msg: ChannelMessage, defaultAgent: string): ResolvedRoute {
  const sorted = routes.toSorted((a, b) => (b.route.priority ?? 0) - (a.route.priority ?? 0))

  // Warn if a "default" route has elevated priority — it will shadow everything
  for (const r of sorted) {
    if (r.route.match.type === "default" && (r.route.priority ?? 0) > 0) {
      log.warn(
        `route "${r.route.id}" from ${r.pluginId} is a "default" route with priority ${r.route.priority} — it will shadow lower-priority routes`,
      )
    }
  }

  for (const reg of sorted) {
    const match = reg.route.match
    const scope = reg.route.sessionScope ?? "source"

    if (match.type === "source" && match.channel === msg.channel && match.sourceId === msg.source.id) {
      return {
        agent: reg.route.agent,
        sessionKey: sessionKey(msg, scope),
        matchedBy: `source:${match.channel}:${match.sourceId}`,
        routeId: reg.route.id,
        metadata: reg.route.metadata,
      }
    }

    if (match.type === "group" && match.channel === msg.channel && msg.source.group === match.groupId) {
      return {
        agent: reg.route.agent,
        sessionKey: sessionKey(msg, scope),
        matchedBy: `group:${match.channel}:${match.groupId}`,
        routeId: reg.route.id,
        metadata: reg.route.metadata,
      }
    }

    if (match.type === "pattern") {
      try {
        const regex = match.pattern instanceof RegExp ? match.pattern : new RegExp(match.pattern)
        if (regex.test(msg.content)) {
          return {
            agent: reg.route.agent,
            sessionKey: sessionKey(msg, scope),
            matchedBy: `pattern:${String(match.pattern)}`,
            routeId: reg.route.id,
            metadata: reg.route.metadata,
          }
        }
      } catch (err) {
        log.error(`route "${reg.route.id}" from ${reg.pluginId} has invalid pattern: ${String(err)}`)
      }
    }

    if (match.type === "channel" && match.channel === msg.channel) {
      return {
        agent: reg.route.agent,
        sessionKey: sessionKey(msg, scope),
        matchedBy: `channel:${match.channel}`,
        routeId: reg.route.id,
        metadata: reg.route.metadata,
      }
    }

    if (match.type === "default") {
      return {
        agent: reg.route.agent,
        sessionKey: sessionKey(msg, scope),
        matchedBy: "default",
        routeId: reg.route.id,
        metadata: reg.route.metadata,
      }
    }
  }

  // No route matched — use system default agent
  return {
    agent: defaultAgent,
    sessionKey: sessionKey(msg, "source"),
    matchedBy: "system-default",
    routeId: "",
  }
}
