/**
 * Gateway RPC
 *
 * Plugin-registered RPC methods callable from other plugins, HTTP
 * endpoints, channel adapters, or cron jobs. Methods are namespaced
 * by plugin ID to prevent collisions.
 *
 * HTTP integration: POST /rpc/:method accepts JSON body as params,
 * calls the registered handler, returns the result.
 */

import { Log } from "../util/log"

const log = Log.create({ service: "plugin.rpc" })

// ============================================================================
// Types
// ============================================================================

export type RpcContext = {
  callerId?: string
  sessionID?: string
  config: unknown
}

export type RpcMethod = {
  name: string
  handler: (params: unknown, ctx: RpcContext) => Promise<unknown>
  description?: string
}

export type RpcMethodRegistration = {
  pluginId: string
  method: RpcMethod
  qualifiedName: string
  source: string
}

export type RpcCallResult = { ok: true; result: unknown } | { ok: false; error: string }

// ============================================================================
// RPC Registry / Dispatcher
// ============================================================================

export function createRpcDispatcher(registrations: RpcMethodRegistration[]) {
  const methods = new Map<string, RpcMethodRegistration>()

  for (const reg of registrations) {
    if (methods.has(reg.qualifiedName)) {
      log.warn(`rpc method "${reg.qualifiedName}" already registered, overwriting`)
    }
    methods.set(reg.qualifiedName, reg)
  }

  async function call(method: string, params: unknown, ctx: RpcContext): Promise<RpcCallResult> {
    const reg = methods.get(method)
    if (!reg) return { ok: false, error: `unknown rpc method: ${method}` }
    try {
      const result = await reg.method.handler(params, ctx)
      return { ok: true, result }
    } catch (err) {
      log.error(`rpc ${method} failed: ${String(err)}`)
      return { ok: false, error: String(err) }
    }
  }

  function list(): Array<{ name: string; pluginId: string; description?: string }> {
    return [...methods.values()].map((m) => ({
      name: m.qualifiedName,
      pluginId: m.pluginId,
      description: m.method.description,
    }))
  }

  function has(method: string): boolean {
    return methods.has(method)
  }

  return { call, list, has }
}

export type RpcDispatcher = ReturnType<typeof createRpcDispatcher>

/**
 * Qualify a method name with the plugin ID.
 */
export function qualifyRpcMethod(pluginId: string, name: string): string {
  if (name.includes(".")) return name
  return `${pluginId}.${name}`
}
