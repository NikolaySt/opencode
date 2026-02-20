# Feature Request: Plugin Mesh Architecture

## Problem

OpenCode's current plugin system supports basic lifecycle hooks (`@opencode-ai/plugin`) and a simple `Plugin.trigger()` API, but plugins cannot:

- Communicate with each other (no inter-plugin messaging)
- Run scheduled/periodic tasks (no cron or intervals)
- Transform LLM response streams (no middleware for streaming)
- Wrap or decorate existing tools (no tool interception beyond `tool.block`)
- Expose HTTP endpoints or RPC methods
- Register chat commands that bypass the LLM
- Route messages to different agents programmatically
- Run background services with lifecycle management
- Connect external platforms (Slack, Discord, webhooks)

This limits plugins to passive observers. Building integrations like "security policy enforcement," "audit logging," "scheduled health checks," or "cross-plugin orchestration" is not possible.

## Proposed Solution

A layered mesh architecture that extends the existing plugin system with 8 infrastructure layers. The design is:

- **Plugin-first**: all features accessed through a single `PluginApi` interface passed to `register(api)`
- **Backward compatible**: existing `Plugin.trigger()` and `@opencode-ai/plugin` hooks continue to work unchanged
- **Typed**: all inputs/outputs validated with Zod schemas, all hooks fully typed
- **Mesh, not tree**: plugins communicate peer-to-peer via bus/RPC, no hierarchy
- **Fail-open**: plugin errors are caught and logged, never crash the host
- **Zero external deps** for core infrastructure

## Architecture

### 8 Infrastructure Layers

**L1 — Plugin Bus** (`src/plugin/bus.ts`)
Typed pub/sub messaging. Plugins publish to namespaced topics (`pluginId.topic`), others subscribe by exact match or wildcard (`*`). Supports retained messages (last value cached for late subscribers).

**L2 — Channel Adapters** (`src/plugin/channel.ts`)
Abstraction for external communication endpoints. A channel plugin registers a `connect`/`disconnect` lifecycle, receives inbound messages via webhooks or long-polling, and delivers them to the agent system. Includes session mapping (per-source, per-group, or global).

**L3 — Cron Scheduler** (`src/plugin/cron.ts`)
Periodic task execution with two schedule types: interval (ms) and cron expressions (standard 5-field). Features: pause/resume per job, exponential backoff on failure (up to 5 min), overlap prevention, configurable max errors before auto-pause. Actions can be custom handlers or bus publish.

**L4 — Agent Router** (`src/plugin/router.ts`)
Programmable message routing. Plugins register routes with pattern matching (regex on message content) or channel binding. Routes are evaluated by priority; highest-priority match determines which agent handles the message. Used by L2 channels to dispatch inbound messages.

**L5 — Pipeline** (`src/plugin/pipeline.ts`)
Composable middleware stages around the LLM processing loop. Plugins insert stages `before` or `after` named anchor stages (e.g., `process`). Each stage gets a `next()` function for wrapping. Used for request logging, timing, pre/post-processing.

**L6 — Tool Decorators** (`src/plugin/decorator.ts`)
Wrap any tool's `execute` function. Supports specific tool names or wildcard `*` for all tools. Multiple decorators chain by priority (higher priority = outer wrapper). Use cases: audit logging, timing, argument transformation, result modification.

**L7 — Gateway RPC** (`src/plugin/rpc.ts`)
Cross-plugin callable methods. Each plugin registers named methods; other plugins call them via `api.callRpc("pluginId.method", params)`. Methods are also exposed as HTTP endpoints at `/rpc/{pluginId}.{method}` for external access.

**L8 — Stream Transforms** (`src/plugin/stream.ts`)
Async generator middleware for LLM response streams. Plugins register transforms that receive the event stream, can observe/modify/filter events, and yield them downstream. Multiple transforms compose by priority (higher = outer). Used for token counting, content filtering, logging.

### Core Plugin Features

- **15 typed hooks**: `session.created`, `session.archived`, `agent.start`, `agent.finish`, `message.received`, `message.sending`, `message.sent`, `tool.block`, `tool.before`, `tool.after`, `tool.result.persist`, `compaction.before`, `compaction.after`, `server.start`, `server.stop`
- **Chat commands**: Plugins register `/commands` that bypass the LLM entirely. Commands appear in TUI autocomplete. Results display inline in chat.
- **Tool factories**: Context-aware tool creation (agent-specific tools)
- **Background services**: Long-running tasks with `AbortSignal`-based lifecycle
- **HTTP routes**: Plugin-scoped endpoints at `/plugins/{pluginId}/{path}`
- **Exclusive slots**: Only one plugin per slot (e.g., memory provider)
- **Per-plugin config**: Declared in `opencode.jsonc` under `plugins.entries.{id}.config`, passed to plugin via `api.pluginConfig`
- **4-tier discovery**: Plugins discovered from workspace `.opencode/extensions/`, config directory `.opencode/plugins/`, global `~/.config/opencode/extensions/`, and explicit `plugins.load.paths`

### Production Wiring

