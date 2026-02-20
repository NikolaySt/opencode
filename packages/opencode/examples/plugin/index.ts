/**
 * Example OpenCode Plugin
 *
 * Demonstrates all features of the plugin system including the 8-layer
 * mesh architecture:
 *
 * Phase 1 (Core):
 * - Lifecycle hooks (agent.start, tool.block, message.sent, tool.result.persist)
 * - Tool factory (context-aware tools)
 * - Chat command (/greet)
 * - HTTP route (/plugins/example/hello)
 * - Background service (heartbeat)
 *
 * Phase 2 (Mesh):
 * - L1 Plugin Bus — publish/subscribe for inter-plugin communication
 * - L2 Channel Adapter — webhook channel for external messages
 * - L3 Cron Scheduler — periodic health check job
 * - L4 Agent Routing — pattern-based message routing
 * - L5 Pipeline Stage — request logging before processing
 * - L6 Tool Decorator — audit logging for bash tool
 * - L7 Gateway RPC — callable status method
 * - L8 Stream Transform — token counting on LLM responses
 *
 * To use this plugin, copy it to `.opencode/extensions/example/index.ts`
 * or add its path to `plugins.load.paths` in your opencode.json.
 */

import type { PluginApi } from "../../src/plugin/registry"

export const id = "example"
export const name = "Example Plugin"
export const description = "Demonstrates all plugin + mesh features"
export const version = "0.2.0"

