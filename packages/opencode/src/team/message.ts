import z from "zod"
import { Identifier } from "@/id/id"
import { Database, eq, and, desc, or, isNull } from "@/storage/db"
import { TeamMessageTable } from "./team.sql"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"

export namespace TeamMessage {
  const log = Log.create({ service: "team-message" })

  export const Type = z.enum([
    "proposal",
    "critique",
    "question",
    "answer",
    "decision",
    "handoff",
    "status",
    "artifact",
    "spawn_request",
    "escalation",
  ])
  export type Type = z.infer<typeof Type>

  export const Mutation = z.object({
    section: z.string(),
    operation: z.enum(["set", "append", "update", "remove"]),
    path: z.string(),
    value: z.unknown(),
  })
  export type Mutation = z.infer<typeof Mutation>

  export const Info = z.object({
    id: z.string(),
    teamSessionID: z.string(),
    fromRole: z.string(),
    toRole: z.string().optional(),
    type: Type,
    content: z.string(),
    refs: z.string().array().optional(),
    mutations: Mutation.array().optional(),
    timestamp: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Sent: BusEvent.define("team.message", z.object({ info: Info })),
  }

  function fromRow(row: typeof TeamMessageTable.$inferSelect): Info {
    return {
      id: row.id,
      teamSessionID: row.team_session_id,
      fromRole: row.from_role,
      toRole: row.to_role ?? undefined,
      type: row.type,
      content: row.content,
      refs: row.ref_ids ?? undefined,
      mutations: row.workspace_mutations ?? undefined,
      timestamp: row.time_created,
    }
  }

  export function send(input: {
    teamSessionID: string
    fromRole: string
    toRole?: string
    type: Type
    content: string
    refs?: string[]
    mutations?: Mutation[]
  }): Info {
    const now = Date.now()
    const id = Identifier.ascending("message")
    const info: Info = {
      id,
      teamSessionID: input.teamSessionID,
      fromRole: input.fromRole,
      toRole: input.toRole,
      type: input.type,
      content: input.content,
      refs: input.refs,
      mutations: input.mutations,
      timestamp: now,
    }

    Database.use((db) => {
      db.insert(TeamMessageTable)
        .values({
          id: info.id,
          team_session_id: info.teamSessionID,
          from_role: info.fromRole,
          to_role: info.toRole,
          type: info.type,
          content: info.content,
          ref_ids: info.refs ?? null,
          workspace_mutations: info.mutations ?? null,
          time_created: now,
          time_updated: now,
        })
        .run()
      Database.effect(() => Bus.publish(Event.Sent, { info }))
    })

    log.info("sent", { type: input.type, from: input.fromRole, to: input.toRole })
    return info
  }

  export function recent(teamSessionID: string, limit = 20): Info[] {
    return Database.use((db) => {
      const rows = db
        .select()
        .from(TeamMessageTable)
        .where(eq(TeamMessageTable.team_session_id, teamSessionID))
        .orderBy(desc(TeamMessageTable.time_created))
        .limit(limit)
        .all()
      return rows.map(fromRow).reverse()
    })
  }

  export function forRole(teamSessionID: string, role: string, limit = 20): Info[] {
    return Database.use((db) => {
      const rows = db
        .select()
        .from(TeamMessageTable)
        .where(
          and(
            eq(TeamMessageTable.team_session_id, teamSessionID),
            or(
              eq(TeamMessageTable.to_role, role),
              isNull(TeamMessageTable.to_role),
              eq(TeamMessageTable.from_role, role),
            ),
          ),
        )
        .orderBy(desc(TeamMessageTable.time_created))
        .limit(limit)
        .all()
      return rows.map(fromRow).reverse()
    })
  }

  export function byType(teamSessionID: string, type: Type): Info[] {
    return Database.use((db) => {
      const rows = db
        .select()
        .from(TeamMessageTable)
        .where(and(eq(TeamMessageTable.team_session_id, teamSessionID), eq(TeamMessageTable.type, type)))
        .orderBy(TeamMessageTable.time_created)
        .all()
      return rows.map(fromRow)
    })
  }
}
