import z from "zod"
import { Identifier } from "@/id/id"
import { Database, eq } from "@/storage/db"
import { TeamSessionTable } from "./team.sql"
import { Workspace } from "./workspace"
import { Roster } from "./roster"
import { TeamMessage } from "./message"
import { Session } from "@/session"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"

// Lazy import to break circular dependency:
// orchestrator.ts -> prompt.ts -> registry.ts -> team.ts -> team/index.ts -> orchestrator.ts
function orchestrator() {
  return require("./orchestrator").Orchestrator as typeof import("./orchestrator").Orchestrator
}

export namespace Team {
  const log = Log.create({ service: "team" })

  // Defined inline (not re-exported from Orchestrator) to avoid circular dependency
  export const Phase = z.enum(["understanding", "design", "implementation", "verification", "complete"])
  export type Phase = z.infer<typeof Phase>

  export const Status = z.enum(["active", "waiting_user", "complete", "cancelled"])
  export type Status = z.infer<typeof Status>

  export const Info = z.object({
    id: z.string(),
    projectID: z.string(),
    goal: z.string(),
    phase: Phase,
    status: Status,
    sharingStrategy: z.enum(["selective", "hierarchical", "broadcast"]),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Created: BusEvent.define("team.created", z.object({ info: Info })),
    Updated: BusEvent.define("team.updated", z.object({ info: Info })),
    Completed: BusEvent.define("team.completed", z.object({ info: Info, summary: z.string() })),
  }

  function fromRow(row: typeof TeamSessionTable.$inferSelect): Info {
    return {
      id: row.id,
      projectID: row.project_id,
      goal: row.goal,
      phase: row.phase,
      status: row.status,
      sharingStrategy: row.sharing_strategy,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  export async function create(input: {
    goal: string
    sharingStrategy?: "selective" | "hierarchical" | "broadcast"
  }): Promise<Info> {
    const now = Date.now()
    const id = Identifier.descending("team")
    const strategy = input.sharingStrategy ?? "selective"

    const info: Info = {
      id,
      projectID: Instance.project.id,
      goal: input.goal,
      phase: "understanding",
      status: "active",
      sharingStrategy: strategy,
      time: { created: now, updated: now },
    }

    Database.use((db) => {
      db.insert(TeamSessionTable)
        .values({
          id: info.id,
          project_id: info.projectID,
          goal: info.goal,
          phase: info.phase,
          status: info.status,
          sharing_strategy: info.sharingStrategy,
          time_created: now,
          time_updated: now,
        })
        .run()
      Database.effect(() => Bus.publish(Event.Created, { info }))
    })

    // Initialize workspace
    Workspace.create(id, input.goal)

    log.info("team session created", { id, goal: input.goal })
    return info
  }

  export function get(teamSessionID: string): Info | undefined {
    return Database.use((db) => {
      const row = db.select().from(TeamSessionTable).where(eq(TeamSessionTable.id, teamSessionID)).get()
      if (!row) return undefined
      return fromRow(row)
    })
  }

  function setPhase(teamSessionID: string, phase: Phase) {
    Database.use((db) => {
      db.update(TeamSessionTable)
        .set({ phase, time_updated: Date.now() })
        .where(eq(TeamSessionTable.id, teamSessionID))
        .run()
    })
  }

  function setStatus(teamSessionID: string, status: Status) {
    Database.use((db) => {
      const row = db
        .update(TeamSessionTable)
        .set({ status, time_updated: Date.now() })
        .where(eq(TeamSessionTable.id, teamSessionID))
        .returning()
        .get()
      if (row) {
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
      }
    })
  }

  export async function start(input: {
    goal: string
    sharingStrategy?: "selective" | "hierarchical" | "broadcast"
    parentSessionID?: string
    onEscalate: (question: string) => Promise<string>
    onStatus?: (message: string) => void
    abort?: AbortSignal
  }): Promise<{ teamSession: Info; summary: string }> {
    const teamSession = await create({ goal: input.goal, sharingStrategy: input.sharingStrategy })

    // Create a session for the orchestrator itself (child of calling session)
    const orchestratorSession = await Session.create({
      parentID: input.parentSessionID,
      title: `Team orchestrator: ${input.goal.slice(0, 50)}`,
    })

    let summary = ""

    await orchestrator().run({
      teamSessionID: teamSession.id,
      orchestratorSessionID: orchestratorSession.id,
      parentSessionID: input.parentSessionID,
      goal: input.goal,
      phase: teamSession.phase,
      sharingStrategy: input.sharingStrategy,
      abort: input.abort,
      onEscalate: async (question: string) => {
        setStatus(teamSession.id, "waiting_user")
        const answer = await input.onEscalate(question)
        setStatus(teamSession.id, "active")
        return answer
      },
      onPhaseChange: (phase: Phase) => {
        setPhase(teamSession.id, phase)
        input.onStatus?.(`Phase: ${phase}`)
      },
      onComplete: (s: string) => {
        summary = s
        setStatus(teamSession.id, "complete")
        setPhase(teamSession.id, "complete")
      },
    })

    const final = get(teamSession.id) ?? teamSession
    if (final.status !== "complete") {
      setStatus(teamSession.id, "complete")
    }

    Bus.publish(Event.Completed, { info: final, summary })
    return { teamSession: final, summary }
  }

  export function cancel(teamSessionID: string) {
    const roster = Roster.list(teamSessionID)
    for (const agent of roster) {
      Roster.retire(agent.id)
    }
    setStatus(teamSessionID, "cancelled")
  }

  export function status(teamSessionID: string) {
    const info = get(teamSessionID)
    if (!info) return undefined
    const roster = Roster.list(teamSessionID)
    const messages = TeamMessage.recent(teamSessionID, 10)
    const questions = Workspace.openQuestions(teamSessionID)
    const summary = Workspace.summary(teamSessionID)

    // Extract file changes and commands from workspace artifacts
    const artifacts = (Workspace.get(teamSessionID, "artifacts") as Record<string, unknown>) ?? {}
    const modifiedFiles = (artifacts.modified_files as string[]) ?? []
    const commandsRun = (artifacts.commands_run as Array<{ command: string; output: string; title: string }>) ?? []

    return {
      info,
      roster: roster.map((a) => ({ role: a.role, status: a.status, expertise: a.expertise })),
      recentActivity: messages.map((m) => ({
        type: m.type,
        from: m.fromRole,
        to: m.toRole,
        content: m.content.slice(0, 100),
      })),
      openQuestions: questions,
      workspaceSummary: summary,
      modifiedFiles,
      commandsRun,
    }
  }
}
