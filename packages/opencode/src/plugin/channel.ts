/**
 * Channel Adapters
 *
 * Abstraction layer for external communication endpoints (Slack, Discord,
 * MQTT, webhooks, etc.). Each channel plugin registers an adapter that
 * normalizes inbound messages and delivers outbound responses.
 *
 * Channels are connected/disconnected alongside plugin services in the
 * server lifecycle.
 */

import { Log } from "../util/log"
import { withTimeout } from "../util/timeout"
import type { PluginLogger } from "./registry"

const log = Log.create({ service: "plugin.channel" })

const CHANNEL_START_TIMEOUT_MS = 60_000
const CHANNEL_STOP_TIMEOUT_MS = 30_000

// ============================================================================
// Channel Message Types
// ============================================================================

export type ChannelAttachment = {
  type: "file" | "image" | "audio" | "video"
  url?: string
  data?: string
  mime?: string
  name?: string
}

export type ChannelSource = {
  id: string
  name?: string
  group?: string
}

export type ChannelMessage = {
  channel: string
  source: ChannelSource
  content: string
  threadID?: string
  attachments?: ChannelAttachment[]
  metadata?: Record<string, unknown>
  raw?: unknown
}

export type ChannelResponse = {
  content: string
  attachments?: ChannelAttachment[]
  metadata?: Record<string, unknown>
  replyTo?: string
}

// ============================================================================
// Channel Adapter Contract
// ============================================================================

export type ChannelCapabilities = {
  threads?: boolean
  attachments?: boolean
  reactions?: boolean
  streaming?: boolean
}

export type ChannelContext = {
  config: unknown
  pluginConfig?: Record<string, unknown>
  logger: PluginLogger
  abort: AbortSignal
  deliver: (msg: ChannelMessage) => Promise<ChannelResponse>
}

export type ChannelAdapter = {
  id: string
  name: string
  capabilities?: ChannelCapabilities
  setup?: (ctx: ChannelContext) => Promise<void>
  connect: (ctx: ChannelContext) => Promise<void>
  disconnect?: (ctx: ChannelContext) => Promise<void>
  send?: (response: ChannelResponse, ctx: ChannelContext) => Promise<void>
  health?: (ctx: ChannelContext) => Promise<{ ok: boolean; error?: string }>
}

export type ChannelRegistration = {
  pluginId: string
  adapter: ChannelAdapter
  pluginConfig?: Record<string, unknown>
  source: string
}

// ============================================================================
// Session Mapping
// ============================================================================

/**
 * Maps channel+source combinations to session IDs. Each unique
 * conversation endpoint (DM, group thread, etc.) gets its own session.
 */
export type ChannelSessionMap = {
  get(key: string): string | undefined
  set(key: string, sessionID: string): void
  delete(key: string): boolean
  keys(): string[]
}

export function createSessionMap(): ChannelSessionMap {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key),
    set: (key, sessionID) => map.set(key, sessionID),
    delete: (key) => map.delete(key),
    keys: () => [...map.keys()],
  }
}

/**
 * Build a deterministic session key from a channel message.
 */
export function sessionKey(msg: ChannelMessage, scope: "source" | "group" | "global" = "source"): string {
  if (scope === "global") return `channel:${msg.channel}:global`
  if (scope === "group" && msg.source.group) {
    const thread = msg.threadID ? `:${msg.threadID}` : ""
    return `channel:${msg.channel}:${msg.source.group}${thread}`
  }
  return `channel:${msg.channel}:${msg.source.id}`
}

// ============================================================================
// Channel Lifecycle Manager
// ============================================================================

export type ChannelHandle = {
  /** Resolves when all channels have attempted connection (success or failure). */
  ready: Promise<void>
  stop: () => Promise<void>
  channels: () => ChannelRegistration[]
  health: (channelId: string) => Promise<{ ok: boolean; error?: string }>
  /** Exposed for the caller (e.g. server.ts) to map channel+source to session IDs. */
  sessionMap: ChannelSessionMap
}

export function startChannels(input: {
  channels: ChannelRegistration[]
  config: unknown
  workspaceDir?: string
  deliver: (msg: ChannelMessage) => Promise<ChannelResponse>
}): ChannelHandle {
  const controller = new AbortController()
  const sessions = createSessionMap()
  const connected: Array<{ registration: ChannelRegistration; ctx: ChannelContext }> = []

  // Connect channels in parallel — one slow/failing channel doesn't block others
  const ready = (async () => {
    async function connectOne(reg: ChannelRegistration) {
      const logger: PluginLogger = {
        info: (msg) => log.info(`[${reg.adapter.id}] ${msg}`),
        warn: (msg) => log.warn(`[${reg.adapter.id}] ${msg}`),
        error: (msg) => log.error(`[${reg.adapter.id}] ${msg}`),
      }

      const ctx: ChannelContext = {
        config: input.config,
        pluginConfig: reg.pluginConfig,
        logger,
        abort: controller.signal,
        deliver: input.deliver,
      }

      try {
        if (reg.adapter.setup) {
          await withTimeout(reg.adapter.setup(ctx), CHANNEL_START_TIMEOUT_MS, `channel ${reg.adapter.id} setup`)
        }
        await withTimeout(reg.adapter.connect(ctx), CHANNEL_START_TIMEOUT_MS, `channel ${reg.adapter.id} connect`)
        connected.push({ registration: reg, ctx })
        log.info(`channel ${reg.adapter.id} connected`)
      } catch (err) {
        log.error(`channel ${reg.adapter.id} failed to connect: ${String(err)}`)
      }
    }
    await Promise.allSettled(input.channels.map(connectOne))
  })()

  let stopped = false

  async function stop() {
    if (stopped) return
    stopped = true
    await ready
    // Disconnect adapters BEFORE aborting the signal so disconnect handlers
    // see a non-aborted signal during teardown.
    for (let i = connected.length - 1; i >= 0; i--) {
      const entry = connected[i]
      if (!entry.registration.adapter.disconnect) continue
      try {
        await withTimeout(
          entry.registration.adapter.disconnect(entry.ctx),
          CHANNEL_STOP_TIMEOUT_MS,
          `channel ${entry.registration.adapter.id} disconnect`,
        )
        log.info(`channel ${entry.registration.adapter.id} disconnected`)
      } catch (err) {
        log.error(`channel ${entry.registration.adapter.id} failed to disconnect: ${String(err)}`)
      }
    }
    controller.abort()
  }

  async function health(channelId: string) {
    await ready
    const entry = connected.find((c) => c.registration.adapter.id === channelId)
    if (!entry) return { ok: false, error: "channel not found" }
    if (!entry.registration.adapter.health) return { ok: true }
    try {
      return await entry.registration.adapter.health(entry.ctx)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  return {
    ready,
    stop,
    channels: () => input.channels,
    health,
    sessionMap: sessions,
  }
}
