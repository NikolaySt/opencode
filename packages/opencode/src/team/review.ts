import z from "zod"
import { Identifier } from "@/id/id"
import { Database, eq, and } from "@/storage/db"
import { ReviewThreadTable } from "./team.sql"
import { TeamMessage } from "./message"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"

export namespace Review {
  const log = Log.create({ service: "review" })

  export const Status = z.enum(["active", "approved", "needs_revision", "escalated"])
  export type Status = z.infer<typeof Status>

  export const Info = z.object({
    id: z.string(),
    teamSessionID: z.string(),
    artifactRef: z.string(),
    authorRole: z.string(),
    reviewerRole: z.string(),
    status: Status,
    round: z.number(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Started: BusEvent.define("team.review.started", z.object({ info: Info })),
    Completed: BusEvent.define("team.review.completed", z.object({ info: Info })),
    Escalated: BusEvent.define("team.review.escalated", z.object({ info: Info, reason: z.string() })),
  }

  function fromRow(row: typeof ReviewThreadTable.$inferSelect): Info {
    return {
      id: row.id,
      teamSessionID: row.team_session_id,
      artifactRef: row.artifact_ref,
      authorRole: row.author_role,
      reviewerRole: row.reviewer_role,
      status: row.status,
      round: row.round,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  export function create(input: {
    teamSessionID: string
    artifactRef: string
    authorRole: string
    reviewerRole: string
  }): Info {
    const now = Date.now()
    const id = Identifier.ascending("review")

    const info: Info = {
      id,
      teamSessionID: input.teamSessionID,
      artifactRef: input.artifactRef,
      authorRole: input.authorRole,
      reviewerRole: input.reviewerRole,
      status: "active",
      round: 0,
      time: { created: now, updated: now },
    }

    Database.use((db) => {
      db.insert(ReviewThreadTable)
        .values({
          id: info.id,
          team_session_id: info.teamSessionID,
          artifact_ref: info.artifactRef,
          author_role: info.authorRole,
          reviewer_role: info.reviewerRole,
          status: info.status,
          round: info.round,
          time_created: now,
          time_updated: now,
        })
        .run()
      Database.effect(() => Bus.publish(Event.Started, { info }))
    })

    log.info("created", { id, author: input.authorRole, reviewer: input.reviewerRole })
    return info
  }

  export function get(reviewID: string): Info | undefined {
    return Database.use((db) => {
      const row = db.select().from(ReviewThreadTable).where(eq(ReviewThreadTable.id, reviewID)).get()
      if (!row) return undefined
      return fromRow(row)
    })
  }

  export function listActive(teamSessionID: string): Info[] {
    return Database.use((db) => {
      const rows = db
        .select()
        .from(ReviewThreadTable)
        .where(and(eq(ReviewThreadTable.team_session_id, teamSessionID), eq(ReviewThreadTable.status, "active")))
        .all()
      return rows.map(fromRow)
    })
  }

  export function listAll(teamSessionID: string): Info[] {
    return Database.use((db) => {
      const rows = db.select().from(ReviewThreadTable).where(eq(ReviewThreadTable.team_session_id, teamSessionID)).all()
      return rows.map(fromRow)
    })
  }

  export function incrementRound(reviewID: string): Info | undefined {
    return Database.use((db) => {
      const current = db.select().from(ReviewThreadTable).where(eq(ReviewThreadTable.id, reviewID)).get()
      if (!current) return undefined
      const row = db
        .update(ReviewThreadTable)
        .set({
          round: current.round + 1,
          status: "needs_revision",
          time_updated: Date.now(),
        })
        .where(eq(ReviewThreadTable.id, reviewID))
        .returning()
        .get()
      if (!row) return undefined
      return fromRow(row)
    })
  }

  export function approve(reviewID: string): Info | undefined {
    return Database.use((db) => {
      const row = db
        .update(ReviewThreadTable)
        .set({ status: "approved", time_updated: Date.now() })
        .where(eq(ReviewThreadTable.id, reviewID))
        .returning()
        .get()
      if (!row) return undefined
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Completed, { info }))
      log.info("approved", { id: reviewID })
      return info
    })
  }

  export function escalate(reviewID: string, reason: string): Info | undefined {
    return Database.use((db) => {
      const row = db
        .update(ReviewThreadTable)
        .set({ status: "escalated", time_updated: Date.now() })
        .where(eq(ReviewThreadTable.id, reviewID))
        .returning()
        .get()
      if (!row) return undefined
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Escalated, { info, reason }))
      log.info("escalated", { id: reviewID, reason })
      return info
    })
  }

  /** Record a critique from the reviewer as a team message linked to this review */
  export function addCritique(input: {
    teamSessionID: string
    reviewID: string
    reviewerRole: string
    authorRole: string
    content: string
  }) {
    TeamMessage.send({
      teamSessionID: input.teamSessionID,
      fromRole: input.reviewerRole,
      toRole: input.authorRole,
      type: "critique",
      content: input.content,
      refs: [input.reviewID],
    })
  }

  /** Record a revision from the author as a team message linked to this review */
  export function addRevision(input: {
    teamSessionID: string
    reviewID: string
    authorRole: string
    reviewerRole: string
    content: string
  }) {
    TeamMessage.send({
      teamSessionID: input.teamSessionID,
      fromRole: input.authorRole,
      toRole: input.reviewerRole,
      type: "artifact",
      content: input.content,
      refs: [input.reviewID],
    })
  }

  /** Get all critiques and revisions for a review thread (ordered by time) */
  export function history(teamSessionID: string, reviewID: string): TeamMessage.Info[] {
    const all = TeamMessage.recent(teamSessionID, 100)
    return all.filter((m) => m.refs?.includes(reviewID))
  }
}
