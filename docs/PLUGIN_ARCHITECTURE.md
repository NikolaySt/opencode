# OpenCode Plugin & Mesh Architecture — Complete Overview

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Dual Plugin Systems](#2-dual-plugin-systems)
3. [Plugin Discovery (4-Tier)](#3-plugin-discovery-4-tier)
4. [Plugin Lifecycle](#4-plugin-lifecycle)
5. [The PluginApi Object](#5-the-pluginapi-object)
6. [Hook System (15 Typed Hooks)](#6-hook-system-15-typed-hooks)
7. [Chat Commands](#7-chat-commands)
8. [HTTP Routes & Handlers](#8-http-routes--handlers)
9. [Background Services](#9-background-services)
10. [Exclusive Slots](#10-exclusive-slots)
11. [Configuration](#11-configuration)
12. [Tool Factories](#12-tool-factories)
13. [CLI Commands](#13-cli-commands)
14. [Error Handling & Diagnostics](#14-error-handling--diagnostics)
15. [Mesh Layer 1 — Plugin Message Bus](#15-mesh-layer-1--plugin-message-bus)
16. [Mesh Layer 2 — Channel Adapters](#16-mesh-layer-2--channel-adapters)
17. [Mesh Layer 3 — Cron / Scheduler](#17-mesh-layer-3--cron--scheduler)
18. [Mesh Layer 4 — Agent Routing](#18-mesh-layer-4--agent-routing)
19. [Mesh Layer 5 — Pipeline Stages](#19-mesh-layer-5--pipeline-stages)
20. [Mesh Layer 6 — Tool Decorators](#20-mesh-layer-6--tool-decorators)
21. [Mesh Layer 7 — Gateway RPC](#21-mesh-layer-7--gateway-rpc)
22. [Mesh Layer 8 — Stream Middleware](#22-mesh-layer-8--stream-middleware)
23. [Production Wiring](#23-production-wiring)
24. [Integration Map](#24-integration-map)
25. [Examples](#25-examples)
26. [File Inventory](#26-file-inventory)

---

## 1. System Overview

OpenCode's plugin system has two coexisting layers: a **legacy plugin loader** (npm packages with hooks) and a **new-style plugin system** (filesystem discovery with typed hooks, commands, services, and mesh infrastructure). On top of the plugin foundation sits an **8-layer mesh architecture** that transforms OpenCode from a single-channel coding assistant into a universal agent mesh platform.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Plugin.state()                                  │
│  (lazy singleton, initialized once per project)                          │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────────────────────────────────┐  │
│  │  Legacy Loader    │  │  New-Style Loader                           │  │
│  │  (npm packages,   │  │  (discovery + registry + hooks + commands   │  │
│  │   internal auth)  │  │   + HTTP + services + slots)                │  │
│  │                   │  │                                              │  │
│  │  → Hooks[]        │  │  → PluginRegistry                           │  │
│  │                   │  │  → HookRunner                                │  │
│  └──────────────────┘  │  → Mesh Infrastructure (8 layers)            │  │
│                         └──────────────────────────────────────────────┘  │
│                                                                          │
│  Exports:                                                                │
│    Plugin.trigger()       ← Legacy API                                   │
│    Plugin.getRegistry()   ← New API (all registrations + mesh state)     │
│    Plugin.getHookRunner() ← New API (typed hook execution)               │
└──────────────────────────────────────────────────────────────────────────┘
```

Both systems are initialized together in `plugin/index.ts` via `Instance.state()`. The legacy loader runs first, then the new-style loader runs discovery and registration. Results coexist — legacy hooks are invoked via `Plugin.trigger()`, new-style hooks via the `HookRunner`.

### Principles

1. **Backward compatible** — Every new capability is additive. Existing plugins, hooks, and the TUI continue working unchanged.
2. **Plugin-first** — All new features are registered via the `PluginApi`. No new hardcoded behavior.
3. **Typed** — Zod schemas for validation, TypeScript types inferred. All hook events, RPC payloads, and config are typed.
4. **Mesh, not tree** — Any component can talk to any other. Channels publish to the bus, the router reads from the bus, agents publish back, cron jobs trigger agents, tools call RPC methods.
5. **No external dependencies for core** — Core infrastructure uses Bun-native APIs. Channel implementations (Slack, Discord) are separate plugins.
6. **Fail open** — Plugin errors are caught and logged. A broken channel plugin doesn't crash the server. A slow stream middleware doesn't block the pipeline.

---

## 2. Dual Plugin Systems

### Legacy System (backward compatible)

- Plugins are npm packages listed in `config.plugin[]`
- Each exports a function `(input: PluginInput) => Promise<Hooks>`
- Internal plugins (Codex, Copilot, GitLab auth) are hardcoded imports
- Invoked via `Plugin.trigger("hookName", input, output)`

### New-Style System

- Plugins are `.ts`/`.js` files discovered from the filesystem
- Each exports `{ register(api: PluginApi): void }` or a bare `register` function
- Supports: typed hooks, chat commands, HTTP routes, CLI extensions, background services, exclusive slots, and all 8 mesh layers
- Module resolution handles: default export objects, bare function exports, `register` or `activate` method names

**Key file:** `plugin/index.ts` — the `resolvePluginExport()` function handles all export shapes:

```ts
// These all work:
export default { register(api) { ... } }        // object with register
export default { activate(api) { ... } }        // object with activate
export function register(api) { ... }           // bare named export
export default function(api) { ... }            // bare default export
```

---

## 3. Plugin Discovery (4-Tier)

Discovery runs synchronously in `discovery.ts` and scans 4 tiers in priority order:

| Tier | Origin      | Location                                                                | Priority |
| ---- | ----------- | ----------------------------------------------------------------------- | -------- |
| 1    | `config`    | Explicit paths from `plugins.load.paths` in `opencode.json`             | Highest  |
| 2    | `workspace` | `.opencode/extensions/` and `.opencode/plugins/` in project config dirs | High     |
| 3    | `global`    | `~/.config/opencode/extensions/` and `~/.config/opencode/plugins/`      | Medium   |
| 4    | `bundled`   | Built-in (reserved for future use)                                      | Lowest   |

### What gets discovered

Within each tier directory, the system scans for:

1. **Bare files** — `my-plugin.ts` → id hint = `my-plugin`
2. **Directory with index** — `my-plugin/index.ts` → id hint = `my-plugin`
3. **Package with manifest** — `my-plugin/package.json` with `opencode.extensions: ["./entry.ts"]` → id derived from package name

### Deduplication

- By resolved file path (same file never loaded twice)
- By plugin ID (first origin wins — config overrides workspace overrides global)

### Supported file extensions

`.ts`, `.js`, `.mts`, `.cts`, `.mjs`, `.cjs` — but NOT `.d.ts`

---

## 4. Plugin Lifecycle

For each discovered candidate, the loading pipeline in `plugin/index.ts` proceeds:

```
Discovery → Deduplicate → Check enabled → Import module → Resolve exports
    → Check for register/activate → Slot resolution → Config validation
    → Create PluginApi → Call register(api) → Push to registry
```

Each step can short-circuit with a diagnostic:

| Step                | Failure Mode                         | Result                                            |
| ------------------- | ------------------------------------ | ------------------------------------------------- |
| Deduplicate         | ID already seen                      | `status: "disabled"`, `error: "overridden by..."` |
| Enabled check       | `entries.{id}.enabled: false`        | `status: "disabled"`                              |
| Import              | Module fails to load                 | `status: "error"`, diagnostic pushed              |
| No register export  | Legacy-style or invalid module       | Silently skipped                                  |
| Slot resolution     | Another memory plugin already loaded | `status: "disabled"`                              |
| Config validation   | Missing required fields              | `status: "error"`, diagnostic pushed              |
| register() throws   | Runtime error in plugin              | `status: "error"`, diagnostic pushed              |
| register() is async | Returns a Promise                    | **Properly awaited** (not fire-and-forget)        |

---

## 5. The PluginApi Object

Every new-style plugin receives a `PluginApi` in its `register()` function. This is the plugin's interface to the host system. Defined in `registry.ts`:

```ts
type PluginApi = {
  // ── Metadata (read-only) ──────────────────────────────────────────────
  id: string
  name: string
  version?: string
  description?: string
  source: string

  // ── Config ────────────────────────────────────────────────────────────
  config: unknown // Full opencode config
  pluginConfig?: Record<string, unknown> // This plugin's config from opencode.json

  // ── Logging (prefixed with [pluginId]) ────────────────────────────────
  logger: PluginLogger

  // ── Phase 1: Core Registration ────────────────────────────────────────
  registerTool(tool, opts?) // Register a static tool
  registerToolFactory(factory, opts?) // Register a context-aware tool factory
  on(hookName, handler, opts?) // Register a lifecycle hook
  registerCli(registrar, opts?) // Register CLI commands
  registerChatCommand(command) // Register a /command
  registerHttpHandler(handler) // Register a generic HTTP handler
  registerHttpRoute({ path, handler }) // Register a named HTTP route
  registerService(service) // Register a background service

  // ── Phase 2: Mesh Registration ────────────────────────────────────────
  registerChannel(adapter) // L2: Register a channel adapter
  registerCron(job) // L3: Register a cron/scheduled job
  registerRoute(route) // L4: Register an agent routing rule
  registerStage(stage, position) // L5: Register a pipeline stage
  decorateTool(decorator) // L6: Register a tool decorator
  registerRpc(method) // L7: Register an RPC method
  registerStreamTransform(transform) // L8: Register a stream transform

  // ── Mesh Communication ────────────────────────────────────────────────
  publish(topic, payload, opts?) // L1: Publish to plugin bus
  subscribe(topic, handler) // L1: Subscribe to plugin bus topic
  callRpc(method, params?) // L7: Call an RPC method (returns Promise<unknown>)

  // ── Utility ───────────────────────────────────────────────────────────
  resolvePath(input) // Resolve path relative to plugin's source dir
}
```

### `resolvePath` behavior

`api.resolvePath("./data.json")` resolves relative to the plugin's source file directory (not CWD). This lets plugins reference sibling files reliably.

---

## 6. Hook System (15 Typed Hooks)

Hooks are the primary extension mechanism. There are two execution modes:

### Void Hooks (fire-and-forget, parallel)

All registered handlers run simultaneously via `Promise.allSettled`. This ensures all handlers complete even if one throws. Used for observability/side effects. When `catchErrors: false`, the runner re-throws the first rejection after all handlers have settled.

| Hook                | Event Type                                                | When Fired                   |
| ------------------- | --------------------------------------------------------- | ---------------------------- |
| `session.created`   | `{ sessionID }`                                           | New session created          |
| `session.archived`  | `{ sessionID }`                                           | Session archived             |
| `agent.finish`      | `{ sessionID, agent, success, error?, durationMs? }`      | Agent loop completes         |
| `message.received`  | `{ sessionID, content }`                                  | User message received        |
| `compaction.before` | `{ sessionID, messageCount?, tokenCount? }`               | Before context compaction    |
| `compaction.after`  | `{ sessionID, messageCount?, tokenCount? }`               | After context compaction     |
| `tool.before`       | `{ tool, args, sessionID }`                               | Before tool execution        |
| `tool.after`        | `{ tool, args, sessionID, result?, error?, durationMs? }` | After tool execution         |
| `message.sent`      | `{ sessionID, messageID, success, error?, durationMs? }`  | After LLM response completes |
| `server.start`      | `{ port? }`                                               | Server starts                |
| `server.stop`       | `{ port? }`                                               | Server stops                 |

### Modifying Hooks (sequential, priority-ordered)

Handlers run one at a time, highest priority first. Each can return a result that gets merged with previous results.

| Hook                  | Event Type                                                    | Result Type                          | Merge Behavior                                                               |
| --------------------- | ------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `agent.start`         | `{ sessionID, agent, model }`                                 | `{ systemPrompt?, prependContext? }` | `systemPrompt`: last writer wins; `prependContext`: concatenated with `\n\n` |
| `message.sending`     | `{ sessionID, content }`                                      | `{ content?, cancel? }`              | Last non-undefined wins for each field                                       |
| `tool.block`          | `{ tool, args, sessionID }`                                   | `{ block?, reason? }`                | Last non-undefined wins for each field                                       |
| `tool.result.persist` | `{ sessionID, tool, callID, output, title, metadata, input }` | `{ output?, title?, metadata? }`     | `metadata` shallow-merged; `output`/`title` last writer wins                 |

### Priority

Higher number = runs first (for modifying hooks, this means earlier in the chain):

```ts
api.on("agent.start", handler, { priority: 10 }) // Runs before priority: 1
```

For modifying hooks, the **last writer wins** — so lower priority handlers override higher ones for scalar fields.

### Timeouts

All hooks have a 30-second default timeout (configurable via `createHookRunner(registry, { timeoutMs: 5000 })`). Timed-out handlers are caught and logged by default (`catchErrors: true`).

### Production Wiring

All 15 hooks are wired into production code paths:

| Hook                  | Wiring Location                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `session.created`     | `session/index.ts` — after session creation                                                        |
| `session.archived`    | `server/routes/session.ts` — after archiving                                                       |
| `agent.start`         | `session/prompt.ts` — before LLM call, injects `systemPrompt`/`prependContext`                     |
| `agent.finish`        | `session/prompt.ts` — after agent loop completes                                                   |
| `message.received`    | `session/prompt.ts` — when user message arrives                                                    |
| `message.sending`     | `session/prompt.ts` — before `processor.process()`, can cancel                                     |
| `message.sent`        | `session/prompt.ts` — after LLM response completes (fire-and-forget)                               |
| `compaction.before`   | `session/compaction.ts` — before context compaction                                                |
| `compaction.after`    | `session/compaction.ts` — after context compaction                                                 |
| `tool.block`          | `session/prompt.ts` — in `resolveTools()` for both ToolRegistry and MCP tools                      |
| `tool.before`         | `session/prompt.ts` — before tool execution                                                        |
| `tool.after`          | `session/prompt.ts` — after tool execution                                                         |
| `tool.result.persist` | `session/processor.ts` (streaming tool results) and `session/prompt.ts` (TaskTool subtask results) |
| `server.start`        | `server/server.ts` — after server starts listening                                                 |
| `server.stop`         | `server/server.ts` — before server shuts down                                                      |

---

## 7. Chat Commands

Plugins can register `/command`-style chat commands that bypass the LLM agent entirely.

### Registration

```ts
api.registerChatCommand({
  name: "deploy",
  description: "Deploy the application",
  aliases: ["ship", "push"],
  acceptsArgs: true,
  requireAuth: true,
  async handler(ctx) {
    return { text: `Deployed: ${ctx.args}` }
  },
})
```

### How it works

1. Plugin registers command in `register()` → stored in `PluginRegistry.chatCommands`
2. After all plugins load, `ChatCommand.register()` is called for each → stored in module-level `Map<string, RegisteredCommand>`
3. When user types `/deploy my-app`, `prompt.ts` calls `ChatCommand.match("/deploy my-app")` before sending to the LLM
4. If matched, `ChatCommand.execute()` runs the handler directly and returns the result

### Protections

- **Reserved names**: `help`, `clear`, `compact`, `export`, `share`, `model`, `agent`, `undo`, `redo`, `plan`, `build`, `config`, `status`
- **Name validation**: Must start with a letter, alphanumeric + hyphens + underscores only
- **Alias collision detection**: Aliases can't conflict with existing commands or aliases
- **Arg sanitization**: Control characters stripped, max 4096 chars
- **Auth gating**: If `requireAuth: true`, checks `OPENCODE_SERVER_PASSWORD` flag
- **Execution locking**: Only one command executes at a time (prevents re-entrant registration)
- **Deduped listing**: `ChatCommand.list()` deduplicates aliases so each command appears once

---

## 8. HTTP Routes & Handlers

Plugins can expose HTTP endpoints on the OpenCode server.

### Two registration styles

**Named routes** (recommended) — automatically namespaced:

```ts
api.registerHttpRoute({
  path: "/status",
  handler: async (req) => new Response(JSON.stringify({ ok: true })),
})
// Accessible at: GET /plugins/{pluginId}/status
```

**Generic handlers** — catch-all, can return `null` to pass through:

```ts
api.registerHttpHandler(async (req) => {
  if (new URL(req.url).pathname.includes("special")) {
    return new Response("caught")
  }
  return null // Pass to next handler
})
```

### How it works in `server.ts`

When a request comes in to `/plugins/*`:

1. First, check all registered `httpRoutes` for an exact path match
2. If no route matches, iterate through `httpHandlers` until one returns a non-null Response
3. Both handlers are wrapped in try/catch to prevent plugin errors from crashing the server

Duplicate route paths are rejected during registration with a diagnostic.

---

## 9. Background Services

Plugins can register long-running background services that start with the server and stop on shutdown.

```ts
api.registerService({
  id: "heartbeat",
  async start(ctx) {
    const interval = setInterval(() => {
      if (ctx.abort.aborted) return
      api.logger.info("heartbeat")
    }, 60_000)
    ctx.abort.addEventListener("abort", () => clearInterval(interval))
  },
  async stop(ctx) {
    api.logger.info("heartbeat stopped")
  },
})
```

### Service context

```ts
type PluginServiceContext = {
  config: unknown
  pluginConfig?: Record<string, unknown>
  workspaceDir?: string
  abort: AbortSignal
}
```

### Lifecycle

- **Start**: Called sequentially for each service. 60-second timeout per service. If `start()` throws or times out, the service is skipped (not fatal).
- **Stop**: Called in reverse order (LIFO). The `AbortController` is aborted first, then each `stop()` is called with a 60-second timeout.
- **Server integration**: `server.ts` starts services after the server is listening and awaits them during `server.stop()`.

---

## 10. Exclusive Slots

Some plugin categories are **exclusive** — only one plugin of that kind can be active.

Currently, only `"memory"` is an exclusive slot. Resolution logic in `slots.ts`:

| Scenario                                                    | Result                          |
| ----------------------------------------------------------- | ------------------------------- |
| Non-memory plugin                                           | Always enabled                  |
| Memory plugin, no prior selection, no config                | **Enabled** (first-loaded wins) |
| Memory plugin, another already selected                     | **Disabled**                    |
| Memory plugin, explicit `slots.memory: "this-id"` in config | **Enabled**                     |
| Memory plugin, explicit slot names a different plugin       | **Disabled**                    |

Configuration in `opencode.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "preferred-memory-plugin-id"
    }
  }
}
```

---

## 11. Configuration

The `plugins` section in `opencode.json` controls the new plugin system:

```json
{
  "plugins": {
    "load": {
      "paths": ["./custom-plugins/my-plugin.ts"]
    },
    "slots": {
      "memory": "my-memory-plugin"
    },
    "entries": {
      "my-plugin": {
        "enabled": true,
        "config": {
          "apiKey": "sk-...",
          "region": "us-east-1"
        }
      },
      "unwanted-plugin": {
        "enabled": false
      }
    }
  }
}
```

| Field                          | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `plugins.load.paths`           | Extra plugin paths (tier 1, highest priority)          |
| `plugins.slots.memory`         | Which memory plugin wins the exclusive slot            |
| `plugins.entries.{id}.enabled` | Enable/disable a discovered plugin                     |
| `plugins.entries.{id}.config`  | Per-plugin configuration, passed as `api.pluginConfig` |

Plugin config is validated against an optional JSON Schema before `register()` is called. The validation is intentionally lightweight (type + required fields only) — plugins are expected to validate thoroughly in their own `register()`.

---

## 12. Tool Factories

In addition to static tools (registered via `api.registerTool()`), plugins can register **tool factories** — functions that produce tools dynamically based on runtime context like the active agent or plugin configuration.

### Registration

```ts
api.registerToolFactory(
  (ctx) => {
    if (ctx.agent === "coder") {
      return {
        description: "Deploy the current project",
        args: { target: z.string() },
        async execute(input) {
          return `Deployed to ${input.target}`
        },
      }
    }
    return null
  },
  { names: ["deploy"] },
)
```

### How it works

1. Factories are stored in `PluginRegistry.toolFactories` during `register()`
2. When `ToolRegistry.tools()` is called (e.g., before an agent loop), each factory is invoked with the current agent context
3. Factories can return a single `ToolDefinition`, an array, or `null`/`undefined` to skip
4. Factory results are merged with static tools — factory tools can override static tools
5. Resolution is **lazy**: factories only run when tools are actually needed, not at plugin load time

### Factory Context

```ts
type PluginToolFactoryContext = {
  config: unknown
  pluginConfig?: Record<string, unknown>
  agent?: string
}
```

---

## 13. CLI Commands

The `opencode plugins` CLI command provides introspection:

```bash
opencode plugins list          # List all discovered plugins with status
opencode plugins list --full   # Include diagnostics
opencode plugins info <id>     # Detailed info about a specific plugin
```

Plugins can also register their own CLI commands via `api.registerCli()`, though the CLI integration point is reserved for future use.

---

## 14. Error Handling & Diagnostics

The system collects `PluginDiagnostic` objects throughout the lifecycle:

```ts
type PluginDiagnostic = {
  level: "warn" | "error"
  message: string
  pluginId?: string
  source?: string
}
```

Diagnostics are generated for:

- Discovery failures (missing paths, unreadable directories)
- Module import errors
- Config validation failures
- Registration errors (empty command names, duplicate routes, empty service IDs, empty channel IDs)
- Duplicate tool registrations (warning level — override is allowed)
- `register()` function throwing

All diagnostics are logged at the end of initialization and available via `Plugin.getRegistry()` for programmatic access.

---

## 15. Mesh Layer 1 — Plugin Message Bus

**File:** `src/plugin/bus.ts` (134 lines)

A namespaced, typed pub/sub system for inter-plugin communication. Topics are auto-namespaced by plugin ID. This is separate from the system `Bus` (in `src/bus/`) which drives SSE events for the TUI.

### API

```ts
api.publish("data-ready", { count: 42 }) // → publishes to "my-plugin.data-ready"
api.subscribe("data-ready", handler) // → subscribes to "my-plugin.data-ready"
api.subscribe("other-plugin.data-ready", handler) // → cross-plugin subscription
api.subscribe("*", handler) // → wildcard, receives all topics
```

### Features

- **Topic namespacing** — `api.publish("foo", ...)` publishes to `{pluginId}.foo`. Topics containing `.` are treated as already-qualified.
- **Retained messages** — `api.publish("status", data, { retain: true })` keeps the last message. Late subscribers receive it immediately on subscribe.
- **Wildcard subscriptions** — `api.subscribe("*", handler)` receives all topics from all plugins.
- **Error isolation** — Handler errors are caught and logged; they never break other subscribers. Delivery uses `Promise.allSettled()`.
- **Unsubscribe** — `subscribe()` returns `{ unsubscribe, ready }`. The `ready` promise resolves after any retained message is delivered to the new subscriber.
- **Plugin cleanup** — `bus.clear(pluginId)` removes all subscriptions AND purges retained messages owned by that plugin (topics prefixed with `{pluginId}.`).

### Introspection

```ts
bus.topics() // List all topics with active subscriptions
bus.subscriberCount() // Total subscriber count (including wildcards)
bus.subscriberCount("t") // Subscriber count for specific topic (includes wildcards)
```

---

## 16. Mesh Layer 2 — Channel Adapters

**File:** `src/plugin/channel.ts` (230 lines)

Abstraction layer for external communication endpoints (Slack, Discord, MQTT, webhooks, etc.). Each channel plugin registers an adapter that normalizes inbound messages and delivers outbound responses.

### Registration

```ts
api.registerChannel({
  id: "slack",
  name: "Slack",
  capabilities: { threads: true, attachments: true },
  async setup(ctx) {
    // Optional one-time setup (OAuth, webhook registration)
  },
  async connect(ctx) {
    // Start listening for messages
    app.message(async ({ message }) => {
      const response = await ctx.deliver({
        channel: "slack",
        source: { id: message.user, group: message.channel },
        content: message.text,
        threadID: message.thread_ts,
      })
      await app.client.chat.postMessage({
        channel: message.channel,
        text: response.content,
        thread_ts: message.thread_ts,
      })
    })
  },
  async disconnect(ctx) {
    // Cleanup on shutdown
  },
  async health(ctx) {
    return { ok: true }
  },
})
```

### Message Types

```ts
type ChannelMessage = {
  channel: string // "slack", "discord", "mqtt"
  source: ChannelSource // who sent it
  content: string
  threadID?: string // for conversation threading
  attachments?: ChannelAttachment[]
  metadata?: Record<string, unknown>
  raw?: unknown // original message object
}

type ChannelResponse = {
  content: string
  attachments?: ChannelAttachment[]
  metadata?: Record<string, unknown>
  replyTo?: string // threadID to reply in
}
```

### How it works

1. Plugin calls `api.registerChannel(adapter)` during `register()`
2. On server start, `startChannels()` calls `setup()` then `connect()` on each adapter (with 60s timeout)
3. The adapter's `connect()` sets up its own inbound listener (WebSocket, webhook, polling, etc.)
4. When a message arrives, the adapter calls `ctx.deliver(msg)` — this bridges into OpenCode
5. `deliver()` resolves the target agent via the **Router (L4)**, creates/finds a session, calls `SessionPrompt.prompt()`, and returns a `ChannelResponse`
6. On server stop, `disconnect()` is called in reverse order (LIFO) with 30s timeout, BEFORE the abort signal is triggered (so disconnect handlers see a non-aborted signal). A double-stop guard prevents `stop()` from running twice

### Session Mapping

Each channel+source combination maps to a session via `ChannelSessionMap`:

```ts
sessionKey(msg, "source") // → "channel:slack:U12345"
sessionKey(msg, "group") // → "channel:slack:C67890:thread_ts"
sessionKey(msg, "global") // → "channel:slack:global"
```

### Channel Capabilities

```ts
type ChannelCapabilities = {
  threads?: boolean // supports threaded conversations
  attachments?: boolean // supports file/image attachments
  reactions?: boolean // supports emoji reactions
  streaming?: boolean // supports streaming responses
}
```

---

## 17. Mesh Layer 3 — Cron / Scheduler

**File:** `src/plugin/cron.ts` (369 lines)

Lets plugins register scheduled tasks with interval, cron expression, or one-shot timers. Jobs are started alongside services in the server lifecycle and cleaned up on shutdown.

### Registration

```ts
// Interval job — runs every 5 minutes
api.registerCron({
  id: "sync-data",
  schedule: { kind: "interval", ms: 300_000 },
  action: {
    type: "custom",
    handler: async (ctx) => {
      /* sync logic */
    },
  },
})

// Cron expression — runs at 9am every weekday
api.registerCron({
  id: "daily-report",
  schedule: { kind: "cron", expression: "0 9 * * 1-5" },
  action: { type: "publish", topic: "report-ready", payload: { date: new Date() } },
})

// One-shot — runs once at a specific time
api.registerCron({
  id: "reminder",
  schedule: { kind: "once", at: new Date("2025-12-31T23:59:00") },
  action: {
    type: "custom",
    handler: async (ctx) => {
      /* fire once */
    },
  },
})
```

### Schedule Types

| Kind       | Implementation               | Notes                                                                                |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `interval` | `setInterval(run, ms)`       | Fixed interval, may drift slightly                                                   |
| `cron`     | `setInterval(check, 60_000)` | Checks every 60s if expression matches; `lastFiredMinute` dedup prevents double-fire |
| `once`     | `setTimeout(run, delay)`     | Single execution, then status=`completed`                                            |

### Cron Expression Parser

Built-in 5-field parser (minute hour dom month dow). Supports:

- Wildcards: `*`
- Lists: `1,3,5`
- Ranges: `1-5`
- Steps: `*/5`, `1-30/2`
- Timezone: `cronMatches(expr, date, "America/New_York")` — uses `toLocaleString("en-US", { timeZone })` to extract timezone-adjusted components

### Job State

```ts
type CronJobState = {
  id: string
  pluginId: string
  status: "active" | "paused" | "completed" | "error"
  lastRun?: number
  nextRun?: number
  runCount: number
  errorCount: number
  lastError?: string
}
```

### Error Handling & Backoff

- Errors are caught and logged per-run
- After `maxRetries` (default 3) consecutive failures, status is set to `"error"` and the timer is cleared
- `backoffMs` (default 5000ms): After a non-fatal error, a `backoffUntil` timestamp is set to `Date.now() + backoffMs * errorCount`. The `run()` function skips execution while within the backoff window. On success, backoff resets to 0
- Jobs can be paused/resumed via the `CronHandle`:
  - `handle.pause(jobId)` — sets status to `"paused"` (only from `"active"`)
  - `handle.resume(jobId)` — sets status to `"active"` (from `"paused"` or `"error"`), resets both `errorCount` and `backoffUntil`, and re-creates the timer
  - Once-jobs in `"error"` state cannot be resumed (the one-shot timer has already fired)

### Async Stop

`CronHandle.stop()` is async. It aborts the controller, clears all timers, then awaits `Promise.allSettled([...inFlight])` to wait for any in-flight `run()` calls to complete before returning. In `server.ts`, this is called as `await cron.stop()`.

### Publish Action

When `action.type === "publish"`, the cron scheduler calls `bus.publish(pluginId, topic, payload)` — bridging cron jobs to the plugin bus.

---

## 18. Mesh Layer 4 — Agent Routing

**File:** `src/plugin/router.ts` (135 lines)

Programmable message-to-agent dispatch. Routes are registered by plugins and matched in priority order against inbound channel messages.

### Registration

```ts
// Route all Slack DMs from a specific user to the "coder" agent
api.registerRoute({
  id: "vip-user",
  match: { type: "source", channel: "slack", sourceId: "U12345" },
  agent: "coder",
  priority: 10,
  sessionScope: "source",
})

// Route messages matching a pattern to a specialized agent
api.registerRoute({
  id: "deploy-requests",
  match: { type: "pattern", pattern: /deploy|ship|release/i },
  agent: "devops",
  priority: 5,
})

// Default route for all messages from Discord
api.registerRoute({
  id: "discord-default",
  match: { type: "channel", channel: "discord" },
  agent: "assistant",
})
```

### Match Types (checked in priority order)

| Type      | Matches On                       |
| --------- | -------------------------------- |
| `source`  | Exact channel + source ID        |
| `group`   | Exact channel + group ID         |
| `pattern` | Content regex (string or RegExp) |
| `channel` | All messages from a channel      |
| `default` | Fallback (always matches)        |

Routes are sorted by `priority` (higher first). The first matching route wins. If no route matches, the system default agent is used. Invalid regex patterns in `"pattern"` routes are caught gracefully — the route is skipped and the next one is tried. A warning is logged if a `"default"` route has `priority > 0`, since it will shadow all lower-priority routes.

### Resolved Route

```ts
type ResolvedRoute = {
  agent: string // which agent to use
  sessionKey: string // deterministic key for session lookup/creation
  matchedBy: string // debug string: "source:slack:U12345" or "pattern:/deploy/"
  routeId: string // the route's ID
  metadata?: Record<string, unknown>
}
```

---

## 19. Mesh Layer 5 — Pipeline Stages

**File:** `src/plugin/pipeline.ts` (177 lines)

Koa-style composable middleware chain. Plugins register named stages that can be inserted before, after, or in place of built-in stages. The pipeline is compiled once and executed per-request.

### Built-in Stage Names

```ts
const STAGE = {
  VALIDATE: "validate",
  CHAT_COMMAND: "chat-command",
  CREATE_MESSAGE: "create-message",
  RESOLVE_AGENT: "resolve-agent",
  RESOLVE_TOOLS: "resolve-tools",
  BUILD_SYSTEM: "build-system",
  AGENT_START: "agent-start",
  PRE_SEND: "pre-send",
  PROCESS: "process",
  POST_PROCESS: "post-process",
  COMPACTION_CHECK: "compaction-check",
}
```

### Registration

```ts
// Insert a rate-limiter before the LLM call
api.registerStage(
  {
    name: "rate-limiter",
    handler: async (ctx, next) => {
      if (isRateLimited(ctx)) return // short-circuit
      await next()
    },
  },
  { type: "before", target: "process" },
)

// Replace the system prompt builder
api.registerStage({ name: "build-system", handler: customSystemBuilder }, { type: "replace", target: "build-system" })
```

### Position Types

| Position  | Behavior                                         |
| --------- | ------------------------------------------------ |
| `before`  | Insert before the target stage                   |
| `after`   | Insert after the target stage                    |
| `replace` | Replace the target stage (last replacement wins) |

### Pipeline Execution

```ts
// Assemble: built-in stages + plugin stages → ordered list
const stages = assemble(builtins, registrations)

// Compile: ordered list → single executable function (Koa-style)
const pipeline = compile(stages)

// Execute: run with context and optional final handler
await pipeline(ctx, finalNext)
```

Each stage calls `next()` to continue. If a stage does not call `next()`, the pipeline short-circuits. Double-calling `next()` throws an error.

### Production Wiring

The pipeline is fully wired into `session/prompt.ts`. The normal processing path (section B9 of the `loop()` function) is extracted into 9 named built-in stages. Each iteration of the while-loop:

1. Builds the built-in `PipelineStage[]` as closures over shared mutable state
2. Fetches `registry.pipelineStages` for any plugin-registered stages
3. Calls `createPipeline(builtins, registrations)` to assemble + compile
4. Executes the pipeline with a `PipelineContext` carrying `sessionID`, `agent`, `model`, `abort`, and `metadata`
5. Reads `ctx.signal` after execution to determine loop control: `"stop"` breaks, `"compact"` creates a compaction task

Plugin stages registered via `api.registerStage()` are inserted relative to the built-in stages (before, after, or replace) and participate in the Koa-style middleware chain.

---

## 20. Mesh Layer 6 — Tool Decorators

**File:** `src/plugin/decorator.ts` (96 lines)

Wrap/transform tool `execute` functions with a decorator pattern. Decorators can modify arguments, post-process results, add logging, enforce policies, or completely replace tool behavior.

### Registration

```ts
// Audit decorator — logs all bash tool invocations
api.decorateTool({
  tool: "bash",
  decorator: (original, info) => async (args, ctx) => {
    api.logger.info(`[audit] ${ctx.agent} calling ${info.tool}: ${JSON.stringify(args)}`)
    const result = await original(args, ctx)
    api.logger.info(`[audit] ${info.tool} returned: ${result.output.slice(0, 100)}`)
    return result
  },
})

// Wildcard decorator — add timing to all tools
api.decorateTool({
  tool: "*",
  decorator: (original, info) => async (args, ctx) => {
    const start = Date.now()
    const result = await original(args, ctx)
    result.metadata.durationMs = Date.now() - start
    return result
  },
  priority: 0,
})

// Regex decorator — block file writes to /etc
api.decorateTool({
  tool: /^(write|edit)$/,
  decorator: (original) => async (args, ctx) => {
    if (String(args.filePath).startsWith("/etc")) {
      return { title: "Blocked", output: "Cannot write to /etc", metadata: {} }
    }
    return original(args, ctx)
  },
  priority: 100, // outermost — sees calls first
})
```

### How decorators are applied

1. Decorators are stored in `PluginRegistry.toolDecorators`
2. During `resolveTools()` in `prompt.ts`, after all tools are assembled:
   - For each tool, find matching decorators (by name, regex, or `"*"`)
   - Sort by priority (lower first = inner wrapper, higher = outer)
   - Wrap the `execute` function with each decorator in order
3. The outermost decorator (highest priority) sees the call first
4. Each decorator call creates a fresh `adapted` function per-invocation to avoid parallel-call race conditions

### Decorator Context

```ts
type ToolDecoratorContext = {
  sessionID: string
  agent: string
  tool: string
  callID?: string
}
```

---

## 21. Mesh Layer 7 — Gateway RPC

**File:** `src/plugin/rpc.ts` (91 lines)

Plugin-registered callable methods exposed via HTTP and inter-plugin calls. Methods are namespaced by plugin ID to prevent collisions.

### Registration

```ts
api.registerRpc({
  name: "analyze",
  description: "Analyze a code file",
  handler: async (params, ctx) => {
    const result = await analyzeFile(params.path)
    return { issues: result.issues, score: result.score }
  },
})
// Registered as "my-plugin.analyze"
```

### Calling from another plugin

```ts
const result = await api.callRpc("other-plugin.analyze", { path: "src/index.ts" })
```

### HTTP endpoint

```
POST /rpc/:method
Content-Type: application/json

{ "params": { "path": "src/index.ts" }, "sessionID": "optional-session-id" }
```

Response:

```json
{ "ok": true, "result": { "issues": [], "score": 95 } }
```

Or on error:

```json
{ "ok": false, "error": "unknown rpc method: foo.bar" }
```

### Listing methods

```
GET /rpc
```

Returns:

```json
[{ "name": "my-plugin.analyze", "pluginId": "my-plugin", "description": "Analyze a code file" }]
```

### Namespacing

- `api.registerRpc({ name: "analyze", ... })` → registered as `{pluginId}.analyze`
- Methods with dots in the name are treated as already-qualified
- The RPC dispatcher caches the method map and rebuilds when registrations change

---

## 22. Mesh Layer 8 — Stream Middleware

**File:** `src/plugin/stream.ts` (149 lines)

Async-generator transforms that wrap the LLM response stream. Transforms can filter, modify, inject, or observe stream events as they flow from the LLM to the processor.

### Registration

```ts
// Safety filter — replace unsafe content
api.registerStreamTransform({
  name: "safety-filter",
  async *transform(stream) {
    for await (const event of stream) {
      if (event.type === "text-delta" && containsUnsafe(event.text)) {
        yield { type: "text-delta", text: "[filtered]" }
      } else {
        yield event
      }
    }
  },
  priority: 100, // outer = sees events first
})

// Cost tracker — observe events without modifying
api.registerStreamTransform({
  name: "cost-tracker",
  async *transform(stream) {
    let tokens = 0
    for await (const event of stream) {
      if (event.type === "text-delta") tokens += event.text.length
      yield event
    }
    console.log(`Stream tokens: ~${tokens}`)
  },
  priority: 0,
})
```

### Stream Event Types

```ts
type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown }
  | { type: "tool-result"; toolName: string; result: unknown }
  | { type: "error"; error: unknown }
  | { type: "finish"; reason: string }
  | { type: "other"; event: unknown } // passthrough for unhandled AI SDK events
```

### How it works in production

The stream transform pipeline is wired in `processor.ts`:

1. Before the AI SDK stream is consumed, transforms are resolved from `registry.streamTransforms`
2. `composeTransforms(registrations)` produces a single `StreamTransformFn`
3. The AI SDK stream (`stream.fullStream`) is wrapped via `wrapStreamWithTransforms()`:
   - `toStreamEvents` maps AI SDK events → `StreamEvent` (text-delta, error, finish are mapped; everything else becomes `{ type: "other", event }` to preserve all AI SDK fields like `toolCallId`, `providerMetadata`, etc.)
   - The composed transform pipeline processes the `StreamEvent` stream
   - `fromStreamEvents` maps back to AI SDK format (text-delta, error, finish are re-mapped; `other` events are unwrapped back to their original shape)

### Error Boundary

Each transform is wrapped in a `safeIterate()` error boundary. If a transform throws during async iteration:

1. The error is logged
2. An `{ type: "error", error }` event is yielded to the downstream consumer
3. The wrapper falls back to draining any remaining events from the upstream source
4. Events that were already consumed by the failing transform before the throw are lost (inherent to async generator semantics)

This ensures a broken transform never takes down the entire LLM response stream.

### Transform Priority

Lower priority = inner (applied first). Higher priority = outer (applied last, sees events first). This matches the decorator convention.

---

## 23. Production Wiring

All 8 mesh layers are wired into production code across three files:

### `session/prompt.ts` — Pipeline (L5) + Tool Decorators (L6)

The normal processing path of `loop()` is extracted into 9 named built-in pipeline stages (`resolve-agent`, `create-message`, `resolve-tools`, `build-system`, `agent-start`, `pre-send`, `process`, `post-process`, `compaction-check`). Each loop iteration compiles these with any plugin-registered stages via `createPipeline()` and executes the result. Stages communicate through shared mutable state in `ctx.metadata`.

After all built-in and MCP tools are resolved in `resolveTools()` (inside the `resolve-tools` stage), decorator wiring iterates `registry.toolDecorators`. For each tool that matches, `applyDecorators()` wraps the tool's `execute` function. Each invocation builds a fresh `adapted` function with the actual `ToolCallOptions` to avoid parallel-call race conditions.

### `session/processor.ts` — Stream Transforms (L8)

Before the retry loop, the processor resolves stream transforms from `registry.streamTransforms`. If any are registered, `composeTransforms()` produces a single transform function, and `wrapStreamWithTransforms()` bridges AI SDK events to/from the plugin `StreamEvent` type.

### `server/server.ts` — Channels, Cron, RPC, Lifecycle

**Server start** (in order):

1. Fires `runner.runServerStart({ port })` hook
2. Starts plugin services via `startPluginServices()`
3. Starts channel adapters via `startChannels()` if any are registered
4. Starts cron scheduler via `startCronScheduler()` if any jobs exist

**Server stop** (in reverse order):

1. Stops cron scheduler (`await cron.stop()` — waits for in-flight jobs)
2. Stops channels (disconnects in LIFO order, abort signal deferred until after disconnect)
3. Stops plugin services
4. Fires `runner.runServerStop({ port })` hook

**RPC endpoints:**

- `POST /rpc/:method` — calls the registered RPC handler, returns `{ ok, result?, error? }`
- `GET /rpc` — lists all registered RPC methods

**Channel deliver bridge** — `channelDeliver(msg)`:

1. Resolves route via `resolveRoute(registry.routes, msg, defaultAgent)`
2. Creates or reuses a session per channel+source combination
3. Calls `SessionPrompt.prompt()` with the message content
4. Extracts text parts from the response and returns as `ChannelResponse`

**Plugin HTTP routes:**

- `ALL /plugins/*` — routes to plugin HTTP handlers (exact path match first, then generic handlers)

---

## 24. Integration Map

How all layers connect:

```
                                     ┌─────────────────┐
                                     │   Cron (L3)      │
                                     │  schedules jobs  │
                                     └────────┬────────┘
                                              │ triggers
                                              ▼
┌──────────────┐  inbound    ┌──────────────────────────────┐
│ Channels (L2)│────────────▶│       Router (L4)             │
│ Slack/Discord│  message    │  resolves agent + session     │
│ MQTT/Webhook │             └──────────────┬───────────────┘
└──────┬───────┘                            │
       │                                    ▼
       │                    ┌──────────────────────────────┐
       │                    │      Pipeline (L5)            │
       │                    │  validate → create-message    │
       │                    │  → resolve-agent              │
       │                    │  → resolve-tools              │
       │                    │    └── Decorators (L6)        │
       │                    │  → build-system               │
       │                    │  → agent-start                │
       │                    │  → pre-send                   │
       │                    │  → process                    │
       │                    │    └── Stream MW (L8)         │
       │                    │  → post-process               │
       │                    └──────────────┬───────────────┘
       │                                   │
       │                                   ▼ result
       │  outbound          ┌──────────────────────────────┐
       │◀───────────────────│   Channel.send()              │
       │  response          └──────────────────────────────┘
       │
       │     ┌──────────────────────────────────────────────┐
       └────▶│         Plugin Bus (L1)                       │
             │  publish("channel.slack.message-received")    │
             │  subscribe("my-plugin.data-ready")            │
             └──────────────────────────────────────────────┘
                              ▲         │
                              │         ▼
             ┌──────────────────────────────────────────────┐
             │         Gateway RPC (L7)                      │
             │  POST /rpc/my-plugin.analyze                  │
             │  api.callRpc("other-plugin.process", data)    │
             └──────────────────────────────────────────────┘
```

---

## 25. Examples

### Minimal Plugin

Create `.opencode/extensions/hello.ts`:

```ts
import type { PluginApi } from "opencode/src/plugin/registry"

export function register(api: PluginApi) {
  api.on("session.created", (event) => {
    api.logger.info(`New session: ${event.sessionID}`)
  })
}
```

### Full-Featured Plugin (Phase 1 + Mesh)

Create `.opencode/extensions/my-plugin/index.ts`:

```ts
import type { PluginApi } from "opencode/src/plugin/registry"

export const id = "my-plugin"
export const name = "My Plugin"
export const description = "Demonstrates plugin + mesh features"
export const version = "1.0.0"

export function register(api: PluginApi) {
  // ── Lifecycle hooks ───────────────────────────────────────────────────

  api.on("agent.start", (event) => {
    return {
      prependContext: "My plugin is active. Use /status for plugin info.",
    }
  })

  api.on("tool.block", (event) => {
    if (event.tool === "bash" && String(event.args.command).includes("rm -rf /")) {
      return { block: true, reason: "Blocked: dangerous command" }
    }
  })

  // ── Chat command ──────────────────────────────────────────────────────

  api.registerChatCommand({
    name: "status",
    description: "Show plugin status",
    handler: async () => ({ text: `Plugin ${api.name} v${api.version} is running.` }),
  })

  // ── HTTP route ────────────────────────────────────────────────────────

  api.registerHttpRoute({
    path: "/metrics",
    handler: async () =>
      new Response(JSON.stringify({ requests: 42 }), {
        headers: { "Content-Type": "application/json" },
      }),
  })

  // ── Background service ────────────────────────────────────────────────

  api.registerService({
    id: "sync",
    async start(ctx) {
      const interval = setInterval(() => {
        if (ctx.abort.aborted) return
        api.logger.info("Syncing...")
      }, 30_000)
      ctx.abort.addEventListener("abort", () => clearInterval(interval))
    },
    async stop() {
      api.logger.info("Sync service stopped")
    },
  })

  // ── Mesh: Plugin Bus (L1) ────────────────────────────────────────────

  api.subscribe("data-ready", (payload) => {
    api.logger.info(`Data ready: ${JSON.stringify(payload)}`)
  })

  // ── Mesh: Channel (L2) ───────────────────────────────────────────────

  api.registerChannel({
    id: "webhook",
    name: "Webhook",
    async connect(ctx) {
      // Set up webhook listener, call ctx.deliver(msg) on inbound
    },
  })

  // ── Mesh: Cron (L3) ──────────────────────────────────────────────────

  api.registerCron({
    id: "health-check",
    schedule: { kind: "interval", ms: 300_000 },
    action: {
      type: "custom",
      handler: async (ctx) => {
        api.publish("health", { ok: true, time: Date.now() }, { retain: true })
      },
    },
  })

  // ── Mesh: Agent Routing (L4) ─────────────────────────────────────────

  api.registerRoute({
    id: "deploy-requests",
    match: { type: "pattern", pattern: /deploy|ship|release/i },
    agent: "devops",
    priority: 5,
  })

  // ── Mesh: Pipeline Stage (L5) ────────────────────────────────────────

  api.registerStage(
    {
      name: "request-logger",
      handler: async (ctx, next) => {
        api.logger.info(`Processing session ${ctx.sessionID}`)
        await next()
      },
    },
    { type: "before", target: "process" },
  )

  // ── Mesh: Tool Decorator (L6) ────────────────────────────────────────

  api.decorateTool({
    tool: "bash",
    decorator: (original, info) => async (args, ctx) => {
      api.logger.info(`[audit] ${ctx.agent} running bash: ${JSON.stringify(args).slice(0, 100)}`)
      return original(args, ctx)
    },
  })

  // ── Mesh: RPC (L7) ───────────────────────────────────────────────────

  api.registerRpc({
    name: "get-status",
    description: "Get plugin status",
    handler: async () => ({ status: "ok", version: api.version }),
  })

  // ── Mesh: Stream Transform (L8) ──────────────────────────────────────

  api.registerStreamTransform({
    name: "token-counter",
    async *transform(stream) {
      let tokens = 0
      for await (const event of stream) {
        if (event.type === "text-delta") tokens += event.text.length
        yield event
      }
      api.logger.info(`Stream ~${tokens} chars`)
    },
  })
}
```

### Plugin with Config

`opencode.json`:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "config": {
          "apiKey": "sk-abc123",
          "environment": "staging"
        }
      }
    }
  }
}
```

In the plugin:

```ts
export function register(api: PluginApi) {
  const key = api.pluginConfig?.apiKey as string
  const env = api.pluginConfig?.environment as string
  api.logger.info(`Connecting to ${env} with key ${key.slice(0, 6)}...`)
}
```

### Memory Plugin (Exclusive Slot)

Only one memory plugin can be active. First-loaded wins unless configured:

```ts
export const kind = "memory"

export function register(api: PluginApi) {
  api.on("agent.start", (event) => {
    return { prependContext: "Relevant memories: ..." }
  })
}
```

To force a specific memory plugin when multiple exist:

```json
{ "plugins": { "slots": { "memory": "my-preferred-memory-plugin" } } }
```

---

## 26. File Inventory

### Core Plugin Files

| File                       | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `src/plugin/index.ts`      | Plugin loader (legacy + new-style)                     |
| `src/plugin/registry.ts`   | Central registry, PluginApi factory, all registrations |
| `src/plugin/hooks.ts`      | Hook runner (void + modifying modes)                   |
| `src/plugin/discovery.ts`  | 4-tier plugin discovery                                |
| `src/plugin/validation.ts` | JSON Schema config validation                          |
| `src/plugin/slots.ts`      | Exclusive slot resolution                              |
| `src/plugin/services.ts`   | Background service lifecycle                           |

### Mesh Layer Files

| File                      | Layer | Purpose                                        |
| ------------------------- | ----- | ---------------------------------------------- |
| `src/plugin/bus.ts`       | L1    | Plugin message bus (pub/sub)                   |
| `src/plugin/channel.ts`   | L2    | Channel adapters (external I/O)                |
| `src/plugin/cron.ts`      | L3    | Cron scheduler (interval/cron/once)            |
| `src/plugin/router.ts`    | L4    | Agent routing (message → agent dispatch)       |
| `src/plugin/pipeline.ts`  | L5    | Pipeline stages (Koa-style middleware)         |
| `src/plugin/decorator.ts` | L6    | Tool decorators (execute wrapping)             |
| `src/plugin/rpc.ts`       | L7    | Gateway RPC (callable methods)                 |
| `src/plugin/stream.ts`    | L8    | Stream middleware (async-generator transforms) |

### Production Integration Files

| File                       | Mesh Wiring                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `src/session/prompt.ts`    | Pipeline execution (L5), tool decorator application (L6)       |
| `src/session/processor.ts` | Stream transform bridging (L8)                                 |
| `src/server/server.ts`     | RPC endpoints (L7), channel deliver (L2), cron (L3), lifecycle |

### Test Files (257 tests, 0 failures)

| File                               | Tests | Coverage                                                                  |
| ---------------------------------- | ----- | ------------------------------------------------------------------------- |
| `test/plugin/bus.test.ts`          | 19    | Pub/sub, namespacing, retained, clear, wildcards                          |
| `test/plugin/channel.test.ts`      | 21    | Lifecycle, session mapping, health, double-stop, abort signal             |
| `test/plugin/cron.test.ts`         | 30    | All schedule types, error handling, backoff, timezone, async stop, resume |
| `test/plugin/router.test.ts`       | 15    | All match types, priority, invalid regex                                  |
| `test/plugin/pipeline.test.ts`     | 17    | Compose, assemble, short-circuit                                          |
| `test/plugin/decorator.test.ts`    | 11    | Priority, regex, wildcard                                                 |
| `test/plugin/rpc.test.ts`          | 10    | Dispatch, namespacing, errors                                             |
| `test/plugin/stream.test.ts`       | 12    | Compose, passthrough, filter, error boundary                              |
| `test/plugin/hooks.test.ts`        | 17    | Void, modifying, priority, timeout, allSettled                            |
| `test/plugin/registry.test.ts`     | 14    | Tools, hooks, services, diagnostics, duplicates                           |
| `test/plugin/discovery.test.ts`    | 8     | 4-tier discovery                                                          |
| `test/plugin/chat-command.test.ts` | 20    | Reserved names, aliases, auth                                             |
| `test/plugin/services.test.ts`     | 5     | Start/stop lifecycle                                                      |
| + others                           |       | validation, slots, http                                                   |

### Architecture Diagram

```
opencode.json                        .opencode/extensions/
┌──────────────┐                    ┌─────────────────────┐
│ plugins:     │                    │ hello.ts             │
│   load:      │                    │ my-plugin/index.ts   │
│     paths:[] │                    │ memory-plugin.ts     │
│   slots:     │                    └─────────┬───────────┘
│     memory:  │                              │
│   entries:   │                              │
│     {id}:    │                              │
│       config │                              │
└──────┬───────┘                              │
       │                                      │
       └──────────┐                ┌──────────┘
                  ▼                ▼
            ┌─────────────────────────────┐
            │     Discovery (4-tier)       │
            │  config → workspace → global │
            └──────────────┬──────────────┘
                           │
                    PluginCandidate[]
                           │
                           ▼
            ┌─────────────────────────────┐
            │     Loading Pipeline         │
            │  dedup → enabled? → import  │
            │  → resolve → slot → validate│
            │  → createApi → register()   │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌─────────────────────────────────────────────┐
            │              PluginRegistry                  │
            │  ┌──────────────┐ ┌───────────────────────┐ │
            │  │ plugins      │ │ typedHooks            │ │
            │  ├──────────────┤ ├───────────────────────┤ │
            │  │ tools        │ │ chatCommands          │ │
            │  ├──────────────┤ ├───────────────────────┤ │
            │  │ toolFactories│ │ services              │ │
            │  ├──────────────┤ ├───────────────────────┤ │
            │  │ httpRoutes   │ │ diagnostics           │ │
            │  ├──────────────┤ ├───────────────────────┤ │
            │  │ httpHandlers │ │ toolDecorators  (L6)  │ │
            │  ├──────────────┤ ├───────────────────────┤ │
            │  │ channels (L2)│ │ streamTransforms (L8) │ │
            │  ├──────────────┤ ├───────────────────────┤ │
            │  │ cronJobs (L3)│ │ rpcMethods (L7)       │ │
            │  ├──────────────┤ ├───────────────────────┤ │
            │  │ routes  (L4) │ │ pipelineStages (L5)   │ │
            │  ├──────────────┤ └───────────────────────┘ │
            │  │ pluginBus(L1)│                           │
            │  └──────────────┘                           │
            └──────────────────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
         HookRunner           ChatCommand          server.ts
         (15 hooks)           (/ commands)    (HTTP + services +
                                              channels + cron + RPC)
```
