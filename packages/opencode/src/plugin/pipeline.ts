/**
 * Pipeline Stages
 *
 * Koa-style composable middleware chain. Plugins register named stages
 * that can be inserted before, after, or in place of built-in stages.
 * The pipeline is compiled once and executed per-request.
 *
 * The built-in stages are extracted from the normal processing path
 * (section B9) in session/prompt.ts. Plugin stages can be inserted
 * before, after, or in place of any built-in stage via registerStage().
 */

import { Log } from "../util/log"

const log = Log.create({ service: "plugin.pipeline" })

// ============================================================================
// Types
// ============================================================================

export type PipelineContext = {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  channel?: string
  abort: AbortSignal
  metadata: Record<string, unknown>
  /**
   * Signal set by a stage to stop the loop iteration.
   * "stop" = break the while loop, "compact" = create compaction and continue,
   * "continue" = proceed to next iteration.
   */
  signal?: "stop" | "compact" | "continue"
}

export type PipelineNext = () => Promise<void>

export type PipelineHandler = (ctx: PipelineContext, next: PipelineNext) => Promise<void>

export type CompiledPipeline = (ctx: PipelineContext, finalNext?: PipelineNext) => Promise<void>

export type PipelineStage = {
  name: string
  handler: PipelineHandler
}

export type PipelinePosition = {
  type: "before" | "after" | "replace"
  target: string
}

export type PipelineStageRegistration = {
  pluginId: string
  stage: PipelineStage
  position: PipelinePosition
  source: string
}

// ============================================================================
// Built-in Stage Names (constants for reference)
// ============================================================================

export const STAGE = {
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
} as const

// ============================================================================
// Pipeline Composition
// ============================================================================

/**
 * Assemble a pipeline from built-in stages and plugin registrations.
 * Plugin stages are inserted relative to named targets.
 */
export function assemble(builtins: PipelineStage[], registrations: PipelineStageRegistration[]): PipelineStage[] {
  const result = builtins.map((s) => ({ ...s }))

  // Group registrations by position type for deterministic ordering
  const befores: PipelineStageRegistration[] = []
  const afters: PipelineStageRegistration[] = []
  const replaces: PipelineStageRegistration[] = []

  for (const reg of registrations) {
    if (reg.position.type === "before") befores.push(reg)
    else if (reg.position.type === "after") afters.push(reg)
    else if (reg.position.type === "replace") replaces.push(reg)
  }

  // Apply replacements first (last replacement wins)
  for (const reg of replaces) {
    const idx = result.findIndex((s) => s.name === reg.position.target)
    if (idx === -1) {
      log.warn(`pipeline: cannot replace unknown stage "${reg.position.target}" (from ${reg.pluginId})`)
      continue
    }
    result[idx] = reg.stage
  }

  // Apply befores (inserted before target, in registration order)
  for (const reg of befores) {
    const idx = result.findIndex((s) => s.name === reg.position.target)
    if (idx === -1) {
      log.warn(`pipeline: cannot insert before unknown stage "${reg.position.target}" (from ${reg.pluginId})`)
      continue
    }
    result.splice(idx, 0, reg.stage)
  }

  // Apply afters (inserted after target, preserving registration order).
  // Batch per target so multiple "afters" on the same target keep order.
  const aftersByTarget = new Map<string, { stages: PipelineStage[]; pluginIds: string[] }>()
  for (const reg of afters) {
    const entry = aftersByTarget.get(reg.position.target)
    if (entry) {
      entry.stages.push(reg.stage)
      entry.pluginIds.push(reg.pluginId)
    } else {
      aftersByTarget.set(reg.position.target, { stages: [reg.stage], pluginIds: [reg.pluginId] })
    }
  }
  for (const [target, { stages, pluginIds }] of aftersByTarget) {
    const idx = result.findIndex((s) => s.name === target)
    if (idx === -1) {
      for (const pid of pluginIds) log.warn(`pipeline: cannot insert after unknown stage "${target}" (from ${pid})`)
      continue
    }
    result.splice(idx + 1, 0, ...stages)
  }

  return result
}

/**
 * Compile a list of stages into a single executable function (Koa-style).
 * Each stage calls `next()` to continue to the next stage. If a stage
 * does not call `next()`, the pipeline short-circuits.
 */
export function compile(stages: PipelineStage[]): CompiledPipeline {
  return function composed(ctx: PipelineContext, finalNext?: PipelineNext): Promise<void> {
    let index = -1

    function dispatch(i: number): Promise<void> {
      if (i <= index) return Promise.reject(new Error("next() called multiple times"))
      index = i
      const stage = stages[i]
      if (!stage) return finalNext ? finalNext() : Promise.resolve()
      try {
        return Promise.resolve(stage.handler(ctx, () => dispatch(i + 1)))
      } catch (err) {
        return Promise.reject(err)
      }
    }

    return dispatch(0)
  }
}

/**
 * Convenience: assemble + compile in one step.
 */
export function createPipeline(
  builtins: PipelineStage[],
  registrations: PipelineStageRegistration[],
): CompiledPipeline {
  return compile(assemble(builtins, registrations))
}
