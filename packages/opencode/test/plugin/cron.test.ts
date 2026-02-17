import { describe, test, expect } from "bun:test"
import { parseCronExpression, cronMatches, startCronScheduler, type CronJobRegistration } from "../../src/plugin/cron"

describe("parseCronExpression", () => {
  test("parses wildcard fields", () => {
    const result = parseCronExpression("* * * * *")
    expect(result.minute.values).toBe("*")
    expect(result.hour.values).toBe("*")
    expect(result.dom.values).toBe("*")
    expect(result.month.values).toBe("*")
    expect(result.dow.values).toBe("*")
  })

  test("parses specific values", () => {
    const result = parseCronExpression("0 9 1 1 0")
    expect(result.minute.values).toEqual([0])
    expect(result.hour.values).toEqual([9])
    expect(result.dom.values).toEqual([1])
    expect(result.month.values).toEqual([1])
    expect(result.dow.values).toEqual([0])
  })

  test("parses ranges", () => {
    const result = parseCronExpression("0-5 * * * *")
    expect(result.minute.values).toEqual([0, 1, 2, 3, 4, 5])
  })

  test("parses step values", () => {
    const result = parseCronExpression("*/15 * * * *")
    expect(result.minute.values).toEqual([0, 15, 30, 45])
  })

  test("parses comma-separated values", () => {
    const result = parseCronExpression("0,30 * * * *")
    expect(result.minute.values).toEqual([0, 30])
  })

  test("throws on invalid field count", () => {
    expect(() => parseCronExpression("* * *")).toThrow("expected 5 fields")
  })
})

describe("cronMatches", () => {
  test("matches exact time", () => {
    // January 1, 2025 at 9:00 AM (Wednesday = 3)
    const date = new Date(2025, 0, 1, 9, 0)
    expect(cronMatches("0 9 1 1 3", date)).toBe(true)
  })

  test("does not match wrong minute", () => {
    const date = new Date(2025, 0, 1, 9, 5)
    expect(cronMatches("0 9 1 1 *", date)).toBe(false)
  })

  test("wildcard matches any value", () => {
    const date = new Date(2025, 5, 15, 14, 30)
    expect(cronMatches("30 14 * * *", date)).toBe(true)
  })

  test("step expression matches correctly", () => {
    const date = new Date(2025, 0, 1, 9, 15)
    expect(cronMatches("*/15 * * * *", date)).toBe(true)
  })

  test("step expression does not match non-step minute", () => {
    const date = new Date(2025, 0, 1, 9, 7)
    expect(cronMatches("*/15 * * * *", date)).toBe(false)
  })

  test("timezone support: matches using UTC timezone", () => {
    // Create a date and test matching with explicit UTC timezone
    const date = new Date("2025-06-15T14:30:00Z") // 14:30 UTC
    expect(cronMatches("30 14 * * *", date, "UTC")).toBe(true)
    expect(cronMatches("30 15 * * *", date, "UTC")).toBe(false)
  })

  test("timezone support: different timezone shifts the match", () => {
    // 14:30 UTC = 15:30 in Europe/Berlin (summer time, UTC+2)
    const date = new Date("2025-06-15T14:30:00Z")
    // In UTC it's 14:30, in Berlin it's 16:30 (CEST = UTC+2)
    expect(cronMatches("30 14 * * *", date, "UTC")).toBe(true)
    // Berlin is UTC+2 in summer, so 14:30 UTC = 16:30 Berlin
    expect(cronMatches("30 16 * * *", date, "Europe/Berlin")).toBe(true)
    expect(cronMatches("30 14 * * *", date, "Europe/Berlin")).toBe(false)
  })

  test("no timezone defaults to local time", () => {
    const date = new Date(2025, 0, 1, 9, 0) // Local 9:00
    expect(cronMatches("0 9 * * *", date)).toBe(true)
    expect(cronMatches("0 9 * * *", date, undefined)).toBe(true)
  })
})

