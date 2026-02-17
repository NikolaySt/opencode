/**
 * Cron / Scheduler
 *
 * Lets plugins register scheduled tasks with interval, cron expression,
 * or one-shot timers. Jobs are started alongside services in the server
 * lifecycle and cleaned up on shutdown.
 *
 * Uses setInterval/setTimeout for scheduling. Cron expressions are
 * parsed with a lightweight 5-field parser (minute hour dom month dow).
 */

import { Log } from "../util/log"
import type { PluginLogger } from "./registry"

const log = Log.create({ service: "plugin.cron" })

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BACKOFF_MS = 5_000

// ============================================================================
// Types
// ============================================================================

export type CronSchedule =
  | { kind: "interval"; ms: number }
  | { kind: "cron"; expression: string; tz?: string }
  | { kind: "once"; at: Date | string | number }

export type CronAction =
  | { type: "publish"; topic: string; payload: unknown }
  | { type: "custom"; handler: (ctx: CronJobContext) => Promise<void> }

export type CronJobDefinition = {
  id: string
  schedule: CronSchedule
  action: CronAction
  enabled?: boolean
  maxRetries?: number
  backoffMs?: number
}

export type CronJobContext = {
  config: unknown
  pluginConfig?: Record<string, unknown>
  logger: PluginLogger
  abort: AbortSignal
  jobId: string
  runCount: number
}

export type CronJobRegistration = {
  pluginId: string
  job: CronJobDefinition
  pluginConfig?: Record<string, unknown>
  source: string
}

export type CronJobState = {
  id: string
  pluginId: string
  status: "active" | "paused" | "completed" | "error"
  lastRun?: number
  nextRun?: number
  runCount: number
  errorCount: number
  lastError?: string
}

// ============================================================================
// Cron Expression Parser (5-field: min hour dom month dow)
// ============================================================================

type CronField = { values: number[] | "*" }

function parseField(field: string, min: number, max: number): CronField {
  if (field === "*") return { values: "*" }
  const values: number[] = []
  for (const part of field.split(",")) {
    const step = part.includes("/") ? part.split("/") : null
    const range = (step ? step[0] : part).includes("-") ? (step ? step[0] : part).split("-") : null
    if (step) {
      const base = step[0] === "*" ? min : parseInt(step[0], 10)
      const end = range ? parseInt(range[1], 10) : max
      const interval = parseInt(step[1], 10)
      if (isNaN(interval) || interval <= 0) continue
      for (let i = range ? parseInt(range[0], 10) : base; i <= end; i += interval) {
        if (i >= min && i <= max) values.push(i)
      }
    } else if (range) {
      const start = parseInt(range[0], 10)
      const end = parseInt(range[1], 10)
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.push(i)
      }
    } else {
      const n = parseInt(part, 10)
      if (!isNaN(n) && n >= min && n <= max) values.push(n)
    }
  }
  if (values.length === 0)
    throw new Error(`invalid cron field: "${field}" produced no valid values for range ${min}-${max}`)
  return { values }
}

export function parseCronExpression(expression: string) {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`invalid cron expression: expected 5 fields, got ${parts.length}`)
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
  }
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.values === "*") return true
  return field.values.includes(value)
}

/**
 * Extract date components in a given timezone (or local if no tz).
 */
function dateComponents(
  date: Date,
  tz?: string,
): { minute: number; hour: number; dom: number; month: number; dow: number } {
  if (!tz) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dom: date.getDate(),
      month: date.getMonth() + 1,
      dow: date.getDay(),
    }
  }
  const s = date.toLocaleString("en-US", { timeZone: tz, hour12: false })
  // Format: "1/15/2025, 14:30:00"
  const [datePart, timePart] = s.split(", ")
  const [month, dom] = datePart.split("/").map(Number)
  const [hour, minute] = timePart.split(":").map(Number)
  // Reconstruct a Date in the target timezone to get day-of-week
  const dow = new Date(date.toLocaleString("en-US", { timeZone: tz })).getDay()
  return { minute, hour, dom, month, dow }
}

export function cronMatches(expression: string, date: Date, tz?: string): boolean {
  const cron = parseCronExpression(expression)
  const d = dateComponents(date, tz)
  return (
    fieldMatches(cron.minute, d.minute) &&
    fieldMatches(cron.hour, d.hour) &&
    fieldMatches(cron.dom, d.dom) &&
    fieldMatches(cron.month, d.month) &&
    fieldMatches(cron.dow, d.dow)
  )
}

// ============================================================================
// Scheduler
// ============================================================================

export type CronHandle = {
  stop: () => Promise<void>
  states: () => CronJobState[]
  pause: (jobId: string) => boolean
  resume: (jobId: string) => boolean
}

