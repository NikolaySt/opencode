/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 *
 * Two execution modes (matching OpenClaw pattern):
 * - Void hooks: Run all handlers in parallel (fire-and-forget)
 * - Modifying hooks: Run handlers sequentially in priority order,
 *   merging results from each handler
 */

import { Log } from "../util/log"
import { withTimeout } from "../util/timeout"
import type {
  PluginRegistry,
  PluginHookName,
  PluginHookHandlerMap,
  TypedPluginHookRegistration,
  PluginHookAgentStartEvent,
  PluginHookAgentStartResult,
  PluginHookAgentFinishEvent,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookCompactionEvent,
  PluginHookToolBlockEvent,
  PluginHookToolBlockResult,
  PluginHookToolEvent,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
  PluginHookMessageSentEvent,
  PluginHookSessionEvent,
  PluginHookServerEvent,
} from "./registry"

const log = Log.create({ service: "plugin.hooks" })

const DEFAULT_HOOK_TIMEOUT_MS = 30_000

/**
 * Get hooks for a specific hook name, sorted by priority (higher first).
 */
function getHooks<K extends PluginHookName>(registry: PluginRegistry, hookName: K): TypedPluginHookRegistration[] {
  return registry.typedHooks
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}

export type HookRunnerOptions = {
  catchErrors?: boolean
  timeoutMs?: number
}

/**
 * Create a hook runner for a specific registry.
 */
