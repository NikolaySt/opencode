/**
 * Session Summary Extraction
 *
 * Extracts reusable knowledge from completed sessions and stores
 * it as searchable memory entries. Two modes:
 *
 * - "title": Lightweight — stores the session title as-is (zero LLM cost)
 * - "llm": Uses a configurable LLM to analyze session messages and
 *   extract structured knowledge (decisions, root causes, patterns)
 *
 * After each session ends (via session.archived hook):
 * 1. Read session messages (compaction summary or last messages)
 * 2. Extract knowledge (title-only or LLM-based)
 * 3. Store as summaries with truth_state: 'candidate'
 * 4. Index as searchable chunks with entity tags
 */

import { Log } from "../util/log"
import { serialize } from "./embed"
import { extract as extractEntities } from "./entity"
import type { Store } from "./store"
import type { EmbeddingProvider } from "./embed"
import type { ChunkRow } from "./schema"
import * as Metrics from "./metrics"

const log = Log.create({ service: "memory.extract" })

export const EXTRACTION_PROMPT = `You are a knowledge extraction system. Given the following session context, extract reusable knowledge that would be valuable in future coding sessions.

Extract:
- Architecture decisions made and their rationale
- Conventions established (naming, file structure, patterns)
- Bug fixes and their root causes
- API contracts or interfaces discovered
- File structure patterns and organization
- Technology choices and configuration details
- Important caveats or gotchas encountered

Rules:
- Return ONLY facts that would be useful in future sessions
- Format as a markdown list with clear, concise items
- Each item should be self-contained (understandable without session context)
- Return "NONE" if nothing is worth remembering
- Maximum 15 items

Session context:
`

/**
 * Extract and store knowledge from a session.
 *
 * In "llm" mode, uses a generate function to analyze session content.
 * In "title" mode, stores the session title directly.
 */
export async function extract(params: {
  store: Store
  provider: EmbeddingProvider
  sessionID: string
  projectID: string
  summary: string
  mode: "title" | "llm"
  entityMode: "regex" | "llm"
  generate?: (prompt: string) => Promise<string>
  ignoredEntities?: Set<string>
}): Promise<boolean> {
  let knowledge = params.summary

  log.debug("extract: starting", {
    session: params.sessionID,
    mode: params.mode,
    entityMode: params.entityMode,
    summaryLength: params.summary.length,
  })

  // In LLM mode, run extraction prompt on the summary/messages
  if (params.mode === "llm" && params.generate && params.summary.trim()) {
    try {
      log.debug("extract: calling LLM for extraction", { session: params.sessionID })
      const response = await params.generate(EXTRACTION_PROMPT + params.summary)
      log.debug("extract: LLM response received", { session: params.sessionID, responseLength: response.length })
      if (response.trim() && response.trim() !== "NONE") {
        knowledge = response.trim()
      }
    } catch (err) {
      log.warn("LLM extraction failed, using raw summary", { session: params.sessionID, error: String(err) })
    }
  }

  if (!knowledge.trim() || knowledge.trim() === "NONE") {
    log.info("no extractable knowledge", { session: params.sessionID })
    Metrics.record("extractionEmpty")
    return false
  }

  const id = `summary:${params.sessionID}`
  const now = Date.now()

  // Store the summary
  params.store.upsertSummary({
    id,
    session_id: params.sessionID,
    project_id: params.projectID,
    content: knowledge,
    truth_state: "candidate",
    created_at: now,
  })

  // Extract entities from the knowledge text
  log.debug("extract: extracting entities", { session: params.sessionID, entityMode: params.entityMode })
  const entities = await extractEntities(knowledge, params.entityMode, params.generate, params.ignoredEntities)
  log.debug("extract: entities found", { session: params.sessionID, count: entities.length })

  // Index as a searchable chunk
  try {
    log.debug("extract: embedding summary", { session: params.sessionID })
    const [embedding] = await params.provider.embed([knowledge])
    log.debug("extract: embedding complete", { session: params.sessionID, hasEmbedding: !!embedding })
    if (embedding) {
      const hasher = new Bun.CryptoHasher("sha256")
      hasher.update(knowledge)
      const hash = hasher.digest("hex")
      const blob = serialize(embedding)

      const row: ChunkRow = {
        id,
        path: `sessions/${params.sessionID}`,
        source: "sessions",
        start_line: 1,
        end_line: knowledge.split("\n").length,
        hash,
        text: knowledge,
        embedding: blob,
        truth_state: "candidate",
        confidence: 0.7,
        created_at: now,
        updated_at: now,
        embedding_model: params.provider.model(),
        last_validated_at: null,
      }

      // upsertChunk handles FTS insertion internally
      params.store.upsertChunk(row)

      // Store entity tags
      if (entities.length > 0) {
        params.store.upsertEntities(id, entities)
      }

      // Cache the embedding
      params.store.cacheEmbedding({
        hash,
        embedding: blob,
        model: params.provider.model(),
        dims: params.provider.dimensions(),
        updated_at: now,
      })
    }
  } catch (err) {
    log.warn("failed to embed session summary", { session: params.sessionID, error: String(err) })
  }

  Metrics.record("extractions")
  Metrics.record(params.mode === "llm" ? "extractionLLM" : "extractionTitle")

  log.info("extracted session knowledge", {
    session: params.sessionID,
    id,
    mode: params.mode,
    entities: entities.length,
  })
  return true
}
