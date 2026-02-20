# OpenCode Mesh Architecture — Implementation Reference

## Status: COMPLETE

All 8 layers implemented. **257 tests across 19 plugin test files, 0 failures. Clean typecheck.**

9 rounds of QA/Architect review completed. All HIGH, MEDIUM, and LOW findings resolved.

For the full combined documentation (plugin system + mesh), see [PLUGIN_ARCHITECTURE.md](./PLUGIN_ARCHITECTURE.md).

---

## Vision

Transform OpenCode from a single-channel coding assistant into a **universal agent mesh** — a platform where plugins can wire together channels, agents, tools, schedulers, and pipelines into arbitrary topologies. The TUI becomes just one channel among many. The hardcoded prompt flow becomes a composable pipeline. Plugins become first-class citizens that can talk to each other, route messages, schedule work, and transform every stage of execution.

---

## Table of Contents

1. [Principles](#principles)
2. [Layer 1 — Plugin Message Bus](#layer-1--plugin-message-bus)
3. [Layer 2 — Channel Adapters](#layer-2--channel-adapters)
4. [Layer 3 — Cron / Scheduler](#layer-3--cron--scheduler)
5. [Layer 4 — Agent Routing](#layer-4--agent-routing)
6. [Layer 5 — Pipeline Stages](#layer-5--pipeline-stages)
7. [Layer 6 — Tool Decorators](#layer-6--tool-decorators)
8. [Layer 7 — Gateway RPC](#layer-7--gateway-rpc)
9. [Layer 8 — Stream Middleware](#layer-8--stream-middleware)
10. [Integration Map](#integration-map)
11. [File Inventory](#file-inventory)
12. [Known Limitations & Accepted Issues](#known-limitations--accepted-issues)

---

## Principles

1. **Backward compatible** — Every new capability is additive. Existing plugins, hooks, and the TUI continue working unchanged.
2. **Plugin-first** — All new features are registered via the `PluginApi`. No new hardcoded behavior.
3. **Typed** — Zod schemas for all events, configs, and RPC payloads. TypeScript types inferred, not declared.
4. **Mesh, not tree** — Any component can talk to any other. Channels publish to the bus, the router reads from the bus, agents publish back, cron jobs trigger agents, tools call RPC methods.
5. **No external dependencies for core** — Core infrastructure uses Bun-native APIs. Channel implementations (Slack, Discord) are separate plugins that bring their own deps.
6. **Fail open** — Plugin errors are caught and logged. A broken channel plugin doesn't crash the server. A slow stream middleware doesn't block the pipeline.

---

## Layer 1 — Plugin Message Bus

**File:** `src/plugin/bus.ts` (134 lines) | **Tests:** `test/plugin/bus.test.ts` (19 tests)

Namespaced pub/sub for inter-plugin communication. Separate from the system `Bus` (in `src/bus/`) which drives SSE events for the TUI.

### Actual Types

```ts
type PluginBusSubscription = {
  pluginId: string
  topic: string
  handler: (payload: unknown) => void | Promise<void>
}

type PluginBusPublishOptions = {
  retain?: boolean
}
```

### PluginApi

```ts
publish(topic: string, payload: unknown, opts?: PluginBusPublishOptions): Promise<void>
subscribe(topic: string, handler: (payload: unknown) => void | Promise<void>): () => void
```

### Topic Resolution

- Short names auto-prefixed: `publish("foo", ...)` → `{pluginId}.foo`
- Qualified names pass through: `subscribe("other.foo", handler)` → `other.foo`
- Wildcard: `subscribe("*", handler)` → receives all topics

### Implementation Details

- `Map<string, PluginBusSubscription[]>` for topic subscriptions
- `Map<string, unknown>` for retained messages
- Separate `wildcards: PluginBusSubscription[]` array
- Delivery via `Promise.allSettled()` — handler errors never break other subscribers
- `subscribe()` returns `{ unsubscribe, ready }` — `ready` resolves after retained delivery
- `clear(pluginId)` removes all subscriptions AND purges retained messages owned by that plugin
- `topics()` lists active topics, `subscriberCount(topic?)` for introspection (per-topic count includes wildcard subscribers)

---

## Layer 2 — Channel Adapters

**File:** `src/plugin/channel.ts` (230 lines) | **Tests:** `test/plugin/channel.test.ts` (21 tests)

Abstraction for external communication endpoints (Slack, Discord, MQTT, webhooks).

### Actual Types

```ts
type ChannelMessage = {
  channel: string
  source: ChannelSource
  content: string
  threadID?: string
  attachments?: ChannelAttachment[]
  metadata?: Record<string, unknown>
  raw?: unknown
}

type ChannelSource = {
  id: string
  name?: string
  group?: string
}

type ChannelResponse = {
  content: string
  attachments?: ChannelAttachment[]
  metadata?: Record<string, unknown>
  replyTo?: string
}

type ChannelAdapter = {
  id: string
  name: string
  capabilities?: ChannelCapabilities
  setup?: (ctx: ChannelContext) => Promise<void>
  connect: (ctx: ChannelContext) => Promise<void>
  disconnect?: (ctx: ChannelContext) => Promise<void>
  send?: (response: ChannelResponse, ctx: ChannelContext) => Promise<void>
  health?: (ctx: ChannelContext) => Promise<{ ok: boolean; error?: string }>
}

type ChannelContext = {
  config: unknown
  pluginConfig?: Record<string, unknown>
  logger: PluginLogger
  abort: AbortSignal
  deliver: (msg: ChannelMessage) => Promise<ChannelResponse>
}
```

> **Note vs plan:** `ChannelSetupContext` (with `registerWebhook`) was removed. Both `setup()` and `connect()` receive the same `ChannelContext`. `send` is optional (not all adapters need outbound).

### Session Mapping

```ts
function sessionKey(msg, scope): string
// scope: "source" → "channel:{channel}:{sourceId}"
// scope: "group"  → "channel:{channel}:{group}:{threadID?}"
// scope: "global" → "channel:{channel}:global"
```

### Lifecycle

- `startChannels()` calls `setup()` then `connect()` per adapter (60s timeout each)
- `stop()` has a double-stop guard (`stopped` flag), awaits `ready`, calls `disconnect()` in LIFO order (30s timeout) BEFORE aborting the signal (so disconnect handlers see a non-aborted signal), then aborts
- `health(channelId)` awaits `ready`, then calls adapter's `health()` if present

---

## Layer 3 — Cron / Scheduler

**File:** `src/plugin/cron.ts` (369 lines) | **Tests:** `test/plugin/cron.test.ts` (30 tests)

Scheduled tasks with interval, cron expression, or one-shot timers.

### Actual Types

```ts
type CronSchedule =
  | { kind: "interval"; ms: number }
  | { kind: "cron"; expression: string; tz?: string }
  | { kind: "once"; at: Date | string | number }

type CronAction =
  | { type: "publish"; topic: string; payload: unknown }
  | { type: "custom"; handler: (ctx: CronJobContext) => Promise<void> }

type CronJobDefinition = {
  id: string
  schedule: CronSchedule
  action: CronAction
  enabled?: boolean
  maxRetries?: number
  backoffMs?: number // delay multiplier after non-fatal errors (default 5000ms)
}

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

> **Note vs plan:** The plan included `CronAction` types `"prompt"` and `"rpc"` — these were not implemented. Only `"publish"` and `"custom"` exist. The `CronDelivery` type was removed as dead code. `CronJobState.pluginId` was added. `"completed"` status was added for once-jobs.

### Cron Expression Parser

Built-in 5-field parser (minute hour dom month dow). Exported functions:

- `parseCronExpression(expr)` — parses into 5 `CronField` objects
- `cronMatches(expr, date, tz?)` — checks if a date matches an expression, with optional timezone support via `toLocaleString("en-US", { timeZone: tz })`

Supports wildcards (`*`), lists (`1,3,5`), ranges (`1-5`), steps (`*/5`, `1-30/2`). Invalid fields throw (not silently fallback to wildcard).

### Deduplication

Cron jobs with `kind: "cron"` are polled every 60 seconds. A `lastFiredMinute` field prevents the same job from firing twice in the same calendar minute.

### Error Handling & Backoff

- `maxRetries` defaults to 3. After N consecutive failures, status → `"error"`, timer is cleared
- `backoffMs` defaults to 5000ms. After a non-fatal error, `backoffUntil = Date.now() + backoffMs * errorCount`. Runs are skipped while `backoffUntil > Date.now()`. On success, backoff resets to 0
- Once-jobs: status → `"completed"` after execution (unless errored)
- `pause(jobId)` — only from `"active"`. `resume(jobId)` — from `"paused"` or `"error"`, resets `errorCount` and `backoffUntil`, re-creates the timer
- Once-jobs in `"error"` state cannot be resumed (the one-shot timer has already fired)

### Async Stop

`CronHandle.stop()` is async. It aborts the controller, clears all timers, then `await Promise.allSettled([...inFlight])` to wait for any in-flight `run()` calls to complete. In-flight promises are tracked via a `Set<Promise<void>>`.

---

## Layer 4 — Agent Routing

**File:** `src/plugin/router.ts` (135 lines) | **Tests:** `test/plugin/router.test.ts` (15 tests)

Priority-based message-to-agent dispatch.

### Actual Types

```ts
type RouteMatch =
  | { type: "source"; channel: string; sourceId: string }
  | { type: "group"; channel: string; groupId: string }
  | { type: "pattern"; pattern: string | RegExp }
  | { type: "channel"; channel: string }
  | { type: "default" }

type RouteDefinition = {
  id: string
  match: RouteMatch
  agent: string
  priority?: number
  sessionScope?: "source" | "group" | "global"
  metadata?: Record<string, unknown>
}

type ResolvedRoute = {
  agent: string
  sessionKey: string
  matchedBy: string
  routeId: string
  metadata?: Record<string, unknown>
}
```

### Resolution

`resolveRoute(routes, msg, defaultAgent)` sorts routes by priority (desc), iterates until first match, returns `ResolvedRoute`. If nothing matches, returns system default with `matchedBy: "system-default"`.

A warning is logged if a `"default"` route has `priority > 0`, since it will shadow all lower-priority routes.

> **Note:** Pattern routes use `new RegExp()` on string patterns — malformed patterns are caught and the route is skipped gracefully (the next route is tried).

---

## Layer 5 — Pipeline Stages

**File:** `src/plugin/pipeline.ts` (177 lines) | **Tests:** `test/plugin/pipeline.test.ts` (17 tests)

Koa-style composable middleware chain.

### Actual Types

```ts
type PipelineContext = {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  channel?: string
  abort: AbortSignal
  metadata: Record<string, unknown>
  signal?: "stop" | "compact" | "continue"
}

type PipelineHandler = (ctx: PipelineContext, next: PipelineNext) => Promise<void>
type PipelineNext = () => Promise<void>
type CompiledPipeline = (ctx: PipelineContext, finalNext?: PipelineNext) => Promise<void>

type PipelineStage = { name: string; handler: PipelineHandler }
type PipelinePosition = { type: "before" | "after" | "replace"; target: string }
```

> **Note vs plan:** `PipelineContext` was simplified from the original plan. The plan had `input`, `session`, `agent`, `model`, `messages`, `system`, `tools`, `result` — the implementation uses a minimal context with well-defined fields. The `[key: string]: unknown` index signature was removed for type safety; extensible data goes in `metadata`. The `signal` field controls loop behavior in `prompt.ts`.

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

### Composition

1. `assemble(builtins, registrations)` — applies replacements first (last wins), then befores, then afters
2. `compile(stages)` — produces Koa-style composed function. Double-calling `next()` throws.
3. `createPipeline(builtins, registrations)` — convenience: assemble + compile

---

## Layer 6 — Tool Decorators

**File:** `src/plugin/decorator.ts` (96 lines) | **Tests:** `test/plugin/decorator.test.ts` (11 tests)

Wrap tool `execute` functions with cross-cutting concerns.

### Actual Types

```ts
type ToolDecorator = {
  tool: string | RegExp | "*"
  decorator: (original: ToolExecuteFn, info: ToolDecoratorInfo) => ToolExecuteFn
  priority?: number
}

type ToolExecuteFn = (args: Record<string, unknown>, ctx: ToolDecoratorContext) => Promise<ToolResult>

type ToolDecoratorContext = {
  sessionID: string
  agent: string
  tool: string
  callID?: string
}

type ToolResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: unknown[]
}
```

### Application

`applyDecorators(decorators, tool, description, execute)`:

1. Filter matching decorators (exact string, regex, or `"*"`)
2. Sort by priority (lower first = inner wrapper)
3. Wrap `execute` sequentially — outermost (highest priority) sees calls first

### Production Wiring

In `prompt.ts`, after all tools are assembled, decorator wiring creates a fresh `adapted` function per-invocation to avoid parallel-call race conditions with shared `ToolCallOptions`.

---

## Layer 7 — Gateway RPC

**File:** `src/plugin/rpc.ts` (91 lines) | **Tests:** `test/plugin/rpc.test.ts` (10 tests)

Plugin-registered callable methods.

### Actual Types

```ts
type RpcMethod = {
  name: string
  handler: (params: unknown, ctx: RpcContext) => Promise<unknown>
  description?: string
}

type RpcContext = {
  callerId?: string
  sessionID?: string
  config: unknown
}

type RpcCallResult = { ok: true; result: unknown } | { ok: false; error: string }
```

> **Note vs plan:** Zod `schema` validation on params/result was not implemented. The plan had `schema?: { params?: z.ZodType; result?: z.ZodType }` — this is left to individual plugin handlers.

### Dispatcher

`createRpcDispatcher(registrations)` returns `{ call, list, has }`:

- `call(method, params, ctx)` — returns `RpcCallResult`
- `list()` — returns `[{ name, pluginId, description? }]`
- `has(method)` — boolean check

### Namespacing

`qualifyRpcMethod(pluginId, name)`: names without dots get prefixed with `{pluginId}.`. Names with dots pass through.

### HTTP Endpoints

- `POST /rpc/:method` — `{ params, sessionID? }` → `{ ok, result?, error? }`
- `GET /rpc` — lists all methods

### Inter-Plugin Calls

`api.callRpc("other-plugin.method", params)` returns `Promise<unknown>` — callers must narrow the result type. Dispatcher caches are rebuilt when registrations change (using a generation counter, not array length).

---

## Layer 8 — Stream Middleware

**File:** `src/plugin/stream.ts` (149 lines) | **Tests:** `test/plugin/stream.test.ts` (12 tests)

Async-generator transforms on the LLM response stream.

### Actual Types

```ts
type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown }
  | { type: "tool-result"; toolName: string; result: unknown }
  | { type: "error"; error: unknown }
  | { type: "finish"; reason: string }
  | { type: "other"; event: unknown }

type StreamTransformFn = (stream: AsyncIterable<StreamEvent>) => AsyncIterable<StreamEvent>

type StreamTransform = {
  name: string
  transform: StreamTransformFn
  priority?: number
}
```

### Composition

`composeTransforms(registrations)`: sorts by priority (lower first = inner), applies transforms sequentially. Each transform is wrapped in a `safeIterate()` error boundary — if a transform throws during async iteration, an `{ type: "error" }` event is emitted and the wrapper falls back to draining the upstream. Returns `undefined` if no transforms registered.

### Production Wiring (processor.ts)

`wrapStreamWithTransforms(fullStream, transform)`:

- `toStreamEvents` maps AI SDK events → `StreamEvent`. Only `text-delta`, `error`, `finish` are explicitly mapped; everything else becomes `{ type: "other", event }` to preserve all AI SDK fields (`toolCallId`, `providerMetadata`, etc.)
- `fromStreamEvents` maps back: `text-delta` → `text-delta`, `error` → `error`, `finish` → `finish` (with `reason` ↔ `finishReason` rename), `other` → unwrapped original event

### Utility Functions

- `passthrough(stream)` — identity transform (for testing)
- `fromArray(events)` — converts array to async iterable (for testing)
- `collect(stream)` — collects async iterable to array (for testing)

---

## Integration Map

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

### Server Lifecycle

**Start order:**

1. `runner.runServerStart({ port })` hook
2. `startPluginServices({ registry, config })`
3. `startChannels({ channels, config, deliver })` (if any)
4. `startCronScheduler({ jobs, config, publish })` (if any)

**Stop order:**

1. Stop cron scheduler
2. Stop channels (LIFO disconnect)
3. Stop plugin services
4. `runner.runServerStop({ port })` hook

---

## File Inventory

### New Files (16)

| File                            | Layer | Lines |
| ------------------------------- | ----- | ----- |
| `src/plugin/bus.ts`             | L1    | 134   |
| `test/plugin/bus.test.ts`       | L1    | 225   |
| `src/plugin/channel.ts`         | L2    | 230   |
| `test/plugin/channel.test.ts`   | L2    | 348   |
| `src/plugin/cron.ts`            | L3    | 369   |
| `test/plugin/cron.test.ts`      | L3    | 490   |
| `src/plugin/router.ts`          | L4    | 135   |
| `test/plugin/router.test.ts`    | L4    | 156   |
| `src/plugin/pipeline.ts`        | L5    | 177   |
| `test/plugin/pipeline.test.ts`  | L5    | 296   |
| `src/plugin/decorator.ts`       | L6    | 96    |
| `test/plugin/decorator.test.ts` | L6    | ~     |
| `src/plugin/rpc.ts`             | L7    | 91    |
| `test/plugin/rpc.test.ts`       | L7    | ~     |
| `src/plugin/stream.ts`          | L8    | 149   |
| `test/plugin/stream.test.ts`    | L8    | 226   |

### Modified Files

| File                       | Layers                                              |
| -------------------------- | --------------------------------------------------- |
| `src/plugin/registry.ts`   | L1-L8 (all layers add to registry + API)            |
| `src/session/prompt.ts`    | L5, L6 (pipeline execution + decorator application) |
| `src/session/processor.ts` | L8 (stream transform bridging)                      |
| `src/server/server.ts`     | L2, L3, L7 (channels, cron, RPC endpoints)          |

---

## Known Limitations & Accepted Issues

These are known limitations that are accepted for the current implementation:

| Issue                                                                                                     | Layer | Rationale                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Router default-route warning fires on every `resolveRoute()` call                                         | L4    | Could be noisy in production; moving to registration time would require structural changes to the stateless function |
| Pipeline: multiple `after` inserts at same target produce reverse order                                   | L5    | Known insertion behavior                                                                                             |
| RPC `qualifyRpcMethod` allows cross-namespace via dots                                                    | L7    | By design — qualified names pass through                                                                             |
| `channelSessions` map grows unbounded                                                                     | L2    | MVP acceptable — no session GC yet                                                                                   |
| `channelDeliver` hardcodes `process.cwd()` for workspace                                                  | L2    | MVP acceptable                                                                                                       |
| `CronAction` types `"prompt"` and `"rpc"` from plan not implemented                                       | L3    | Use `"custom"` handlers instead                                                                                      |
| RPC Zod schema validation from plan not implemented                                                       | L7    | Plugins validate in their handlers                                                                                   |
| Stream `fromStreamEvents` default case passes through unknown types                                       | L8    | Latent — only triggers if transforms inject tool-call/tool-result types                                              |
| Cron timezone day-of-week uses `new Date(localeString).getDay()`                                          | L3    | Works correctly but somewhat fragile across JS engines' date parsing                                                 |
| Stream `safeIterate` upstream fallback: events consumed by the failing transform before it threw are lost | L8    | Inherent to async generator semantics — correct behavior                                                             |

### Resolved Issues (from previous QA rounds)

The following issues from earlier versions were resolved:

- `bus.clear()` now purges retained messages owned by the cleared plugin (L1)
- `subscriberCount(topic)` now includes wildcard subscribers in per-topic counts (L1)
- Cron 60s polling double-fire prevented by `lastFiredMinute` deduplication (L3)
- Cron `tz` field is now functional via `dateComponents()` timezone extraction (L3)
- Cron `backoffMs` is now fully implemented with `backoffUntil` timestamp (L3)
- Cron `stop()` is now async and waits for in-flight `run()` calls (L3)
- Cron `resume()` now resets `backoffUntil` in addition to `errorCount` (L3)
- Router catches malformed RegExp patterns gracefully instead of throwing (L4)
- `PipelineContext` index signature `[key: string]: unknown` removed for type safety (L5)
- `registerService` with empty ID now pushes an error diagnostic (Services)
- Channel `stop()` has a double-stop guard (`stopped` flag) (L2)
- Channel disconnect handlers now see a non-aborted signal during teardown (L2)
- Cron `clearInterval`/`clearTimeout` now uses correct function per timer kind (L3)
- RPC dispatcher cache uses a generation counter instead of array length (L7)
- `callRpc` return type changed from `Promise<TResult>` to `Promise<unknown>` (L7)
- Stream transforms wrapped in `safeIterate()` error boundary (L8)
- Hooks `runVoidHook` uses `Promise.allSettled` so all handlers run even when one throws (Hooks)
- Duplicate tool registration now pushes a warning diagnostic (Registry)

---

## Status Checklist

- [x] Architecture documented
- [x] Layer 1 — Plugin Message Bus (19 tests)
- [x] Layer 2 — Channel Adapters (21 tests)
- [x] Layer 3 — Cron / Scheduler (30 tests)
- [x] Layer 4 — Agent Routing (15 tests)
- [x] Layer 5 — Pipeline Stages (17 tests)
- [x] Layer 6 — Tool Decorators (11 tests)
- [x] Layer 7 — Gateway RPC (10 tests)
- [x] Layer 8 — Stream Middleware (12 tests)
- [x] Production wiring — prompt.ts (L5, L6), processor.ts (L8), server.ts (L2, L3, L7)
- [x] 9 rounds of QA/Architect review completed
- [x] All HIGH, MEDIUM, and LOW findings resolved (17 MEDIUM+LOW fixes + 2 final fixes)

**Total: 257 tests across 19 plugin test files, 0 failures. Clean typecheck.**
