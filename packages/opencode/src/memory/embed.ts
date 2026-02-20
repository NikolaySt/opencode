/**
 * Embedding Provider Abstraction
 *
 * Defines the interface for embedding providers and provides
 * a registry for selecting the active provider at runtime.
 */

export type EmbeddingProvider = {
  embed(texts: string[]): Promise<number[][]>
  dimensions(): number
  model(): string
}

const providers = new Map<string, (config?: Record<string, unknown>) => EmbeddingProvider>()

export function register(name: string, factory: (config?: Record<string, unknown>) => EmbeddingProvider) {
  providers.set(name, factory)
}

export function create(name: string, config?: Record<string, unknown>): EmbeddingProvider {
  const factory = providers.get(name)
  if (!factory) throw new Error(`embedding provider not found: ${name}. Available: ${[...providers.keys()].join(", ")}`)
  return factory(config)
}

export function available(): string[] {
  return [...providers.keys()]
}

/**
 * Cosine similarity between two vectors.
 * Returns 0 for mismatched dimensions or zero-norm vectors.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// =========================================================================
// Serialization helpers for BLOB storage
// =========================================================================

/**
 * Serialize a float64 embedding array to a compact binary Buffer.
 * 8 bytes per dimension vs ~18 chars per dimension in JSON.
 */
export function serialize(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 8)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let i = 0; i < embedding.length; i++) {
    view.setFloat64(i * 8, embedding[i], true)
  }
  return buf
}

/**
 * Deserialize a binary buffer back to a float64 embedding array.
 * Accepts Buffer or Uint8Array (bun:sqlite returns Uint8Array for BLOB).
 */
export function deserialize(buf: Buffer | Uint8Array | null): number[] {
  if (!buf || buf.length === 0) return []
  if (buf.length % 8 !== 0) throw new Error(`corrupted embedding blob: length ${buf.length} is not divisible by 8`)
  const count = buf.length / 8
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const result = new Array<number>(count)
  for (let i = 0; i < count; i++) {
    result[i] = view.getFloat64(i * 8, true)
  }
  return result
}
