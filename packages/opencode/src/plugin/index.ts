import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "@gitlab/opencode-gitlab-auth"
import { discover } from "./discovery"
import { createPluginRegistry, createPluginRecord, type PluginRegistry, type PluginApi } from "./registry"
import { createHookRunner, type HookRunner } from "./hooks"
import { validatePluginConfig } from "./validation"
import { resolveSlotDecision } from "./slots"
import * as ChatCommand from "../command/chat-command"
import * as MemoryPlugin from "../memory/index"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  const BUILTIN = ["opencode-anthropic-auth@0.0.13"]

  // Built-in plugins that are directly imported (not installed from npm)
  const INTERNAL_PLUGINS: PluginInstance[] = [CodexAuthPlugin, CopilotAuthPlugin, GitlabAuthPlugin]

  // ============================================================================
  // New plugin module resolution
  // ============================================================================

  type PluginModuleExport = {
    definition?: {
      id?: string
      name?: string
      description?: string
      version?: string
      kind?: string
      register?: (api: PluginApi) => void | Promise<void>
      activate?: (api: PluginApi) => void | Promise<void>
    }
    register?: (api: PluginApi) => void | Promise<void>
  }

  function resolvePluginExport(mod: unknown): PluginModuleExport {
    const resolved =
      mod && typeof mod === "object" && "default" in (mod as Record<string, unknown>)
        ? (mod as { default: unknown }).default
        : mod
    // Bare function export — treated as a register() function.
    // Legacy plugins (function returning Hooks) won't reach here because
    // they're loaded by the legacy loader above, and discovered modules
    // without register/activate are skipped at the call site.
    if (typeof resolved === "function") {
      return { register: resolved as PluginModuleExport["register"] }
    }
    if (resolved && typeof resolved === "object") {
      const def = resolved as NonNullable<PluginModuleExport["definition"]>
      const register = def.register ?? def.activate
      return { definition: def, register }
    }
    return {}
  }

  // ============================================================================
  // State
  // ============================================================================

  const state = Instance.state(async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      directory: Instance.directory,
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks: Hooks[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }

    // ----- Legacy plugin loading (backward compat) -----

    for (const plugin of INTERNAL_PLUGINS) {
      log.info("loading internal plugin", { name: plugin.name })
      const init = await plugin(input)
      hooks.push(init)
    }

    let plugins = config.plugin ?? []
    if (plugins.length) await Config.waitForDependencies()
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins = [...BUILTIN, ...plugins]
    }

    for (let plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (plugin.includes("opencode-openai-codex-auth") || plugin.includes("opencode-copilot-auth")) continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await BunProc.install(pkg, version).catch((err) => {
          if (!builtin) throw err

          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to install builtin plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
            }).toObject(),
          })

          return ""
        })
        if (!plugin) continue
      }
      const mod = await import(plugin)
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
        if (seen.has(fn)) continue
        seen.add(fn)
        const init = await fn(input)
        hooks.push(init)
      }
    }

    // ----- New-style plugin loading (discovery + registry) -----

    const directories = await Config.directories()
    const pluginsConfig = config.plugins
    const registryFactory = createPluginRegistry()

    const discoveryResult = discover({
      workspaceDir: Instance.directory,
      extraPaths: pluginsConfig?.load?.paths,
      configDirectories: directories,
    })

    for (const diag of discoveryResult.diagnostics) {
      registryFactory.pushDiagnostic(diag)
    }

    const seenIds = new Map<string, string>()
    const memorySlot = pluginsConfig?.slots?.memory
    let selectedMemoryId: string | null = null

    // ----- Bundled new-style plugins (loaded before discovery candidates) -----
    {
      const def = MemoryPlugin.definition
      const pluginId = def.id
      const entry = pluginsConfig?.entries?.[pluginId]
      const enabled = entry?.enabled !== false

      const record = createPluginRecord({
        id: pluginId,
        name: def.name,
        description: def.description,
        version: def.version,
        source: "bundled",
        origin: "bundled" as const,
        workspaceDir: Instance.directory,
        enabled,
        configSchema: false,
      })
      record.kind = def.kind

      if (!enabled) {
        record.status = "disabled"
        record.error = "disabled by config"
        registryFactory.registry.plugins.push(record)
      } else {
        const slotDecision = resolveSlotDecision({
          id: pluginId,
          kind: def.kind,
          slot: memorySlot,
          selectedId: selectedMemoryId,
        })

        if (!slotDecision.enabled) {
          record.enabled = false
          record.status = "disabled"
          record.error = slotDecision.reason
          registryFactory.registry.plugins.push(record)
        } else {
          if (slotDecision.selected) selectedMemoryId = pluginId
          const validated = validatePluginConfig({ value: entry?.config })
          if (!validated.ok) {
            record.status = "error"
            record.error = `invalid config: ${validated.errors.join(", ")}`
            registryFactory.registry.plugins.push(record)
          } else {
            const api = registryFactory.createApi(record, { config, pluginConfig: validated.value })
            try {
              await MemoryPlugin.register(api)
              registryFactory.registry.plugins.push(record)
              log.info("loaded bundled plugin", {
                id: pluginId,
                tools: record.toolNames.length,
                hooks: record.hookCount,
              })
            } catch (err) {
              log.warn("bundled plugin register failed", { id: pluginId, error: String(err) })
              record.status = "error"
              record.error = String(err)
              registryFactory.registry.plugins.push(record)
            }
          }
        }
      }
      seenIds.set(pluginId, "bundled")
    }

    for (const candidate of discoveryResult.candidates) {
      const pluginId = candidate.idHint

      // Deduplicate — first origin wins
      const existing = seenIds.get(pluginId)
      if (existing) {
        const record = createPluginRecord({
          id: pluginId,
          name: candidate.packageName ?? pluginId,
          description: candidate.packageDescription,
          version: candidate.packageVersion,
          source: candidate.source,
          origin: candidate.origin,
          workspaceDir: candidate.workspaceDir,
          enabled: false,
          configSchema: false,
        })
        record.status = "disabled"
        record.error = `overridden by ${existing} plugin`
        registryFactory.registry.plugins.push(record)
        continue
      }

      // Check per-plugin enabled/disabled
      const entry = pluginsConfig?.entries?.[pluginId]
      const enabled = entry?.enabled !== false

      const record = createPluginRecord({
        id: pluginId,
        name: candidate.packageName ?? pluginId,
        description: candidate.packageDescription,
        version: candidate.packageVersion,
        source: candidate.source,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled,
        configSchema: false,
      })

      if (!enabled) {
        record.status = "disabled"
        record.error = "disabled by config"
        registryFactory.registry.plugins.push(record)
        seenIds.set(pluginId, candidate.origin)
        continue
      }

      // Load the module
      let mod: unknown
      try {
        mod = await import(candidate.source)
      } catch (err) {
        log.error("failed to load new-style plugin", { id: pluginId, source: candidate.source, error: String(err) })
        record.status = "error"
        record.error = String(err)
        registryFactory.registry.plugins.push(record)
        seenIds.set(pluginId, candidate.origin)
        registryFactory.pushDiagnostic({
          level: "error",
          pluginId,
          source: candidate.source,
          message: `failed to load plugin: ${String(err)}`,
        })
        continue
      }

      const resolved = resolvePluginExport(mod)
      const definition = resolved.definition
      const register = resolved.register

      // If this module doesn't have a register/activate export, it may be
      // a legacy-style plugin (function returning Hooks). Skip it from the
      // new registry — it would have been picked up by the legacy loader
      // if it was in config.plugin paths.
      if (typeof register !== "function") {
        log.info("skipping plugin without register export", { id: pluginId, source: candidate.source })
        seenIds.set(pluginId, candidate.origin)
        continue
      }

      // Merge definition metadata
      if (definition?.name) record.name = definition.name
      if (definition?.description) record.description = definition.description
      if (definition?.version) record.version = definition.version

      // Memory slot resolution
      const slotDecision = resolveSlotDecision({
        id: pluginId,
        kind: definition?.kind,
        slot: memorySlot,
        selectedId: selectedMemoryId,
      })

      if (!slotDecision.enabled) {
        record.enabled = false
        record.status = "disabled"
        record.error = slotDecision.reason
        registryFactory.registry.plugins.push(record)
        seenIds.set(pluginId, candidate.origin)
        continue
      }

      if (slotDecision.selected && definition?.kind === "memory") {
        selectedMemoryId = pluginId
      }

      // Validate plugin config
      const validated = validatePluginConfig({
        value: entry?.config,
      })

      if (!validated.ok) {
        log.error("invalid plugin config", { id: pluginId, errors: validated.errors })
        record.status = "error"
        record.error = `invalid config: ${validated.errors.join(", ")}`
        registryFactory.registry.plugins.push(record)
        seenIds.set(pluginId, candidate.origin)
        registryFactory.pushDiagnostic({
          level: "error",
          pluginId,
          source: candidate.source,
          message: record.error,
        })
        continue
      }

      // Create API and call register
      const api = registryFactory.createApi(record, {
        config,
        pluginConfig: validated.value,
      })

      try {
        const result = register(api)
        if (result && typeof (result as Promise<void>).then === "function") {
          await (result as Promise<void>)
        }
        registryFactory.registry.plugins.push(record)
        seenIds.set(pluginId, candidate.origin)
        log.info("loaded new-style plugin", { id: pluginId, tools: record.toolNames.length, hooks: record.hookCount })
      } catch (err) {
        log.error("plugin register failed", { id: pluginId, source: candidate.source, error: String(err) })
        record.status = "error"
        record.error = String(err)
        registryFactory.registry.plugins.push(record)
        seenIds.set(pluginId, candidate.origin)
        registryFactory.pushDiagnostic({
          level: "error",
          pluginId,
          source: candidate.source,
          message: `plugin failed during register: ${String(err)}`,
        })
      }
    }

    // Register chat commands from the registry into the ChatCommand module
    ChatCommand.clear()
    for (const reg of registryFactory.registry.chatCommands) {
      ChatCommand.register(reg.pluginId, reg.command)
    }

    // Create hook runner for new-style hooks
    const runner = createHookRunner(registryFactory.registry)

    if (registryFactory.registry.diagnostics.length > 0) {
      log.info("plugin diagnostics", { count: registryFactory.registry.diagnostics.length })
      for (const diag of registryFactory.registry.diagnostics) {
        if (diag.level === "error") {
          log.error(diag.message, { pluginId: diag.pluginId, source: diag.source })
        } else {
          log.warn(diag.message, { pluginId: diag.pluginId, source: diag.source })
        }
      }
    }

    return {
      hooks,
      input,
      registry: registryFactory.registry,
      runner,
    }
  })

  // ============================================================================
  // Legacy API (backward compatible)
  // ============================================================================

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      // @ts-expect-error this is because we haven't moved plugin to sdk v2
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }

  // ============================================================================
  // New API (registry + hook runner)
  // ============================================================================

  /** Get the plugin registry (new-style plugins only) */
  export async function getRegistry(): Promise<PluginRegistry> {
    return state().then((x) => x.registry)
  }

  /** Get the typed hook runner (new-style plugins only) */
  export async function getHookRunner(): Promise<HookRunner> {
    return state().then((x) => x.runner)
  }
}
