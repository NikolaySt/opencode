/**
 * Plugin Registry
 *
 * Central registry that holds all plugin registrations (tools, hooks,
 * CLI commands, chat commands, HTTP handlers, services) and provides
 * the PluginApi object passed to each plugin's register() function.
 */

import path from "path"
import { Log } from "../util/log"
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { PluginOrigin, PluginDiagnostic, PluginKind, PluginConfigUiHint } from "./types"
import { createPluginBus, type PluginBus, type PluginBusPublishOptions } from "./bus"
import type { ChannelAdapter, ChannelRegistration } from "./channel"
import type { CronJobDefinition, CronJobRegistration } from "./cron"
import type { RouteDefinition, RouteRegistration } from "./router"
import type { PipelineStage, PipelinePosition, PipelineStageRegistration } from "./pipeline"
import type { ToolDecorator, ToolDecoratorRegistration } from "./decorator"
import {
  qualifyRpcMethod,
  createRpcDispatcher,
  type RpcMethod,
  type RpcMethodRegistration,
  type RpcContext,
} from "./rpc"
import type { StreamTransform, StreamTransformRegistration } from "./stream"

const log = Log.create({ service: "plugin.registry" })

// ============================================================================
// Registration Types
// ============================================================================

export type PluginToolRegistration = {
  pluginId: string
  tool: ToolDefinition
  name: string
  source: string
}

export type PluginHookName =
  | "session.created"
  | "session.archived"
  | "agent.start"
  | "agent.finish"
  | "message.received"
  | "message.sending"
  | "message.sent"
  | "compaction.before"
  | "compaction.after"
  | "tool.block"
  | "tool.before"
  | "tool.after"
  | "tool.result.persist"
  | "server.start"
  | "server.stop"

export type TypedPluginHookRegistration = {
  pluginId: string
  hookName: PluginHookName
  // Union of all hook handler signatures; cast at call site
  handler: PluginHookHandlerMap[PluginHookName]
  priority?: number
  source: string
}

export type PluginCliRegistrar = (ctx: PluginCliContext) => void | Promise<void>

export type PluginCliContext = {
  program: unknown
  config: unknown
  workspaceDir?: string
}

export type PluginCliRegistration = {
  pluginId: string
  register: PluginCliRegistrar
  commands: string[]
  source: string
}

export type PluginChatCommandDefinition = {
  name: string
  description: string
  aliases?: string[]
  acceptsArgs?: boolean
  requireAuth?: boolean
  handler: (ctx: PluginChatCommandContext) => Promise<PluginChatCommandResult>
}

export type PluginChatCommandContext = {
  sessionID: string
  args?: string
  commandBody: string
}

export type PluginChatCommandResult = {
  text?: string
  silent?: boolean
}

export type PluginChatCommandRegistration = {
  pluginId: string
  command: PluginChatCommandDefinition
  source: string
}

export type PluginHttpHandler = (req: Request) => Promise<Response | null>

export type PluginHttpRegistration = {
  pluginId: string
  handler: PluginHttpHandler
  source: string
}

export type PluginHttpRouteHandler = (req: Request) => Promise<Response>

export type PluginHttpRouteRegistration = {
  pluginId: string
  path: string
  handler: PluginHttpRouteHandler
  source: string
}

export type PluginServiceDefinition = {
  id: string
  start: (ctx: PluginServiceContext) => Promise<void>
  stop?: (ctx: PluginServiceContext) => Promise<void>
}

export type PluginServiceContext = {
  config: unknown
  pluginConfig?: Record<string, unknown>
  workspaceDir?: string
  abort: AbortSignal
}

export type PluginServiceRegistration = {
  pluginId: string
  service: PluginServiceDefinition
  pluginConfig?: Record<string, unknown>
  source: string
}

// ============================================================================
// Tool Factory Types
// ============================================================================

export type PluginToolFactoryContext = {
  config: unknown
  pluginConfig?: Record<string, unknown>
  agent?: string
}

export type PluginToolFactory = (ctx: PluginToolFactoryContext) => ToolDefinition | ToolDefinition[] | null | undefined