export function startCronScheduler(input: {
  jobs: CronJobRegistration[]
  config: unknown
  publish?: (pluginId: string, topic: string, payload: unknown) => Promise<void>
}): CronHandle {
  const controller = new AbortController()
  const inFlight = new Set<Promise<void>>()
  const entries: Array<{
    registration: CronJobRegistration
    state: CronJobState
    timer?: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>
    kind: CronSchedule["kind"]
    lastFiredMinute: number
    backoffUntil: number
    run: () => Promise<void>
  }> = []

  for (const reg of input.jobs) {
    if (reg.job.enabled === false) continue
    const state: CronJobState = {
      id: reg.job.id,
      pluginId: reg.pluginId,
      status: "active",
      runCount: 0,
      errorCount: 0,
    }

    const logger: PluginLogger = {
      info: (msg) => log.info(`[cron:${reg.job.id}] ${msg}`),
      warn: (msg) => log.warn(`[cron:${reg.job.id}] ${msg}`),
      error: (msg) => log.error(`[cron:${reg.job.id}] ${msg}`),
    }

    const maxRetries = reg.job.maxRetries ?? DEFAULT_MAX_RETRIES

    async function run() {
      if (controller.signal.aborted) return
      if (state.status === "paused") return
      if (state.status === "error") return
      // Backoff: skip this invocation if still within the backoff window
      if (entry.backoffUntil > Date.now()) return

      state.runCount++
      state.lastRun = Date.now()

      const ctx: CronJobContext = {
        config: input.config,
        pluginConfig: reg.pluginConfig,
        logger,
        abort: controller.signal,
        jobId: reg.job.id,
        runCount: state.runCount,
      }

      const promise = (async () => {
        try {
          if (reg.job.action.type === "custom") {
            await reg.job.action.handler(ctx)
          } else if (reg.job.action.type === "publish" && input.publish) {
            await input.publish(reg.pluginId, reg.job.action.topic, reg.job.action.payload)
          }
          state.errorCount = 0
          state.lastError = undefined
          entry.backoffUntil = 0
        } catch (err) {
          state.errorCount++
          state.lastError = String(err)
          logger.error(`run ${state.runCount} failed: ${String(err)}`)
          if (state.errorCount >= maxRetries) {
            state.status = "error"
            // Clear the timer to stop wasting cycles — resume() will re-create it
            if (entry.timer !== undefined) {
              if (entry.kind === "once") clearTimeout(entry.timer as ReturnType<typeof setTimeout>)
              else clearInterval(entry.timer as ReturnType<typeof setInterval>)
              entry.timer = undefined
            }
            logger.error(`entered error state after ${maxRetries} consecutive failures`)
          } else {
            // Apply backoff: set a window during which run() skips execution
            const backoff = (reg.job.backoffMs ?? DEFAULT_BACKOFF_MS) * state.errorCount
            entry.backoffUntil = Date.now() + backoff
          }
        }
      })()

      inFlight.add(promise)
      promise.finally(() => inFlight.delete(promise))
      await promise
    }

    const entry = {
      registration: reg,
      state,
      timer: undefined as ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | undefined,
      kind: reg.job.schedule.kind,
      lastFiredMinute: -1,
      backoffUntil: 0,
      run,
    }

    if (reg.job.schedule.kind === "interval") {
      entry.timer = setInterval(run, reg.job.schedule.ms)
    } else if (reg.job.schedule.kind === "once") {
      const target =
        reg.job.schedule.at instanceof Date
          ? reg.job.schedule.at.getTime()
          : typeof reg.job.schedule.at === "string"
            ? new Date(reg.job.schedule.at).getTime()
            : reg.job.schedule.at
      const delay = Math.max(0, target - Date.now())
      state.nextRun = target
      entry.timer = setTimeout(async () => {
        entry.timer = undefined
        await run()
        // Only mark completed if the run actually executed (not skipped due to pause/abort)
        if (state.status === "active") state.status = "completed"
      }, delay)
    } else if (reg.job.schedule.kind === "cron") {
      const expr = reg.job.schedule.expression
      const tz = reg.job.schedule.tz
      // Check every 60 seconds if the cron expression matches
      entry.timer = setInterval(() => {
        const minuteKey = Math.floor(Date.now() / 60_000)
        if (minuteKey === entry.lastFiredMinute) return
        if (cronMatches(expr, new Date(), tz)) {
          entry.lastFiredMinute = minuteKey
          run()
        }
      }, 60_000)
    }

    entries.push(entry)
  }

  async function stop() {
    controller.abort()
    for (const entry of entries) {
      if (entry.timer === undefined) continue
      if (entry.kind === "once") clearTimeout(entry.timer as ReturnType<typeof setTimeout>)
      else clearInterval(entry.timer as ReturnType<typeof setInterval>)
    }
    // Wait for any in-flight run() calls to complete
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight])
    }
  }

  function states(): CronJobState[] {
    return entries.map((e) => ({ ...e.state }))
  }

  function pause(jobId: string): boolean {
    const entry = entries.find((e) => e.state.id === jobId)
    if (!entry || entry.state.status !== "active") return false
    entry.state.status = "paused"
    return true
  }

  function resume(jobId: string): boolean {
    const entry = entries.find(
      (e) => e.state.id === jobId && (e.state.status === "paused" || e.state.status === "error"),
    )
    if (!entry) return false
    // "once" jobs that entered error state cannot be resumed — they already
    // fired their one-shot timer and there is no meaningful way to re-schedule.
    if (entry.kind === "once" && entry.state.status === "error") return false
    entry.state.status = "active"
    entry.state.errorCount = 0
    entry.backoffUntil = 0
    // Re-create the timer if it was cleared (e.g. on error state) or
    // if it already fired while paused.
    if (entry.timer === undefined && !controller.signal.aborted) {
      const schedule = entry.registration.job.schedule
      if (schedule.kind === "interval") {
        entry.timer = setInterval(entry.run, schedule.ms)
      } else if (schedule.kind === "cron") {
        const expr = schedule.expression
        const tz = schedule.tz
        entry.timer = setInterval(() => {
          const minuteKey = Math.floor(Date.now() / 60_000)
          if (minuteKey === entry.lastFiredMinute) return
          if (cronMatches(expr, new Date(), tz)) {
            entry.lastFiredMinute = minuteKey
            entry.run()
          }
        }, 60_000)
      } else if (schedule.kind === "once") {
        // "once" timer already fired while paused — re-fire immediately
        entry.timer = setTimeout(async () => {
          await entry.run()
          if (entry.state.status === "active") entry.state.status = "completed"
        }, 0)
      }
    }
    return true
  }

  return { stop, states, pause, resume }
}
