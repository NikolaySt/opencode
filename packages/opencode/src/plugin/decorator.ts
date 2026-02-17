/**
 * Tool Decorators
 *
 * Wrap/transform tool execute functions with a decorator pattern.
 * Decorators can modify arguments, post-process results, add logging,
 * enforce policies, or completely replace tool behavior.
 *
 * Decorators are applied during tool resolution in resolveTools(),
 * after the base tool is resolved but before it's handed to the LLM.
 */

import { Log } from "../util/log"

const log = Log.create({ service: "plugin.decorator" })

// ============================================================================
// Types
// ============================================================================

export type ToolResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: unknown[]
}

export type ToolDecoratorContext = {
  sessionID: string
  agent: string
  tool: string
  callID?: string
}

export type ToolExecuteFn = (args: Record<string, unknown>, ctx: ToolDecoratorContext) => Promise<ToolResult>

export type ToolDecoratorInfo = {
  tool: string
  description: string
}

export type ToolDecorator = {
  tool: string | RegExp | "*"
  decorator: (original: ToolExecuteFn, info: ToolDecoratorInfo) => ToolExecuteFn
  priority?: number
}

export type ToolDecoratorRegistration = {
  pluginId: string
  decorator: ToolDecorator
  source: string
}

// ============================================================================
// Decorator Application
// ============================================================================

/**
 * Check if a decorator matches a tool name.
 */
function matches(pattern: string | RegExp | "*", tool: string): boolean {
  if (pattern === "*") return true
  if (pattern instanceof RegExp) return pattern.test(tool)
  return pattern === tool
}

/**
 * Apply all matching decorators to a tool's execute function.
 * Decorators are sorted by priority (lower first = inner wrapper).
 * The outermost decorator (highest priority) sees the call first.
 */
export function applyDecorators(
  decorators: ToolDecoratorRegistration[],
  tool: string,
  description: string,
  execute: ToolExecuteFn,
): ToolExecuteFn {
  const matching = decorators
    .filter((d) => matches(d.decorator.tool, tool))
    .toSorted((a, b) => (a.decorator.priority ?? 0) - (b.decorator.priority ?? 0))

  if (matching.length === 0) return execute

  const info: ToolDecoratorInfo = { tool, description }
  let wrapped = execute

  for (const reg of matching) {
    try {
      wrapped = reg.decorator.decorator(wrapped, info)
    } catch (err) {
      log.error(`decorator from ${reg.pluginId} for ${tool} failed to apply: ${String(err)}`)
    }
  }

  return wrapped
}
