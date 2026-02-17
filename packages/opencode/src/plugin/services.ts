/**
 * Plugin Service Manager
 *
 * Manages background services registered by plugins.
 * Services are started on server startup and stopped on shutdown.
 */

import { Log } from "../util/log"
import { withTimeout } from "../util/timeout"
import type { PluginRegistry } from "./registry"

const log = Log.create({ service: "plugin.services" })

const DEFAULT_SERVICE_TIMEOUT_MS = 60_000

export type PluginServicesHandle = {
  stop: () => Promise<void>
}

export async function startPluginServices(params: {
  registry: PluginRegistry
  config: unknown
  workspaceDir?: string
  timeoutMs?: number
}): Promise<PluginServicesHandle> {
  const running: Array<{ id: string; stop?: () => Promise<void> }> = []
  const controller = new AbortController()
  const timeout = params.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS

  for (const entry of params.registry.services) {
    try {
      await withTimeout(
        entry.service.start({
          config: params.config,
          pluginConfig: entry.pluginConfig,
          workspaceDir: params.workspaceDir,
          abort: controller.signal,
        }),
        timeout,
        `service ${entry.service.id} start`,
      )
      running.push({
        id: entry.service.id,
        stop: entry.service.stop
          ? () =>
              withTimeout(
                entry.service.stop!({
                  config: params.config,
                  pluginConfig: entry.pluginConfig,
                  workspaceDir: params.workspaceDir,
                  abort: controller.signal,
                }),
                timeout,
                `service ${entry.service.id} stop`,
              )
          : undefined,
      })
      log.info("service started", { id: entry.service.id, plugin: entry.pluginId })
    } catch (err) {
      log.error("service failed to start", {
        id: entry.service.id,
        plugin: entry.pluginId,
        error: String(err),
      })
    }
  }

  return {
    stop: async () => {
      controller.abort()
      for (const entry of running.toReversed()) {
        if (!entry.stop) continue
        try {
          await entry.stop()
          log.info("service stopped", { id: entry.id })
        } catch (err) {
          log.warn("service stop failed", { id: entry.id, error: String(err) })
        }
      }
    },
  }
}