export function register(api: PluginApi) {
  api.logger.info("registering example plugin")

  // ========================================================================
  // Phase 1: Core Plugin Features
  // ========================================================================

  // --- Lifecycle hooks ---

  api.on("agent.start", (event) => {
    api.logger.info(`agent started: ${event.agent} in session ${event.sessionID}`)
    return { prependContext: "Example plugin is active." }
  })

  api.on("agent.finish", (event) => {
    api.logger.info(`agent finished: ${event.agent} (success: ${event.success}, ${event.durationMs}ms)`)
  })

  api.on("session.created", (event) => {
    api.logger.info(`session created: ${event.sessionID}`)
    // Publish session creation event to the plugin bus (L1)
    api.publish("session-created", { sessionID: event.sessionID, time: Date.now() })
  })

  api.on("tool.block", (event) => {
    // Block dangerous commands
    if (event.tool === "bash" && typeof event.args.command === "string" && event.args.command.includes("rm -rf /")) {
      return { block: true, reason: "blocked by example plugin: dangerous command" }
    }
  })

  api.on("tool.before", (event) => {
    api.logger.info(`tool starting: ${event.tool}`)
  })

  api.on("tool.after", (event) => {
    api.logger.info(`tool finished: ${event.tool}`)
  })

  api.on("message.sent", (event) => {
    api.logger.info(
      `LLM response completed for session ${event.sessionID} (success: ${event.success}, ${event.durationMs}ms)`,
    )
  })

  api.on("tool.result.persist", (event) => {
    // Redact sensitive output before persisting
    if (event.output.includes("SECRET")) {
      return { output: event.output.replace(/SECRET\S*/g, "[REDACTED]") }
    }
  })

  // --- Tool factory (context-aware tools) ---

  api.registerToolFactory(
    (ctx) => {
      if (ctx.agent === "coder") {
        return {
          description: "Show example plugin info",
          args: {},
          async execute() {
            return `Example plugin v${version} running for agent: ${ctx.agent}`
          },
        }
      }
      return null
    },
    { names: ["example-info"] },
  )

  // --- Chat command ---

  api.registerChatCommand({
    name: "greet",
    description: "Greet the user with a friendly message",
    acceptsArgs: true,
    async handler(ctx) {
      const who = ctx.args?.trim() || "world"
      return { text: `Hello, ${who}! This message is from the example plugin.` }
    },
  })

  // --- HTTP route ---

  api.registerHttpRoute({
    path: "/hello",
    async handler() {
      return new Response(JSON.stringify({ message: "Hello from example plugin!", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      })
    },
  })

  // --- Background service ---

  api.registerService({
    id: "heartbeat",
    async start(ctx) {
      api.logger.info("heartbeat service started")
      const interval = setInterval(() => {
        if (ctx.abort.aborted) return
        api.logger.info("heartbeat")
        // Publish heartbeat to the bus (L1)
        api.publish("heartbeat", { time: Date.now() }, { retain: true })
      }, 60_000)
      ctx.abort.addEventListener("abort", () => clearInterval(interval))
    },
    async stop() {
      api.logger.info("heartbeat service stopped")
    },
  })

  // ========================================================================
  // Phase 2: Mesh Architecture (8 Layers)
  // ========================================================================

  // --- L1: Plugin Bus — inter-plugin pub/sub ---

  // Subscribe to our own heartbeat topic
  api.subscribe("heartbeat", (payload) => {
    api.logger.info(`bus: heartbeat received: ${JSON.stringify(payload)}`)
  })

  // Subscribe to all events (wildcard) for monitoring
  const wildcard = api.subscribe("*", (payload) => {
    api.logger.info(`bus: wildcard event: ${JSON.stringify(payload)}`)
  })
  // Store handle for potential cleanup (wildcard.unsubscribe() to stop)
  void wildcard

  // --- L2: Channel Adapter — external communication ---

  api.registerChannel({
    id: "example-webhook",
    name: "Example Webhook",
    capabilities: { threads: false, attachments: false },
    async connect(ctx) {
      ctx.logger.info("example webhook channel connected")
      // In a real plugin, you would set up an HTTP webhook listener here
      // and call ctx.deliver(msg) when messages arrive. For example:
      //
      //   const server = Bun.serve({
      //     port: 9090,
      //     async fetch(req) {
      //       const body = await req.json()
      //       const response = await ctx.deliver({
      //         channel: "example-webhook",
      //         source: { id: body.userId, name: body.userName },
      //         content: body.text,
      //       })
      //       return new Response(JSON.stringify(response))
      //     },
      //   })
    },
    async disconnect(ctx) {
      ctx.logger.info("example webhook channel disconnected")
    },
    async health() {
      return { ok: true }
    },
  })

  // --- L3: Cron Scheduler — scheduled tasks ---

  // Health check every 5 minutes
  api.registerCron({
    id: "health-check",
    schedule: { kind: "interval", ms: 300_000 },
    action: {
      type: "custom",
      handler: async (ctx) => {
        ctx.logger.info(`health check run #${ctx.runCount}`)
        api.publish("health", { ok: true, time: Date.now(), runCount: ctx.runCount }, { retain: true })
      },
    },
  })

  // Publish a daily summary at midnight (cron expression)
  api.registerCron({
    id: "daily-summary",
    schedule: { kind: "cron", expression: "0 0 * * *" },
    action: {
      type: "publish",
      topic: "daily-summary",
      payload: { type: "scheduled", time: new Date().toISOString() },
    },
  })

  // --- L4: Agent Routing — programmable message dispatch ---

  // Route messages containing "deploy" or "release" to the coder agent
  api.registerRoute({
    id: "deploy-requests",
    match: { type: "pattern", pattern: /deploy|release|ship/i },
    agent: "coder",
    priority: 5,
    metadata: { reason: "deployment-related request" },
  })

  // Default route for the example webhook channel
  api.registerRoute({
    id: "webhook-default",
    match: { type: "channel", channel: "example-webhook" },
    agent: "coder",
    priority: 1,
    sessionScope: "source",
  })

  // --- L5: Pipeline Stage — composable middleware ---

  // Insert a request-logging stage before the LLM processing stage
  api.registerStage(
    {
      name: "example-request-logger",
      handler: async (ctx, next) => {
        const start = Date.now()
        api.logger.info(`pipeline: processing session ${ctx.sessionID} (agent: ${ctx.agent})`)
        await next()
        api.logger.info(`pipeline: completed session ${ctx.sessionID} in ${Date.now() - start}ms`)
      },
    },
    { type: "before", target: "process" },
  )

  // --- L6: Tool Decorator — wrap tool execution ---

  // Audit logging for the bash tool
  api.decorateTool({
    tool: "bash",
    decorator: (original, info) => async (args, ctx) => {
      const cmd = typeof args.command === "string" ? args.command.slice(0, 100) : "?"
      api.logger.info(`[audit] ${ctx.agent} calling ${info.tool}: ${cmd}`)
      const result = await original(args, ctx)
      api.logger.info(`[audit] ${info.tool} completed (${result.output.length} chars)`)
      return result
    },
    priority: 0,
  })

  // Timing decorator for all tools
  api.decorateTool({
    tool: "*",
    decorator: (original, info) => async (args, ctx) => {
      const start = Date.now()
      const result = await original(args, ctx)
      result.metadata = { ...result.metadata, durationMs: Date.now() - start }
      api.logger.info(`[timing] ${info.tool}: ${Date.now() - start}ms`)
      return result
    },
    priority: -10, // inner wrapper (runs closest to the original)
  })

  // --- L7: Gateway RPC — callable plugin methods ---

  api.registerRpc({
    name: "status",
    description: "Get example plugin status and health info",
    handler: async () => ({
      plugin: api.name,
      version,
      status: "ok",
      uptime: process.uptime(),
      time: Date.now(),
    }),
  })

  api.registerRpc({
    name: "echo",
    description: "Echo back the provided parameters",
    handler: async (params) => ({ echo: params }),
  })

  // --- L8: Stream Transform — LLM response stream middleware ---

  // Token counter — observes the stream without modifying it
  api.registerStreamTransform({
    name: "example-token-counter",
    async *transform(stream) {
      let chars = 0
      let events = 0
      for await (const event of stream) {
        events++
        if (event.type === "text-delta") chars += event.text.length
        yield event
      }
      api.logger.info(`stream: ${events} events, ~${chars} text chars`)
    },
    priority: 0, // inner — runs closest to the LLM stream
  })

  api.logger.info("example plugin registered (all 8 mesh layers active)")
}
