import { describe, expect, test, afterEach } from "bun:test"
import { createProvider } from "../../src/memory/embed-openai"
import * as Metrics from "../../src/memory/metrics"

/**
 * Tests for the OpenAI embedding provider.
 * Uses mocked fetch to avoid actual API calls.
 */

// Helper to mock globalThis.fetch without type conflicts
function mockFetch(fn: (...args: any[]) => any) {
  ;(globalThis as any).fetch = fn
}

describe("memory.embed-openai.createProvider", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    Metrics.reset()
  })

  test("creates provider with default model and dimensions", () => {
    const provider = createProvider({ apiKey: "test-key" })
    expect(provider.model()).toBe("text-embedding-3-small")
    expect(provider.dimensions()).toBe(1536)
  })

  test("creates provider with custom model", () => {
    const provider = createProvider({ apiKey: "test-key", model: "text-embedding-3-large" })
    expect(provider.model()).toBe("text-embedding-3-large")
    expect(provider.dimensions()).toBe(3072)
  })

  test("creates provider with custom dimensions", () => {
    const provider = createProvider({ apiKey: "test-key", dimensions: 256 })
    expect(provider.dimensions()).toBe(256)
  })

  test("creates provider with unknown model defaults to 1536 dims", () => {
    const provider = createProvider({ apiKey: "test-key", model: "custom-model" })
    expect(provider.model()).toBe("custom-model")
    expect(provider.dimensions()).toBe(1536)
  })

  test("embed returns empty array for empty input", async () => {
    const provider = createProvider({ apiKey: "test-key" })
    const result = await provider.embed([])
    expect(result).toEqual([])
  })

  test("embed succeeds with mocked API response", async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: [0.1, 0.2, 0.3] },
              { index: 1, embedding: [0.4, 0.5, 0.6] },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    )

    const provider = createProvider({ apiKey: "test-key" })
    const result = await provider.embed(["hello", "world"])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual([0.1, 0.2, 0.3])
    expect(result[1]).toEqual([0.4, 0.5, 0.6])
    expect(Metrics.get("embeddingCalls")).toBe(1)
    expect(Metrics.get("embeddingTexts")).toBe(2)
  })

  test("embed sorts results by index", async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0.4, 0.5] },
              { index: 0, embedding: [0.1, 0.2] },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    )

    const provider = createProvider({ apiKey: "test-key" })
    const result = await provider.embed(["first", "second"])
    expect(result[0]).toEqual([0.1, 0.2])
    expect(result[1]).toEqual([0.4, 0.5])
  })

  test("throws on missing API key", async () => {
    const oldKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY

    const provider = createProvider({})
    await expect(provider.embed(["test"])).rejects.toThrow("API key not configured")

    if (oldKey) process.env.OPENAI_API_KEY = oldKey
  })

  test("throws on non-retryable error (4xx except 429)", async () => {
    mockFetch(async () => new Response("Bad request", { status: 400 }))

    const provider = createProvider({ apiKey: "test-key" })
    await expect(provider.embed(["test"])).rejects.toThrow("400")
    // 400 errors throw from the response handler, get caught by the retry catch block,
    // and on the last attempt the catch records embeddingErrors once
    expect(Metrics.get("embeddingErrors")).toBe(1)
  }, 30000)

  test("throws on empty/malformed response", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    )

    const provider = createProvider({ apiKey: "test-key" })
    await expect(provider.embed(["test"])).rejects.toThrow("empty or malformed response")
  })

  test("retries on 429 and records embeddingErrors on exhaustion", async () => {
    let attempts = 0
    mockFetch(async () => {
      attempts++
      return new Response("rate limited", { status: 429 })
    })

    const provider = createProvider({ apiKey: "test-key" })
    await expect(provider.embed(["test"])).rejects.toThrow("after 3 retries")
    expect(attempts).toBe(3)
    // 429 on last attempt: the retryable-status handler records embeddingErrors AND throws,
    // then the catch block also records embeddingErrors on the last attempt = 2 total
    expect(Metrics.get("embeddingErrors")).toBe(2)
  }, 30000)

  test("retries on 500 and succeeds on third attempt", async () => {
    let attempts = 0
    mockFetch(async () => {
      attempts++
      if (attempts < 3) return new Response("server error", { status: 500 })
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1.0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    const provider = createProvider({ apiKey: "test-key" })
    const result = await provider.embed(["test"])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual([1.0])
    expect(attempts).toBe(3)
  }, 30000)

  test("retries on network error and records metric on exhaustion", async () => {
    mockFetch(async () => {
      throw new Error("network error")
    })

    const provider = createProvider({ apiKey: "test-key" })
    await expect(provider.embed(["test"])).rejects.toThrow("network error")
    expect(Metrics.get("embeddingErrors")).toBe(1)
  }, 30000)

  test("sends dimensions in request body when overridden", async () => {
    let capturedBody: any = null
    mockFetch(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1.0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    const provider = createProvider({ apiKey: "test-key", dimensions: 256 })
    await provider.embed(["test"])
    expect(capturedBody.dimensions).toBe(256)
    expect(capturedBody.model).toBe("text-embedding-3-small")
  })

  test("omits dimensions when using default for model", async () => {
    let capturedBody: any = null
    mockFetch(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1.0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    const provider = createProvider({ apiKey: "test-key" })
    await provider.embed(["test"])
    expect(capturedBody.dimensions).toBeUndefined()
  })

  test("uses custom baseURL", async () => {
    let capturedUrl = ""
    mockFetch(async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1.0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    const provider = createProvider({ apiKey: "test-key", baseURL: "https://custom.api.com/v1" })
    await provider.embed(["test"])
    expect(capturedUrl).toBe("https://custom.api.com/v1/embeddings")
  })

  test("uses OPENAI_API_KEY from environment", async () => {
    const oldKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "env-test-key"

    let capturedAuth = ""
    mockFetch(async (_url: string, init: any) => {
      capturedAuth = init.headers?.Authorization ?? init.headers?.authorization ?? ""
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1.0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    const provider = createProvider({})
    await provider.embed(["test"])
    expect(capturedAuth).toBe("Bearer env-test-key")

    if (oldKey) process.env.OPENAI_API_KEY = oldKey
    else delete process.env.OPENAI_API_KEY
  })
})
