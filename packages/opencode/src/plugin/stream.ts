/**
 * Stream Middleware
 *
 * Allows plugins to register async-generator transforms that wrap the
 * LLM response stream. Transforms can filter, modify, inject, or
 * observe stream events as they flow from the LLM to the processor.
 *
 * Transforms are composed by priority: higher priority = outer
 * (applied last, sees events first on the way in, last on the way out).
 */

import { Log } from "../util/log"

const log = Log.create({ service: "plugin.stream" })

// ============================================================================
// Types
// ============================================================================

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown }
  | { type: "tool-result"; toolName: string; result: unknown }
  | { type: "error"; error: unknown }
  | { type: "finish"; reason: string }
  | { type: "other"; event: unknown }

export type StreamTransformFn = (stream: AsyncIterable<StreamEvent>) => AsyncIterable<StreamEvent>

export type StreamTransform = {
  name: string
  transform: StreamTransformFn
  priority?: number
}

export type StreamTransformRegistration = {
  pluginId: string
  transform: StreamTransform
  source: string
}

// ============================================================================
// Error Boundary for Async Iteration
// ============================================================================

/**
 * Wrap an async iterable in a try/catch error boundary so that a failing
 * transform does not take down the entire LLM response stream. On error
 * an `{ type: "error" }` event is emitted and the wrapper falls back to
 * yielding from the upstream directly.
 */
async function* safeIterate(
  transformed: AsyncIterable<StreamEvent>,
  name: string,
  pluginId: string,
  upstream: AsyncIterable<StreamEvent>,
): AsyncIterable<StreamEvent> {
  try {
    for await (const event of transformed) {
      yield event
    }
  } catch (err) {
    log.error(`stream transform "${name}" from ${pluginId} failed during iteration: ${String(err)}`)
    yield { type: "error", error: err }
    // Fall back to draining whatever is left in the upstream
    try {
      for await (const event of upstream) {
        yield event
      }
    } catch {
      // upstream already consumed or failed — nothing to do
    }
  }
}

// ============================================================================
// Composition
// ============================================================================

/**
 * Compose stream transforms into a single transform function.
 * Lower priority transforms are applied first (inner), higher last (outer).
 * The outermost transform sees events first.
 */
export function composeTransforms(registrations: StreamTransformRegistration[]): StreamTransformFn | undefined {
  if (registrations.length === 0) return undefined

  const sorted = registrations.toSorted((a, b) => (a.transform.priority ?? 0) - (b.transform.priority ?? 0))

  return (stream: AsyncIterable<StreamEvent>) => {
    let current = stream
    for (const reg of sorted) {
      try {
        const upstream = current
        const raw = reg.transform.transform(upstream)
        // Wrap in a safe async generator that catches errors during iteration
        current = safeIterate(raw, reg.transform.name, reg.pluginId, upstream)
      } catch (err) {
        log.error(`stream transform "${reg.transform.name}" from ${reg.pluginId} failed to compose: ${String(err)}`)
      }
    }
    return current
  }
}

/**
 * Apply composed transforms to an async iterable stream.
 * If no transforms are registered, returns the original stream.
 */
export function applyStreamTransforms(
  stream: AsyncIterable<StreamEvent>,
  registrations: StreamTransformRegistration[],
): AsyncIterable<StreamEvent> {
  const composed = composeTransforms(registrations)
  if (!composed) return stream
  return composed(stream)
}

// ============================================================================
// Utility: create a passthrough transform (for testing / base case)
// ============================================================================

export async function* passthrough(stream: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  for await (const event of stream) {
    yield event
  }
}

/**
 * Convert an array of events into an async iterable (for testing).
 */
export async function* fromArray(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event
  }
}

/**
 * Collect all events from an async iterable into an array (for testing).
 */
export async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = []
  for await (const event of stream) {
    result.push(event)
  }
  return result
}