- `src/session/prompt.ts` — Pipeline execution (L5), decorator application (L6), chat command interception, hook execution for agent/message/tool lifecycle
- `src/session/processor.ts` — Stream transform bridging (L8) into the AI SDK response stream
- `src/server/server.ts` — Server lifecycle (services, channels, cron start/stop), RPC HTTP endpoints, channel message delivery with agent routing, Instance context for plugin initialization
- `src/command/chat-command.ts` — Chat command registry with validation, arg sanitization, execution locking
- `src/command/index.ts` — Plugin commands exposed to TUI via `GET /command` endpoint

## Demo Plugins

Three plugins demonstrate all features and serve as integration tests:

**Alpha (Producer)** — 15 registrations: 6 hooks, 2 chat commands (`/alpha`, `/ping-beta`), cron heartbeat, bus pub/sub, router, pipeline stage, read tool decorator, RPC method, stream transform, HTTP endpoint. Cross-plugin communication via bus and RPC.

**Beta (Consumer/Reactor)** — 17 registrations + 1 background service: 5 hooks (including `tool.block` for security policy and `tool.result.persist` for secret redaction), 2 chat commands (`/beta`, `/beta-block`), 3 bus subscriptions (responds to Alpha's ping with pong), cron status logger, router, pipeline stage, wildcard tool decorator, 2 RPC methods, stream transform, HTTP endpoint, background uptime service.

**Example (Standalone Reference)** — 22 registrations: all 8 mesh layers in one plugin. Unique features: L2 channel adapter, tool factory, wildcard bus subscription, both cron schedule types, both decorator patterns.

### Inter-Plugin Communication Flows

1. **Ping-Pong** (`/ping-beta`): Alpha publishes `alpha.ping` → Beta subscribes, publishes `beta.pong` → Alpha receives
2. **Cron Heartbeat** (every 60s): Alpha publishes `alpha.heartbeat` → Beta receives; Alpha calls `beta.echo` via RPC
3. **Tool Blocking**: LLM calls bash with blocked term → Beta's `tool.block` prevents execution → authoritative block message returned to LLM
4. **Dual Context**: Both Alpha and Beta inject `prependContext` via `agent.start` → LLM sees both in system prompt
5. **Dual Decoration**: Alpha wraps `read` (priority 0), Beta wraps `*` (priority -10) → chained execution
6. **Dual Stream**: Alpha counter (priority 0) + Beta marker (priority 10) → composed pipeline

## Files Changed

### New source files (8 mesh layers + supporting)

```
src/plugin/bus.ts          — L1 Bus (134 lines)
src/plugin/channel.ts      — L2 Channel (230 lines)
src/plugin/cron.ts         — L3 Cron (369 lines)
src/plugin/router.ts       — L4 Router (135 lines)
src/plugin/pipeline.ts     — L5 Pipeline (177 lines)
src/plugin/decorator.ts    — L6 Decorator (96 lines)
src/plugin/rpc.ts          — L7 RPC (91 lines)
src/plugin/stream.ts       — L8 Stream (149 lines)
src/plugin/registry.ts     — Registry + PluginApi (783 lines)
src/plugin/hooks.ts        — Hook runner (281 lines)
src/plugin/discovery.ts    — 4-tier plugin discovery
src/plugin/services.ts     — Service lifecycle manager
src/plugin/validation.ts   — Plugin config validation
src/plugin/slots.ts        — Exclusive slot resolution
src/command/chat-command.ts — Chat command registry
```

### Modified source files

```
src/plugin/index.ts        — New-style plugin loading alongside legacy
src/session/prompt.ts       — Pipeline, decorators, chat commands, hooks
src/session/processor.ts    — Stream transform bridging
src/server/server.ts        — RPC, channels, cron, Instance context fix
src/command/index.ts        — Plugin commands in TUI autocomplete
src/cli/cmd/tui/component/prompt/index.tsx — Plugin commands bypass LLM
packages/sdk/js/src/v2/gen/types.gen.ts    — "plugin" source type
```

### Test files (19 files, 257 tests)

```
test/plugin/bus.test.ts
test/plugin/channel.test.ts
test/plugin/cron.test.ts
test/plugin/router.test.ts
test/plugin/pipeline.test.ts
test/plugin/decorator.test.ts
test/plugin/rpc.test.ts
test/plugin/stream.test.ts
test/plugin/hooks.test.ts
test/plugin/registry.test.ts
test/plugin/discovery.test.ts
test/plugin/chat-command.test.ts
test/plugin/services.test.ts
test/plugin/validation.test.ts
test/plugin/slots.test.ts
```

### Demo plugins

```
.opencode/extensions/alpha/index.ts    — Alpha plugin
.opencode/extensions/beta/index.ts     — Beta plugin
.opencode/extensions/example/index.ts  — Example plugin
.opencode/extensions/*/README.md       — Per-plugin docs
.opencode/opencode.jsonc               — Plugin config entries
```

## Verification

- `bun run typecheck` — clean (0 errors)
- `bun test test/plugin/` — 257 tests pass, 0 failures, 454 assertions
- Manual testing: all chat commands, bus ping-pong, cron heartbeat, tool blocking, tool decoration, stream transforms verified via TUI + log observation
