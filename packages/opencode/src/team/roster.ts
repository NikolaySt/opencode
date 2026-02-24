import z from "zod"
import { Identifier } from "@/id/id"
import { Database, eq, and } from "@/storage/db"
import { AgentInstanceTable } from "./team.sql"
import { Session } from "@/session"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"

export namespace Roster {
  const log = Log.create({ service: "roster" })

  export const Relationships = z.object({
    reports_to: z.string().optional(),
    collaborates_with: z.string().array(),
    reviews: z.string().array(),
    reviewed_by: z.string().array(),
  })
  export type Relationships = z.infer<typeof Relationships>

  export const Status = z.enum(["idle", "working", "waiting", "retired"])
  export type Status = z.infer<typeof Status>

  export const Info = z.object({
    id: z.string(),
    teamSessionID: z.string(),
    sessionID: z.string().optional(),
    role: z.string(),
    prompt: z.string(),
    expertise: z.string().array(),
    workspaceRead: z.string().array(),
    workspaceWrite: z.string().array(),
    relationships: Relationships,
    status: Status,
    stepsUsed: z.number(),
    tokensConsumed: z.number(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Spawned: BusEvent.define("team.agent.spawned", z.object({ info: Info })),
    Retired: BusEvent.define("team.agent.retired", z.object({ info: Info })),
    Updated: BusEvent.define("team.agent.updated", z.object({ info: Info })),
  }

  function fromRow(row: typeof AgentInstanceTable.$inferSelect): Info {
    return {
      id: row.id,
      teamSessionID: row.team_session_id,
      sessionID: row.session_id ?? undefined,
      role: row.role,
      prompt: row.prompt,
      expertise: row.expertise,
      workspaceRead: row.workspace_read,
      workspaceWrite: row.workspace_write,
      relationships: row.relationships,
      status: row.status,
      stepsUsed: row.steps_used,
      tokensConsumed: row.tokens_consumed,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  export async function spawn(input: {
    teamSessionID: string
    parentSessionID?: string
    role: string
    prompt: string
    expertise: string[]
    workspaceRead: string[]
    workspaceWrite: string[]
    relationships: Relationships
  }): Promise<Info> {
    const session = await Session.create({
      parentID: input.parentSessionID,
      title: `Team agent: ${input.role}`,
    })

    const now = Date.now()
    const id = Identifier.ascending("agent")

    const info: Info = {
      id,
      teamSessionID: input.teamSessionID,
      sessionID: session.id,
      role: input.role,
      prompt: input.prompt,
      expertise: input.expertise,
      workspaceRead: input.workspaceRead,
      workspaceWrite: input.workspaceWrite,
      relationships: input.relationships,
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: now, updated: now },
    }

    Database.use((db) => {
      db.insert(AgentInstanceTable)
        .values({
          id: info.id,
          team_session_id: info.teamSessionID,
          session_id: info.sessionID,
          role: info.role,
          prompt: info.prompt,
          expertise: info.expertise,
          workspace_read: info.workspaceRead,
          workspace_write: info.workspaceWrite,
          relationships: info.relationships,
          status: info.status,
          steps_used: info.stepsUsed,
          tokens_consumed: info.tokensConsumed,
          time_created: now,
          time_updated: now,
        })
        .run()
      Database.effect(() => Bus.publish(Event.Spawned, { info }))
    })

    log.info("spawned", { role: input.role, id })
    return info
  }

  export function retire(agentID: string) {
    Database.use((db) => {
      const row = db
        .update(AgentInstanceTable)
        .set({ status: "retired", time_updated: Date.now() })
        .where(eq(AgentInstanceTable.id, agentID))
        .returning()
        .get()
      if (!row) return
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Retired, { info }))
    })
  }

  export function setStatus(agentID: string, status: Status) {
    Database.use((db) => {
      const row = db
        .update(AgentInstanceTable)
        .set({ status, time_updated: Date.now() })
        .where(eq(AgentInstanceTable.id, agentID))
        .returning()
        .get()
      if (!row) return
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
    })
  }

  export function updateMetrics(agentID: string, steps: number, tokens: number) {
    Database.use((db) => {
      db.update(AgentInstanceTable)
        .set({
          steps_used: steps,
          tokens_consumed: tokens,
          time_updated: Date.now(),
        })
        .where(eq(AgentInstanceTable.id, agentID))
        .run()
    })
  }

  export function get(teamSessionID: string, role: string): Info | undefined {
    return Database.use((db) => {
      const row = db
        .select()
        .from(AgentInstanceTable)
        .where(
          and(
            eq(AgentInstanceTable.team_session_id, teamSessionID),
            eq(AgentInstanceTable.role, role),
            // exclude retired
          ),
        )
        .get()
      if (!row) return undefined
      if (row.status === "retired") return undefined
      return fromRow(row)
    })
  }

  export function getByID(agentID: string): Info | undefined {
    return Database.use((db) => {
      const row = db.select().from(AgentInstanceTable).where(eq(AgentInstanceTable.id, agentID)).get()
      if (!row) return undefined
      return fromRow(row)
    })
  }

  export function list(teamSessionID: string): Info[] {
    return Database.use((db) => {
      const rows = db
        .select()
        .from(AgentInstanceTable)
        .where(eq(AgentInstanceTable.team_session_id, teamSessionID))
        .all()
      return rows.filter((r) => r.status !== "retired").map(fromRow)
    })
  }

  export function all(teamSessionID: string): Info[] {
    return Database.use((db) => {
      const rows = db
        .select()
        .from(AgentInstanceTable)
        .where(eq(AgentInstanceTable.team_session_id, teamSessionID))
        .all()
      return rows.map(fromRow)
    })
  }

  /**
   * Check if an agent should be retired based on activity criteria.
   * Pass activeReviewRoles to avoid circular dependency on Review module.
   */
  export function shouldRetire(
    agent: Info,
    activeReviewRoles: Array<{ authorRole: string; reviewerRole: string }>,
  ): {
    retire: boolean
    reason: string
  } {
    if (agent.status === "retired") return { retire: false, reason: "already retired" }
    if (agent.status === "working") return { retire: false, reason: "currently working" }

    const involved = activeReviewRoles.filter((r) => r.authorRole === agent.role || r.reviewerRole === agent.role)
    if (involved.length > 0) {
      return { retire: false, reason: `involved in ${involved.length} active review(s)` }
    }

    return { retire: true, reason: "no active tasks or reviews" }
  }

  /** Increment steps counter for an agent */
  export function incrementSteps(agentID: string, count = 1) {
    Database.use((db) => {
      const current = db.select().from(AgentInstanceTable).where(eq(AgentInstanceTable.id, agentID)).get()
      if (!current) return
      db.update(AgentInstanceTable)
        .set({
          steps_used: current.steps_used + count,
          time_updated: Date.now(),
        })
        .where(eq(AgentInstanceTable.id, agentID))
        .run()
    })
  }

  /** Increment tokens counter for an agent */
  export function incrementTokens(agentID: string, count: number) {
    Database.use((db) => {
      const current = db.select().from(AgentInstanceTable).where(eq(AgentInstanceTable.id, agentID)).get()
      if (!current) return
      db.update(AgentInstanceTable)
        .set({
          tokens_consumed: current.tokens_consumed + count,
          time_updated: Date.now(),
        })
        .where(eq(AgentInstanceTable.id, agentID))
        .run()
    })
  }
}