export function createHookRunner(registry: PluginRegistry, options: HookRunnerOptions = {}) {
  const catchErrors = options.catchErrors ?? true
  const timeout = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS

  // =========================================================================
  // Generic runners
  // =========================================================================

  /**
   * Run a void hook (fire-and-forget). All handlers execute in parallel.
   */
  async function runVoidHook<K extends PluginHookName>(
    hookName: K,
    event: Parameters<PluginHookHandlerMap[K]>[0],
  ): Promise<void> {
    const hooks = getHooks(registry, hookName)
    if (hooks.length === 0) return

    const promises = hooks.map(async (hook) => {
      try {
        const raw = (hook.handler as (event: unknown) => Promise<void>)(event)
        await withTimeout(Promise.resolve(raw), timeout, `${hookName} handler from ${hook.pluginId}`)
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`
        if (catchErrors) {
          log.error(msg)
        } else {
          throw new Error(msg, { cause: err })
        }
      }
    })

    const results = await Promise.allSettled(promises)
    if (!catchErrors) {
      for (const r of results) {
        if (r.status === "rejected") throw r.reason
      }
    }
  }

  /**
   * Run a modifying hook. Handlers execute sequentially in priority order.
   * Each handler can return a result that gets merged with previous results.
   */
  async function runModifyingHook<TResult>(
    hookName: PluginHookName,
    event: unknown,
    merge?: (accumulated: TResult | undefined, next: TResult) => TResult,
  ): Promise<TResult | undefined> {
    const hooks = getHooks(registry, hookName)
    if (hooks.length === 0) return undefined

    let result: TResult | undefined

    for (const hook of hooks) {
      try {
        const raw = (hook.handler as (event: unknown) => Promise<TResult | void>)(event)
        const out = await withTimeout(Promise.resolve(raw), timeout, `${hookName} handler from ${hook.pluginId}`)
        if (out !== undefined && out !== null) {
          if (merge && result !== undefined) {
            result = merge(result, out)
          } else {
            result = out
          }
        }
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`
        if (catchErrors) {
          log.error(msg)
        } else {
          throw new Error(msg, { cause: err })
        }
      }
    }

    return result
  }

  // =========================================================================
  // Session hooks
  // =========================================================================

  async function runSessionCreated(event: PluginHookSessionEvent): Promise<void> {
    return runVoidHook("session.created", event)
  }

  async function runSessionArchived(event: PluginHookSessionEvent): Promise<void> {
    return runVoidHook("session.archived", event)
  }

  // =========================================================================
  // Agent hooks
  // =========================================================================

  async function runAgentStart(event: PluginHookAgentStartEvent): Promise<PluginHookAgentStartResult | undefined> {
    return runModifyingHook<PluginHookAgentStartResult>("agent.start", event, (acc, next) => ({
      systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
      prependContext:
        acc?.prependContext && next.prependContext
          ? `${acc.prependContext}\n\n${next.prependContext}`
          : (next.prependContext ?? acc?.prependContext),
    }))
  }

  async function runAgentFinish(event: PluginHookAgentFinishEvent): Promise<void> {
    return runVoidHook("agent.finish", event)
  }

  // =========================================================================
  // Message hooks
  // =========================================================================

  async function runMessageReceived(event: PluginHookMessageReceivedEvent): Promise<void> {
    return runVoidHook("message.received", event)
  }

  async function runMessageSending(
    event: PluginHookMessageSendingEvent,
  ): Promise<PluginHookMessageSendingResult | undefined> {
    return runModifyingHook<PluginHookMessageSendingResult>("message.sending", event, (acc, next) => ({
      content: next.content ?? acc?.content,
      cancel: next.cancel ?? acc?.cancel,
    }))
  }

  async function runMessageSent(event: PluginHookMessageSentEvent): Promise<void> {
    return runVoidHook("message.sent", event)
  }

  // =========================================================================
  // Compaction hooks
  // =========================================================================

  async function runCompactionBefore(event: PluginHookCompactionEvent): Promise<void> {
    return runVoidHook("compaction.before", event)
  }

  async function runCompactionAfter(event: PluginHookCompactionEvent): Promise<void> {
    return runVoidHook("compaction.after", event)
  }

  // =========================================================================
  // Tool hooks
  // =========================================================================

  async function runToolBlock(event: PluginHookToolBlockEvent): Promise<PluginHookToolBlockResult | undefined> {
    return runModifyingHook<PluginHookToolBlockResult>("tool.block", event, (acc, next) => ({
      block: next.block ?? acc?.block,
      reason: next.reason ?? acc?.reason,
    }))
  }

  async function runToolBefore(event: PluginHookToolEvent): Promise<void> {
    return runVoidHook("tool.before", event)
  }

  async function runToolAfter(event: PluginHookToolEvent): Promise<void> {
    return runVoidHook("tool.after", event)
  }

  async function runToolResultPersist(
    event: PluginHookToolResultPersistEvent,
  ): Promise<PluginHookToolResultPersistResult | undefined> {
    return runModifyingHook<PluginHookToolResultPersistResult>("tool.result.persist", event, (acc, next) => ({
      output: next.output ?? acc?.output,
      title: next.title ?? acc?.title,
      metadata: next.metadata ? { ...acc?.metadata, ...next.metadata } : acc?.metadata,
    }))
  }

  // =========================================================================
  // Server hooks
  // =========================================================================

  async function runServerStart(event: PluginHookServerEvent): Promise<void> {
    return runVoidHook("server.start", event)
  }

  async function runServerStop(event: PluginHookServerEvent): Promise<void> {
    return runVoidHook("server.stop", event)
  }

  // =========================================================================
  // Utility
  // =========================================================================

  function hasHooks(hookName: PluginHookName): boolean {
    return registry.typedHooks.some((h) => h.hookName === hookName)
  }

  function count(hookName: PluginHookName): number {
    return registry.typedHooks.filter((h) => h.hookName === hookName).length
  }

  return {
    // Session
    runSessionCreated,
    runSessionArchived,
    // Agent
    runAgentStart,
    runAgentFinish,
    // Message
    runMessageReceived,
    runMessageSending,
    runMessageSent,
    // Compaction
    runCompactionBefore,
    runCompactionAfter,
    // Tool
    runToolBlock,
    runToolBefore,
    runToolAfter,
    runToolResultPersist,
    // Server
    runServerStart,
    runServerStop,
    // Utility
    hasHooks,
    count,
  }
}

export type HookRunner = ReturnType<typeof createHookRunner>
