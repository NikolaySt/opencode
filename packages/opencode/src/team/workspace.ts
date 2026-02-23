import z from "zod"
import { Identifier } from "@/id/id"
import { Database, eq, and } from "@/storage/db"
import { WorkspaceTable } from "./team.sql"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"

export namespace Workspace {
  const log = Log.create({ service: "workspace" })

  export const Decision = z.object({
    id: z.string(),
    description: z.string(),
    rationale: z.string(),
    alternatives: z.string().array(),
    made_by: z.string(),
    reviewed_by: z.string().array().optional(),
    status: z.enum(["proposed", "approved", "rejected"]),
    timestamp: z.number(),
  })
  export type Decision = z.infer<typeof Decision>

  export const Question = z.object({
    id: z.string(),
    question: z.string(),
    asked_by: z.string(),
    routed_to: z.string().optional(),
    answer: z.string().optional(),
    answered_by: z.string().optional(),
    status: z.enum(["open", "answered", "escalated"]),
  })
  export type Question = z.infer<typeof Question>

  export const Task = z.object({
    id: z.string(),
    description: z.string(),
    assigned_to: z.string().optional(),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    dependencies: z.string().array(),
  })
  export type Task = z.infer<typeof Task>

  export const SECTIONS = [
    "goal",
    "constraints",
    "plan",
    "tasks",
    "decisions",
    "questions",
    "artifacts",
    "agent_states",
  ] as const

  export type Section = (typeof SECTIONS)[number]

  export const Event = {
    Updated: BusEvent.define(
      "workspace.updated",
      z.object({
        teamSessionID: z.string(),
        section: z.string(),
        updatedBy: z.string().optional(),
      }),
    ),
  }

  export function create(teamSessionID: string, goal: string) {
    const now = Date.now()
    Database.use((db) => {
      const sections: Array<{ section: Section; content: unknown }> = [
        { section: "goal", content: goal },
        { section: "constraints", content: [] },
        { section: "plan", content: { status: "draft", architecture: null, tasks: [], dependencies: [] } },
        { section: "tasks", content: [] },
        { section: "decisions", content: [] },
        { section: "questions", content: [] },
        { section: "artifacts", content: {} },
        { section: "agent_states", content: {} },
      ]
      for (const s of sections) {
        db.insert(WorkspaceTable)
          .values({
            id: Identifier.ascending("workspace"),
            team_session_id: teamSessionID,
            section: s.section,
            content: s.content,
            version: 1,
            time_created: now,
            time_updated: now,
          })
          .run()
      }
    })
    log.info("created", { teamSessionID })
  }

  export function get(teamSessionID: string, section: Section): unknown {
    return Database.use((db) => {
      const row = db
        .select()
        .from(WorkspaceTable)
        .where(and(eq(WorkspaceTable.team_session_id, teamSessionID), eq(WorkspaceTable.section, section)))
        .get()
      return row?.content
    })
  }

  export function set(teamSessionID: string, section: Section, content: unknown, updatedBy?: string) {
    Database.use((db) => {
      const row = db
        .select()
        .from(WorkspaceTable)
        .where(and(eq(WorkspaceTable.team_session_id, teamSessionID), eq(WorkspaceTable.section, section)))
        .get()
      if (!row) return
      db.update(WorkspaceTable)
        .set({
          content,
          last_updated_by: updatedBy,
          version: row.version + 1,
          time_updated: Date.now(),
        })
        .where(eq(WorkspaceTable.id, row.id))
        .run()
      Database.effect(() => Bus.publish(Event.Updated, { teamSessionID, section, updatedBy }))
    })
  }

  export function append(teamSessionID: string, section: Section, item: unknown, updatedBy?: string) {
    const current = get(teamSessionID, section)
    if (!Array.isArray(current)) return
    set(teamSessionID, section, [...current, item], updatedBy)
  }

  /** Remove an item from an array section by matching a key field */
  export function remove(
    teamSessionID: string,
    section: Section,
    matchKey: string,
    matchValue: unknown,
    updatedBy?: string,
  ) {
    const current = get(teamSessionID, section)
    if (!Array.isArray(current)) return
    const filtered = current.filter((item: Record<string, unknown>) => item[matchKey] !== matchValue)
    if (filtered.length !== current.length) {
      set(teamSessionID, section, filtered, updatedBy)
    }
  }

  export function addDecision(teamSessionID: string, decision: Omit<Decision, "id" | "timestamp">) {
    const full: Decision = {
      ...decision,
      id: Identifier.ascending("workspace"),
      timestamp: Date.now(),
    }
    append(teamSessionID, "decisions", full, decision.made_by)
    return full
  }

  export function addQuestion(teamSessionID: string, question: Omit<Question, "id">) {
    const full: Question = {
      ...question,
      id: Identifier.ascending("workspace"),
    }
    append(teamSessionID, "questions", full, question.asked_by)
    return full
  }

  export function answerQuestion(teamSessionID: string, questionID: string, answer: string, answeredBy: string) {
    const questions = get(teamSessionID, "questions") as Question[]
    if (!questions) return
    const updated = questions.map((q) =>
      q.id === questionID ? { ...q, answer, answered_by: answeredBy, status: "answered" as const } : q,
    )
    set(teamSessionID, "questions", updated, answeredBy)
  }

  export function openQuestions(teamSessionID: string): Question[] {
    const questions = get(teamSessionID, "questions") as Question[] | undefined
    if (!questions) return []
    return questions.filter((q) => q.status === "open")
  }

  export function all(teamSessionID: string): Record<Section, unknown> {
    const result = {} as Record<Section, unknown>
    for (const section of SECTIONS) {
      result[section] = get(teamSessionID, section)
    }
    return result
  }

  export function summary(teamSessionID: string): string {
    const data = all(teamSessionID)
    const parts: string[] = []

    parts.push(`## Goal\n${data.goal}`)

    const constraints = data.constraints as string[]
    if (constraints?.length) {
      parts.push(`## Constraints\n${constraints.map((c) => `- ${c}`).join("\n")}`)
    }

    const plan = data.plan as { status: string; architecture?: string } | undefined
    if (plan) {
      parts.push(`## Plan (${plan.status})${plan.architecture ? `\n${plan.architecture}` : ""}`)
    }

    const tasks = data.tasks as Task[]
    if (tasks?.length) {
      parts.push(
        `## Tasks\n${tasks.map((t) => `- [${t.status}] ${t.description}${t.assigned_to ? ` (@${t.assigned_to})` : ""}`).join("\n")}`,
      )
    }

    const decisions = data.decisions as Decision[]
    if (decisions?.length) {
      parts.push(
        `## Decisions\n${decisions.map((d) => `- [${d.status}] ${d.description} (by ${d.made_by}): ${d.rationale}`).join("\n")}`,
      )
    }

    const questions = data.questions as Question[]
    const open = questions?.filter((q) => q.status === "open")
    if (open?.length) {
      parts.push(
        `## Open Questions\n${open.map((q) => `- ${q.question} (asked by ${q.asked_by}${q.routed_to ? `, routed to ${q.routed_to}` : ""})`).join("\n")}`,
      )
    }

    return parts.join("\n\n")
  }
}