export type PluginToolFactoryRegistration = {
  pluginId: string
  factory: PluginToolFactory
  names: string[]
  pluginConfig?: Record<string, unknown>
  source: string
}

// ============================================================================
// Plugin Record (metadata per plugin)
// ============================================================================

export type PluginRecord = {
  id: string
  name: string
  version?: string
  description?: string
  kind?: PluginKind
  source: string
  origin: PluginOrigin
  workspaceDir?: string
  enabled: boolean
  status: "loaded" | "disabled" | "error"
  error?: string
  toolNames: string[]
  hookCount: number
  cliCommands: string[]
  chatCommands: string[]
  httpHandlers: number
  services: string[]
  configSchema: boolean
  configUiHints?: Record<string, PluginConfigUiHint>
  configJsonSchema?: Record<string, unknown>
}

// ============================================================================
// Registry
// ============================================================================

export type PluginRegistry = {
  plugins: PluginRecord[]
  tools: PluginToolRegistration[]
  toolFactories: PluginToolFactoryRegistration[]
  typedHooks: TypedPluginHookRegistration[]
  cliRegistrars: PluginCliRegistration[]
  chatCommands: PluginChatCommandRegistration[]
  httpHandlers: PluginHttpRegistration[]
  httpRoutes: PluginHttpRouteRegistration[]
  services: PluginServiceRegistration[]
  channels: ChannelRegistration[]
  cronJobs: CronJobRegistration[]
  routes: RouteRegistration[]
  pipelineStages: PipelineStageRegistration[]
  toolDecorators: ToolDecoratorRegistration[]
  rpcMethods: RpcMethodRegistration[]
  streamTransforms: StreamTransformRegistration[]
  diagnostics: PluginDiagnostic[]
  bus: PluginBus
  /** @internal Cached RPC dispatcher — invalidated automatically when methods are added. Not part of the public plugin SDK. */
  rpcDispatcher: () => ReturnType<typeof createRpcDispatcher>
}

// ============================================================================
// Plugin API (passed to each plugin's register() function)
// ============================================================================

export type PluginApi = {
  id: string
  name: string
  version?: string
  description?: string
  source: string
  config: unknown
  pluginConfig?: Record<string, unknown>
  logger: PluginLogger
  registerTool: (tool: ToolDefinition, opts?: { name?: string }) => void
  registerToolFactory: (factory: PluginToolFactory, opts?: { names?: string[] }) => void
  on: <K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?: { priority?: number }) => void
  registerCli: (registrar: PluginCliRegistrar, opts?: { commands?: string[] }) => void
  registerChatCommand: (command: PluginChatCommandDefinition) => void
  registerHttpHandler: (handler: PluginHttpHandler) => void
  registerHttpRoute: (params: { path: string; handler: PluginHttpRouteHandler }) => void
  registerService: (service: PluginServiceDefinition) => void
  registerChannel: (adapter: ChannelAdapter) => void
  registerCron: (job: CronJobDefinition) => void
  registerRoute: (route: RouteDefinition) => void
  registerStage: (stage: PipelineStage, position: PipelinePosition) => void
  decorateTool: (decorator: ToolDecorator) => void
  registerRpc: (method: RpcMethod) => void
  callRpc: (method: string, params?: unknown) => Promise<unknown>
  registerStreamTransform: (transform: StreamTransform) => void
  resolvePath: (input: string) => string
  publish: (topic: string, payload: unknown, opts?: PluginBusPublishOptions) => Promise<void>
  subscribe: (
    topic: string,
    handler: (payload: unknown) => void | Promise<void>,
  ) => { unsubscribe: () => void; ready: Promise<void> }
}