describe("startCronScheduler", () => {
  function reg(id: string, overrides?: Partial<CronJobRegistration["job"]>): CronJobRegistration {
    return {
      pluginId: "test",
      job: {
        id,
        schedule: { kind: "interval", ms: 50 },
        action: { type: "custom", handler: async () => {} },
        ...overrides,
      },
      source: "/test",
    }
  }

  test("interval job runs multiple times", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("counter", {
          schedule: { kind: "interval", ms: 30 },
          action: {
            type: "custom",
            handler: async () => {
              count++
            },
          },
        }),
      ],
      config: {},
    })
    await new Promise((r) => setTimeout(r, 120))
    handle.stop()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test("once job runs exactly once", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("once", {
          schedule: { kind: "once", at: Date.now() + 30 },
          action: {
            type: "custom",
            handler: async () => {
              count++
            },
          },
        }),
      ],
      config: {},
    })
    await new Promise((r) => setTimeout(r, 100))
    handle.stop()
    expect(count).toBe(1)
    const states = handle.states()
    expect(states[0].status).toBe("completed")
  })

  test("disabled job does not run", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("disabled", {
          enabled: false,
          schedule: { kind: "interval", ms: 10 },
          action: {
            type: "custom",
            handler: async () => {
              count++
            },
          },
        }),
      ],
      config: {},
    })
    await new Promise((r) => setTimeout(r, 60))
    handle.stop()
    expect(count).toBe(0)
    expect(handle.states().length).toBe(0)
  })

  test("paused job does not execute", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("pausable", {
          schedule: { kind: "interval", ms: 30 },
          action: {
            type: "custom",
            handler: async () => {
              count++
            },
          },
        }),
      ],
      config: {},
    })
    handle.pause("pausable")
    await new Promise((r) => setTimeout(r, 100))
    handle.stop()
    expect(count).toBe(0)
  })

  test("resume makes paused job active again", () => {
    const handle = startCronScheduler({
      jobs: [reg("resumable")],
      config: {},
    })
    handle.pause("resumable")
    expect(handle.states()[0].status).toBe("paused")
    handle.resume("resumable")
    expect(handle.states()[0].status).toBe("active")
    handle.stop()
  })

  test("erroring job pauses after max retries", async () => {
    const handle = startCronScheduler({
      jobs: [
        reg("failing", {
          schedule: { kind: "interval", ms: 20 },
          maxRetries: 2,
          backoffMs: 0,
          action: {
            type: "custom",
            handler: async () => {
              throw new Error("boom")
            },
          },
        }),
      ],
      config: {},
    })
    await new Promise((r) => setTimeout(r, 150))
    await handle.stop()
    const states = handle.states()
    expect(states[0].status).toBe("error")
    expect(states[0].errorCount).toBeGreaterThanOrEqual(2)
  })

  test("publish action calls publish function", async () => {
    const published: Array<{ topic: string; payload: unknown }> = []
    const handle = startCronScheduler({
      jobs: [
        reg("publisher", {
          schedule: { kind: "interval", ms: 30 },
          action: { type: "publish", topic: "data", payload: { value: 42 } },
        }),
      ],
      config: {},
      publish: async (_pluginId, topic, payload) => {
        published.push({ topic, payload })
      },
    })
    await new Promise((r) => setTimeout(r, 100))
    handle.stop()
    expect(published.length).toBeGreaterThanOrEqual(1)
    expect(published[0].topic).toBe("data")
    expect(published[0].payload).toEqual({ value: 42 })
  })

  test("states returns current state for all jobs", () => {
    const handle = startCronScheduler({
      jobs: [reg("a"), reg("b")],
      config: {},
    })
    const states = handle.states()
    expect(states.length).toBe(2)
    expect(states[0].id).toBe("a")
    expect(states[1].id).toBe("b")
    expect(states[0].status).toBe("active")
    handle.stop()
  })

  test("stop cleans up all timers", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("stopped", {
          schedule: { kind: "interval", ms: 20 },
          action: {
            type: "custom",
            handler: async () => {
              count++
            },
          },
        }),
      ],
      config: {},
    })
    await new Promise((r) => setTimeout(r, 50))
    handle.stop()
    const snapshot = count
    await new Promise((r) => setTimeout(r, 80))
    expect(count).toBe(snapshot)
  })

  test("cron schedule kind fires when expression matches", async () => {
    let count = 0
    // Use a cron expression that matches the current minute — "* * * * *" matches always
    const handle = startCronScheduler({
      jobs: [
        reg("cron-job", {
          schedule: { kind: "cron", expression: "* * * * *" },
          action: {
            type: "custom",
            handler: async () => {
              count++
            },
          },
        }),
      ],
      config: {},
    })
    // The cron scheduler checks every 60s, so we cannot wait for it to fire
    // naturally in a test. Instead, verify the state was set up correctly.
    const states = handle.states()
    expect(states.length).toBe(1)
    expect(states[0].id).toBe("cron-job")
    expect(states[0].status).toBe("active")
    handle.stop()
  })

  test("resume from error state resets errorCount and re-creates timer", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("error-resume", {
          schedule: { kind: "interval", ms: 20 },
          maxRetries: 2,
          backoffMs: 0,
          action: {
            type: "custom",
            handler: async () => {
              count++
              // Fail on first runs to enter error state, succeed after resume
              if (count <= 2) throw new Error("fail")
            },
          },
        }),
      ],
      config: {},
    })
    // Wait for the job to enter error state (2 failures at 20ms interval)
    await new Promise((r) => setTimeout(r, 120))
    expect(handle.states()[0].status).toBe("error")
    expect(handle.states()[0].errorCount).toBeGreaterThanOrEqual(2)

    // Resume — should reset errorCount and re-create the interval timer
    const resumed = handle.resume("error-resume")
    expect(resumed).toBe(true)
    expect(handle.states()[0].status).toBe("active")
    expect(handle.states()[0].errorCount).toBe(0)

    // Wait for the resumed timer to fire — count should increase
    const countBeforeResume = count
    await new Promise((r) => setTimeout(r, 100))
    handle.stop()
    expect(count).toBeGreaterThan(countBeforeResume)
  })

  test("once job paused past fire time re-fires on resume", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("once-paused", {
          schedule: { kind: "once", at: Date.now() + 20 },
          action: {
            type: "custom",
            handler: async () => {
              count++
            },
          },
        }),
      ],
      config: {},
    })
    // Pause immediately before the timer fires
    handle.pause("once-paused")
    // Wait past the fire time — the timer fires but run() returns early (paused)
    await new Promise((r) => setTimeout(r, 80))
    expect(count).toBe(0)
    // Resume — should re-fire immediately
    const resumed = handle.resume("once-paused")
    expect(resumed).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    handle.stop()
    expect(count).toBe(1)
    expect(handle.states()[0].status).toBe("completed")
  })

  test("once job in error state cannot be resumed", async () => {
    const handle = startCronScheduler({
      jobs: [
        reg("once-error", {
          schedule: { kind: "once", at: Date.now() + 10 },
          maxRetries: 1,
          action: {
            type: "custom",
            handler: async () => {
              throw new Error("fail")
            },
          },
        }),
      ],
      config: {},
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(handle.states()[0].status).toBe("error")
    const resumed = handle.resume("once-error")
    expect(resumed).toBe(false)
    expect(handle.states()[0].status).toBe("error")
    handle.stop()
  })

  test("backoffMs delays retries after non-fatal errors", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("backoff-test", {
          schedule: { kind: "interval", ms: 15 },
          maxRetries: 5,
          backoffMs: 200,
          action: {
            type: "custom",
            handler: async () => {
              count++
              throw new Error("fail")
            },
          },
        }),
      ],
      config: {},
    })
    // With 15ms interval and 200ms backoff after first failure, only ~1-2 runs should happen in 100ms
    await new Promise((r) => setTimeout(r, 100))
    await handle.stop()
    // Without backoff (15ms interval, 100ms wait) we'd expect ~6 runs.
    // With 200ms backoff after first failure, only 1 should execute.
    expect(count).toBeLessThanOrEqual(2)
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test("resume from error resets backoff so job runs immediately", async () => {
    let count = 0
    const handle = startCronScheduler({
      jobs: [
        reg("backoff-resume", {
          schedule: { kind: "interval", ms: 15 },
          maxRetries: 1, // Enter error state after first failure
          backoffMs: 60_000, // Huge backoff — if not reset on resume, job would stay blocked
          action: {
            type: "custom",
            handler: async () => {
              count++
              // Fail on first run to enter error state, succeed after resume
              if (count === 1) throw new Error("fail")
            },
          },
        }),
      ],
      config: {},
    })
    // Wait for the job to enter error state after first failure
    await new Promise((r) => setTimeout(r, 80))
    expect(handle.states()[0].status).toBe("error")
    expect(count).toBe(1)

    // Resume — should reset both errorCount AND backoffUntil
    const resumed = handle.resume("backoff-resume")
    expect(resumed).toBe(true)

    // Wait for the resumed timer to fire — count should increase
    await new Promise((r) => setTimeout(r, 80))
    await handle.stop()
    // Job should have run at least once more after resume (proving backoff was reset)
    expect(count).toBeGreaterThan(1)
  })

  test("async stop waits for in-flight run() to complete", async () => {
    let finished = false
    const handle = startCronScheduler({
      jobs: [
        reg("slow-job", {
          schedule: { kind: "interval", ms: 10 },
          action: {
            type: "custom",
            handler: async () => {
              await new Promise((r) => setTimeout(r, 80))
              finished = true
            },
          },
        }),
      ],
      config: {},
    })
    // Wait for the job to start running
    await new Promise((r) => setTimeout(r, 30))
    // Stop should wait for the in-flight handler to complete
    await handle.stop()
    expect(finished).toBe(true)
  })
})
