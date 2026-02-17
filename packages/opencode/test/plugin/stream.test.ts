import { describe, test, expect } from "bun:test"
import {
  composeTransforms,
  applyStreamTransforms,
  passthrough,
  fromArray,
  collect,
  type StreamEvent,
  type StreamTransformRegistration,
} from "../../src/plugin/stream"

function reg(
  name: string,
  transform: (stream: AsyncIterable<StreamEvent>) => AsyncIterable<StreamEvent>,
  priority?: number,
): StreamTransformRegistration {
  return {
    pluginId: "test",
    transform: { name, transform, priority },
    source: "/test",
  }
}

const events: StreamEvent[] = [
  { type: "text-delta", text: "hello" },
  { type: "text-delta", text: " world" },
  { type: "finish", reason: "stop" },
]

describe("fromArray and collect", () => {
  test("round-trips events", async () => {
    const result = await collect(fromArray(events))
    expect(result).toEqual(events)
  })
})

describe("passthrough", () => {
  test("yields all events unchanged", async () => {
    const result = await collect(passthrough(fromArray(events)))
    expect(result).toEqual(events)
  })
})

describe("composeTransforms", () => {
  test("returns undefined for empty registrations", () => {
    expect(composeTransforms([])).toBeUndefined()
  })

  test("single transform is applied", async () => {
    const composed = composeTransforms([
      reg("upper", async function* (stream) {
        for await (const event of stream) {
          if (event.type === "text-delta") {
            yield { ...event, text: event.text.toUpperCase() }
          } else {
            yield event
          }
        }
      }),
    ])
    const result = await collect(composed!(fromArray(events)))
    expect(result[0]).toEqual({ type: "text-delta", text: "HELLO" })
    expect(result[1]).toEqual({ type: "text-delta", text: " WORLD" })
  })

  test("multiple transforms compose in priority order", async () => {
    const composed = composeTransforms([
      reg(
        "prefix",
        async function* (stream) {
          for await (const event of stream) {
            if (event.type === "text-delta") {
              yield { ...event, text: `[${event.text}]` }
            } else {
              yield event
            }
          }
        },
        10, // outer
      ),
      reg(
        "upper",
        async function* (stream) {
          for await (const event of stream) {
            if (event.type === "text-delta") {
              yield { ...event, text: event.text.toUpperCase() }
            } else {
              yield event
            }
          }
        },
        1, // inner
      ),
    ])
    const result = await collect(composed!(fromArray(events)))
    // inner (upper) runs first, then outer (prefix) wraps
    expect(result[0]).toEqual({ type: "text-delta", text: "[HELLO]" })
    expect(result[1]).toEqual({ type: "text-delta", text: "[ WORLD]" })
  })

  test("filter transform can remove events", async () => {
    const composed = composeTransforms([
      reg("filter", async function* (stream) {
        for await (const event of stream) {
          // Drop finish events
          if (event.type !== "finish") yield event
        }
      }),
    ])
    const result = await collect(composed!(fromArray(events)))
    expect(result.length).toBe(2)
    expect(result.every((e) => e.type !== "finish")).toBe(true)
  })

  test("inject transform can add events", async () => {
    const composed = composeTransforms([
      reg("inject", async function* (stream) {
        yield { type: "text-delta" as const, text: "[start] " }
        for await (const event of stream) {
          yield event
        }
      }),
    ])
    const result = await collect(composed!(fromArray(events)))
    expect(result.length).toBe(4)
    expect(result[0]).toEqual({ type: "text-delta", text: "[start] " })
  })
})

describe("applyStreamTransforms", () => {
  test("no transforms returns original stream", async () => {
    const original = fromArray(events)
    const result = applyStreamTransforms(original, [])
    expect(result).toBe(original)
  })

  test("applies transforms to stream", async () => {
    const result = await collect(
      applyStreamTransforms(fromArray(events), [
        reg("upper", async function* (stream) {
          for await (const event of stream) {
            if (event.type === "text-delta") {
              yield { ...event, text: event.text.toUpperCase() }
            } else {
              yield event
            }
          }
        }),
      ]),
    )
    expect(result[0]).toEqual({ type: "text-delta", text: "HELLO" })
  })

  test("error in transform does not block composition", async () => {
    const result = await collect(
      applyStreamTransforms(fromArray(events), [
        reg("broken", () => {
          throw new Error("compose error")
        }),
        reg("good", async function* (stream) {
          for await (const event of stream) {
            if (event.type === "text-delta") {
              yield { ...event, text: `[good] ${event.text}` }
            } else {
              yield event
            }
          }
        }),
      ]),
    )
    // good transform still applies even though broken failed
    expect(result[0]).toEqual({ type: "text-delta", text: "[good] hello" })
  })

  test("error during async iteration emits error event and continues", async () => {
    const result = await collect(
      applyStreamTransforms(fromArray(events), [
        reg("lazy-fail", async function* (stream) {
          let count = 0
          for await (const event of stream) {
            count++
            if (count === 2) throw new Error("iteration boom")
            yield event
          }
        }),
      ]),
    )
    // First event yielded, then error event from the boundary, then upstream fallback events
    expect(result[0]).toEqual({ type: "text-delta", text: "hello" })
    expect(result[1].type).toBe("error")
    expect((result[1] as { type: "error"; error: Error }).error).toBeInstanceOf(Error)
    expect(((result[1] as { type: "error"; error: Error }).error as Error).message).toBe("iteration boom")
    // Upstream may have remaining events (though some may already be consumed)
  })

  test("handles all event types", async () => {
    const allEvents: StreamEvent[] = [
      { type: "text-delta", text: "hi" },
      { type: "reasoning-delta", text: "thinking" },
      { type: "tool-call", toolName: "bash", args: { cmd: "ls" } },
      { type: "tool-result", toolName: "bash", result: "files" },
      { type: "error", error: "oops" },
      { type: "finish", reason: "stop" },
      { type: "other", event: { custom: true } },
    ]
    // Use a real passthrough transform to verify each event type round-trips
    const result = await collect(
      applyStreamTransforms(fromArray(allEvents), [
        reg("passthrough", async function* (stream) {
          for await (const event of stream) {
            yield event
          }
        }),
      ]),
    )
    expect(result.length).toBe(7)
    expect(result[0]).toEqual({ type: "text-delta", text: "hi" })
    expect(result[1]).toEqual({ type: "reasoning-delta", text: "thinking" })
    expect(result[2]).toEqual({ type: "tool-call", toolName: "bash", args: { cmd: "ls" } })
    expect(result[3]).toEqual({ type: "tool-result", toolName: "bash", result: "files" })
    expect(result[4]).toEqual({ type: "error", error: "oops" })
    expect(result[5]).toEqual({ type: "finish", reason: "stop" })
    expect(result[6]).toEqual({ type: "other", event: { custom: true } })
  })
})
