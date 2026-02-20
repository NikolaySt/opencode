/**
 * OpenAI Embedding Provider
 *
 * Uses the OpenAI embeddings API (text-embedding-3-small by default).
 * Supports retry with exponential backoff and automatic batching.
 * Includes a per-request timeout to prevent indefinite hangs.
 */

import { Log } from "../util/log"
import type { EmbeddingProvider } from "./embed"
import * as Embed from "./embed"
import * as Metrics from "./metrics"

const log = Log.create({ service: "memory.embed.openai" })

const MAX_RETRIES = 3
const BASE_DELAY = 500
const MAX_DELAY = 8000
/** OpenAI allows up to 2048 inputs per request */
const MAX_BATCH = 2048
/** Per-request timeout (ms) — prevents indefinite hangs on network issues */
const REQUEST_TIMEOUT = 30_000

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function createProvider(config?: Record<string, unknown>): EmbeddingProvider {
  const model = (config?.model as string) ?? "text-embedding-3-small"
  const defaultDims = model.includes("3-small") ? 1536 : model.includes("3-large") ? 3072 : 1536
  const dims = (config?.dimensions as number | undefined) ?? defaultDims
  const base = (config?.baseURL as string) ?? "https://api.openai.com/v1"

  log.debug("createProvider: initialized", { model, dims, base })

  function key(): string {
    const k = (config?.apiKey as string) ?? process.env.OPENAI_API_KEY
    if (!k) throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY or configure in opencode.json")
    return k
  }

  async function embedBatch(texts: string[]): Promise<number[][]> {
    log.debug("embedBatch: starting", { count: texts.length, model })
    const started = Date.now()

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        log.warn("embedBatch: request timed out", { attempt: attempt + 1, timeout: REQUEST_TIMEOUT })
        controller.abort()
      }, REQUEST_TIMEOUT)

      try {
        log.debug("embedBatch: sending request", {
          attempt: attempt + 1,
          url: `${base}/embeddings`,
          texts: texts.length,
        })

        const response = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key()}`,
          },
          body: JSON.stringify({
            model,
            input: texts,
            ...(dims !== defaultDims ? { dimensions: dims } : {}),
          }),
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!response.ok) {
          const body = await response.text().catch(() => "")
          log.warn("embedBatch: API error response", {
            status: response.status,
            body: body.slice(0, 200),
            attempt: attempt + 1,
          })
          if (response.status === 429 || response.status >= 500) {
            if (attempt === MAX_RETRIES - 1) {
              Metrics.record("embeddingErrors")
              throw new Error(
                `OpenAI embeddings API error after ${MAX_RETRIES} retries: ${response.status} ${body.slice(0, 200)}`,
              )
            }
            const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY)
            log.warn("embedBatch: retryable error, backing off", {
              status: response.status,
              attempt: attempt + 1,
              delay,
            })
            await sleep(delay)
            continue
          }
          throw new Error(`OpenAI embeddings API error: ${response.status} ${body.slice(0, 200)}`)
        }

        const data = (await response.json()) as {
          data?: Array<{ embedding: number[]; index: number }>
        }
        if (!data?.data?.length) {
          log.warn("embedBatch: empty or malformed response", { data: JSON.stringify(data).slice(0, 200) })
          throw new Error("OpenAI embeddings API returned empty or malformed response")
        }

        Metrics.record("embeddingCalls")
        Metrics.record("embeddingTexts", texts.length)
        Metrics.record("embeddingLatencyMs", Date.now() - started)
        log.debug("embedBatch: success", { results: data.data.length, attempt: attempt + 1 })
        return data.data.toSorted((a, b) => a.index - b.index).map((d) => d.embedding)
      } catch (err) {
        clearTimeout(timeout)

        const isAbort = err instanceof DOMException && err.name === "AbortError"
        const errorMsg = isAbort ? "request timed out" : String(err)

        if (attempt === MAX_RETRIES - 1) {
          Metrics.record("embeddingErrors")
          log.warn("embedBatch: all retries exhausted", { error: errorMsg, attempts: MAX_RETRIES })
          throw new Error(`embedding failed after ${MAX_RETRIES} retries: ${errorMsg}`)
        }

        const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY)
        log.warn("embedBatch: request error, retrying", {
          error: errorMsg,
          isTimeout: isAbort,
          attempt: attempt + 1,
          delay,
        })
        await sleep(delay)
      }
    }
    throw new Error("embedding failed after all retries")
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    log.debug("embed: called", { texts: texts.length })

    // Split into batches of MAX_BATCH
    if (texts.length <= MAX_BATCH) return embedBatch(texts)

    const results: number[][] = []
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH)
      log.debug("embed: processing batch", { batch: Math.floor(i / MAX_BATCH) + 1, size: batch.length })
      const embeddings = await embedBatch(batch)
      results.push(...embeddings)
    }
    return results
  }

  return {
    embed,
    dimensions: () => dims,
    model: () => model,
  }
}

// Register on import — factory receives config from plugin
Embed.register("openai", createProvider)

export { createProvider }
