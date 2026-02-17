/**
 * Plugin Message Bus
 *
 * Typed pub/sub system for inter-plugin communication. Topics are
 * auto-namespaced by plugin ID. Plugins can subscribe to their own
 * topics (short name) or to other plugins' topics (qualified name).
 *
 * This is separate from the system Bus (src/bus/) which drives
 * SSE events for the TUI. The plugin bus is registry-scoped and
 * intended for plugin-to-plugin communication.
 */

import { Log } from "../util/log"

const log = Log.create({ service: "plugin.bus" })

export type PluginBusSubscription = {
  pluginId: string
  topic: string
  handler: (payload: unknown) => void | Promise<void>
}

export type PluginBusPublishOptions = {
  retain?: boolean
}

export function createPluginBus() {
  const subscriptions = new Map<string, PluginBusSubscription[]>()
  const retained = new Map<string, unknown>()
  const wildcards: PluginBusSubscription[] = []

  function qualify(pluginId: string, topic: string): string {
    if (topic === "*") return "*"
    // Dotted names are treated as already-qualified (cross-namespace publishing
    // is intentionally allowed so plugins can coordinate freely).
    if (topic.includes(".")) return topic
    return `${pluginId}.${topic}`
  }

  async function publish(pluginId: string, topic: string, payload: unknown, opts?: PluginBusPublishOptions) {
    const qualified = qualify(pluginId, topic)
    if (opts?.retain) retained.set(qualified, payload)

    const handlers = [...(subscriptions.get(qualified) ?? []), ...wildcards]
    if (handlers.length === 0) return

    const results = handlers.map(async (sub) => {
      try {
        await sub.handler(payload)
      } catch (err) {
        log.error(`[bus] handler from ${sub.pluginId} for ${qualified} failed: ${String(err)}`)
      }
    })
    await Promise.allSettled(results)
  }

  function subscribe(
    pluginId: string,
    topic: string,
    handler: (payload: unknown) => void | Promise<void>,
  ): { unsubscribe: () => void; ready: Promise<void> } {
    const qualified = qualify(pluginId, topic)
    const sub: PluginBusSubscription = { pluginId, topic: qualified, handler }

    if (qualified === "*") {
      wildcards.push(sub)
      return {
        unsubscribe: () => {
          const idx = wildcards.indexOf(sub)
          if (idx !== -1) wildcards.splice(idx, 1)
        },
        ready: Promise.resolve(),
      }
    }

    const list = subscriptions.get(qualified) ?? []
    list.push(sub)
    subscriptions.set(qualified, list)

    // Retained delivery — awaitable via the returned `ready` promise
    let retained_delivery: Promise<void> = Promise.resolve()
    if (retained.has(qualified)) {
      const value = retained.get(qualified)
      retained_delivery = Promise.resolve(handler(value))
        .then(() => {})
        .catch((err) => {
          log.error(`[bus] retained delivery to ${pluginId} for ${qualified} failed: ${String(err)}`)
        })
    }

    return {
      unsubscribe: () => {
        const current = subscriptions.get(qualified)
        if (!current) return
        const idx = current.indexOf(sub)
        if (idx !== -1) current.splice(idx, 1)
        if (current.length === 0) subscriptions.delete(qualified)
      },
      ready: retained_delivery,
    }
  }

  function clear(pluginId: string) {
    for (const [topic, subs] of subscriptions) {
      const filtered = subs.filter((s) => s.pluginId !== pluginId)
      if (filtered.length === 0) subscriptions.delete(topic)
      else subscriptions.set(topic, filtered)
    }
    for (let i = wildcards.length - 1; i >= 0; i--) {
      if (wildcards[i].pluginId === pluginId) wildcards.splice(i, 1)
    }
    // Purge retained messages owned by this plugin
    const prefix = pluginId + "."
    for (const topic of retained.keys()) {
      if (topic.startsWith(prefix)) retained.delete(topic)
    }
  }

  function topics(): string[] {
    return [...subscriptions.keys()]
  }

  function subscriberCount(topic?: string): number {
    if (topic) return (subscriptions.get(topic) ?? []).length + wildcards.length
    let total = wildcards.length
    for (const subs of subscriptions.values()) total += subs.length
    return total
  }

  return { publish, subscribe, clear, topics, subscriberCount }
}

export type PluginBus = ReturnType<typeof createPluginBus>