export type PluginLogger = {
  debug?: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

// ============================================================================
// Hook handler type map
// ============================================================================

export type PluginHookAgentStartEvent = {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
}

export type PluginHookAgentStartResult = {
  systemPrompt?: string
  prependContext?: string
}

export type PluginHookAgentFinishEvent = {
  sessionID: string
  agent: string
  success: boolean
  error?: string
  durationMs?: number
}

export type PluginHookMessageReceivedEvent = {
  sessionID: string
  content: string
}

export type PluginHookMessageSendingEvent = {
  sessionID: string
  content: string
}

export type PluginHookMessageSendingResult = {
  content?: string
  cancel?: boolean
}

export type PluginHookCompactionEvent = {
  sessionID: string
  messageCount?: number
  tokenCount?: number
}

export type PluginHookToolBlockEvent = {
  tool: string
  args: Record<string, unknown>
  sessionID: string
}

export type PluginHookToolBlockResult = {
  block?: boolean
  reason?: string
}

export type PluginHookToolEvent = {
  tool: string
  args: Record<string, unknown>
  sessionID: string
  result?: unknown
  error?: string
  durationMs?: number
}

export type PluginHookSessionEvent = {
  sessionID: string
}

export type PluginHookServerEvent = {
  port?: number
}

export type PluginHookMessageSentEvent = {
  sessionID: string
  messageID: string
  success: boolean
  error?: string
  durationMs?: number
}

export type PluginHookToolResultPersistEvent = {
  sessionID: string
  tool: string
  callID: string
  output: string
  title: string
  metadata: Record<string, unknown>
  input: Record<string, unknown>
}

export type PluginHookToolResultPersistResult = {
  output?: string
  title?: string
  metadata?: Record<string, unknown>
}

export type PluginHookHandlerMap = {
  "session.created": (event: PluginHookSessionEvent) => Promise<void> | void
  "session.archived": (event: PluginHookSessionEvent) => Promise<void> | void
  "agent.start": (
    event: PluginHookAgentStartEvent,
  ) => Promise<PluginHookAgentStartResult | void> | PluginHookAgentStartResult | void
  "agent.finish": (event: PluginHookAgentFinishEvent) => Promise<void> | void
  "message.received": (event: PluginHookMessageReceivedEvent) => Promise<void> | void
  "message.sending": (
    event: PluginHookMessageSendingEvent,
  ) => Promise<PluginHookMessageSendingResult | void> | PluginHookMessageSendingResult | void
  "message.sent": (event: PluginHookMessageSentEvent) => Promise<void> | void
  "compaction.before": (event: PluginHookCompactionEvent) => Promise<void> | void
  "compaction.after": (event: PluginHookCompactionEvent) => Promise<void> | void
  "tool.block": (
    event: PluginHookToolBlockEvent,
  ) => Promise<PluginHookToolBlockResult | void> | PluginHookToolBlockResult | void
  "tool.before": (event: PluginHookToolEvent) => Promise<void> | void
  "tool.after": (event: PluginHookToolEvent) => Promise<void> | void
  "tool.result.persist": (
    event: PluginHookToolResultPersistEvent,
  ) => Promise<PluginHookToolResultPersistResult | void> | PluginHookToolResultPersistResult | void
  "server.start": (event: PluginHookServerEvent) => Promise<void> | void
  "server.stop": (event: PluginHookServerEvent) => Promise<void> | void
}

// ============================================================================
// Factory
// ============================================================================

export function createPluginRecord(params: {
  id: string
  name?: string
  description?: string
  version?: string
  source: string
  origin: PluginOrigin
  workspaceDir?: string
  enabled: boolean
  configSchema: boolean
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookCount: 0,
    cliCommands: [],
    chatCommands: [],
    httpHandlers: 0,
    services: [],
    configSchema: params.configSchema,
  }
}

export function createPluginRegistry() {
  const bus = createPluginBus()
  const registry: PluginRegistry = {
    plugins: [],
    tools: [],
    toolFactories: [],
    typedHooks: [],
    cliRegistrars: [],
    chatCommands: [],
    httpHandlers: [],
    httpRoutes: [],
    services: [],
    channels: [],
    cronJobs: [],
    routes: [],
    pipelineStages: [],
    toolDecorators: [],
    rpcMethods: [],
    streamTransforms: [],
    diagnostics: [],
    bus,
    rpcDispatcher,
  }

  function pushDiagnostic(diag: PluginDiagnostic) {
    registry.diagnostics.push(diag)
  }

  function registerTool(record: PluginRecord, tool: ToolDefinition, opts?: { name?: string }) {
    const name = opts?.name ?? (tool as ToolDefinition & { name?: string }).name ?? record.id
    if (registry.tools.some((t) => t.name === name)) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `duplicate tool registration: "${name}" (overriding)`,
      })
    }
    record.toolNames.push(name)
    registry.tools.push({
      pluginId: record.id,
      tool,
      name,
      source: record.source,
    })
  }

  function registerTypedHook<K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) {
    record.hookCount += 1
    registry.typedHooks.push({
      pluginId: record.id,
      hookName,
      handler,
      priority: opts?.priority,
      source: record.source,
    })
  }

  function registerCli(record: PluginRecord, registrar: PluginCliRegistrar, opts?: { commands?: string[] }) {
    const commands = (opts?.commands ?? []).map((c) => c.trim()).filter(Boolean)
    record.cliCommands.push(...commands)
    registry.cliRegistrars.push({
      pluginId: record.id,
      register: registrar,
      commands,
      source: record.source,
    })
  }

  function registerChatCommand(record: PluginRecord, command: PluginChatCommandDefinition) {
    const name = command.name.trim()
    if (!name) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "chat command registration missing name",
      })
      return
    }
    record.chatCommands.push(name)
    registry.chatCommands.push({
      pluginId: record.id,
      command,
      source: record.source,
    })
  }

  function registerHttpHandler(record: PluginRecord, handler: PluginHttpHandler) {
    record.httpHandlers += 1
    registry.httpHandlers.push({
      pluginId: record.id,
      handler,
      source: record.source,
    })
  }

  function registerHttpRoute(record: PluginRecord, params: { path: string; handler: PluginHttpRouteHandler }) {
    const normalized = `/plugins/${record.id}${params.path.startsWith("/") ? params.path : "/" + params.path}`
    if (registry.httpRoutes.some((r) => r.path === normalized)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route already registered: ${normalized}`,
      })
      return
    }
    record.httpHandlers += 1
    registry.httpRoutes.push({
      pluginId: record.id,
      path: normalized,
      handler: params.handler,
      source: record.source,
    })
  }

  function registerToolFactory(
    record: PluginRecord,
    factory: PluginToolFactory,
    opts?: { names?: string[] },
    pluginConfig?: Record<string, unknown>,
  ) {
    const names = (opts?.names ?? []).map((n) => n.trim()).filter(Boolean)
    record.toolNames.push(...names)
    registry.toolFactories.push({
      pluginId: record.id,
      factory,
      names,
      pluginConfig,
      source: record.source,
    })
  }

  function registerStreamTransform(record: PluginRecord, transform: StreamTransform) {
    if (!transform.name.trim()) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "stream transform registration missing name",
      })
      return
    }
    registry.streamTransforms.push({
      pluginId: record.id,
      transform,
      source: record.source,
    })
  }

  function registerRpc(record: PluginRecord, method: RpcMethod) {
    const name = method.name.trim()
    if (!name) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "rpc method registration missing name",
      })
      return
    }
    const qualified = qualifyRpcMethod(record.id, name)
    registry.rpcMethods.push({
      pluginId: record.id,
      method,
      qualifiedName: qualified,
      source: record.source,
    })
    cacheGeneration++
  }

  // RPC dispatcher cache. Uses a generation counter incremented on every
  // registerRpc call so the cache is invalidated correctly even if the
  // array length stays the same (e.g. hypothetical remove + add).
  let cachedDispatcher: ReturnType<typeof createRpcDispatcher> | undefined
  let cacheGeneration = 0
  let cachedGeneration = -1

  function rpcDispatcher() {
    if (cachedDispatcher && cachedGeneration === cacheGeneration) return cachedDispatcher
    cachedDispatcher = createRpcDispatcher(registry.rpcMethods)
    cachedGeneration = cacheGeneration
    return cachedDispatcher
  }

  async function callRpc(callerId: string, method: string, params: unknown, config: unknown) {
    const result = await rpcDispatcher().call(method, params, { callerId, config })
    if (!result.ok) throw new Error(result.error)
    return result.result
  }

  function decorateTool(record: PluginRecord, decorator: ToolDecorator) {
    registry.toolDecorators.push({
      pluginId: record.id,
      decorator,
      source: record.source,
    })
  }

  function registerStage(record: PluginRecord, stage: PipelineStage, position: PipelinePosition) {
    if (!stage.name.trim()) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "pipeline stage registration missing name",
      })
      return
    }
    registry.pipelineStages.push({
      pluginId: record.id,
      stage,
      position,
      source: record.source,
    })
  }

  function registerRoute(record: PluginRecord, route: RouteDefinition) {
    const id = route.id.trim()
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "route registration missing id",
      })
      return
    }
    registry.routes.push({
      pluginId: record.id,
      route,
      source: record.source,
    })
  }

  function registerCron(record: PluginRecord, job: CronJobDefinition, pluginConfig?: Record<string, unknown>) {
    const id = job.id.trim()
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cron job registration missing id",
      })
      return
    }
    registry.cronJobs.push({
      pluginId: record.id,
      job,
      pluginConfig,
      source: record.source,
    })
  }

  function registerChannel(record: PluginRecord, adapter: ChannelAdapter, pluginConfig?: Record<string, unknown>) {
    const id = adapter.id.trim()
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "channel registration missing id",
      })
      return
    }
    if (registry.channels.some((c) => c.adapter.id === id)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel already registered: ${id}`,
      })
      return
    }
    registry.channels.push({
      pluginId: record.id,
      adapter,
      pluginConfig,
      source: record.source,
    })
  }

  function registerService(
    record: PluginRecord,
    service: PluginServiceDefinition,
    pluginConfig?: Record<string, unknown>,
  ) {
    const id = service.id.trim()
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "service registration missing id",
      })
      return
    }
    record.services.push(id)
    registry.services.push({
      pluginId: record.id,
      service,
      pluginConfig,
      source: record.source,
    })
  }

  function createApi(
    record: PluginRecord,
    params: {
      config: unknown
      pluginConfig?: Record<string, unknown>
    },
  ): PluginApi {
    const logger: PluginLogger = {
      info: (msg) => log.info(`[${record.id}] ${msg}`),
      warn: (msg) => log.warn(`[${record.id}] ${msg}`),
      error: (msg) => log.error(`[${record.id}] ${msg}`),
      debug: (msg) => log.info(`[${record.id}] ${msg}`),
    }

    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      config: params.config,
      pluginConfig: params.pluginConfig,
      logger,
      registerTool: (tool, opts) => registerTool(record, tool, opts),
      registerToolFactory: (factory, opts) => registerToolFactory(record, factory, opts, params.pluginConfig),
      on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts),
      registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      registerChatCommand: (command) => registerChatCommand(record, command),
      registerHttpHandler: (handler) => registerHttpHandler(record, handler),
      registerHttpRoute: (params) => registerHttpRoute(record, params),
      registerService: (service) => registerService(record, service, params.pluginConfig),
      registerChannel: (adapter) => registerChannel(record, adapter, params.pluginConfig),
      registerCron: (job) => registerCron(record, job, params.pluginConfig),
      registerRoute: (route) => registerRoute(record, route),
      registerStage: (stage, position) => registerStage(record, stage, position),
      decorateTool: (decorator) => decorateTool(record, decorator),
      registerRpc: (method) => registerRpc(record, method),
      callRpc: (method, rpcParams) => callRpc(record.id, method, rpcParams, params.config),
      registerStreamTransform: (transform) => registerStreamTransform(record, transform),
      resolvePath: (input) => path.resolve(path.dirname(record.source), input),
      publish: (topic, payload, opts) => bus.publish(record.id, topic, payload, opts),
      subscribe: (topic, handler) => bus.subscribe(record.id, topic, handler),
    }
  }

  return {
    registry,
    createApi,
    pushDiagnostic,
  }
}
