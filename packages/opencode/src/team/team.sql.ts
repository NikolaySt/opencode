import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

export const TeamSessionTable = sqliteTable(
  "team_session",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    goal: text().notNull(),
    phase: text().notNull().$type<"understanding" | "design" | "implementation" | "verification" | "complete">(),
    status: text().notNull().$type<"active" | "waiting_user" | "complete" | "cancelled">(),
    sharing_strategy: text().notNull().$type<"selective" | "hierarchical" | "broadcast">(),
    ...Timestamps,
  },
  (table) => [index("team_session_project_idx").on(table.project_id)],
)

export const WorkspaceTable = sqliteTable(
  "workspace",
  {
    id: text().primaryKey(),
    team_session_id: text()
      .notNull()
      .references(() => TeamSessionTable.id, { onDelete: "cascade" }),
    section: text().notNull(),
    content: text({ mode: "json" }).notNull().$type<unknown>(),
    last_updated_by: text(),
    version: integer()
      .notNull()
      .$default(() => 1),
    ...Timestamps,
  },
  (table) => [index("workspace_session_section_idx").on(table.team_session_id, table.section)],
)

export const AgentInstanceTable = sqliteTable(
  "agent_instance",
  {
    id: text().primaryKey(),
    team_session_id: text()
      .notNull()
      .references(() => TeamSessionTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id),
    role: text().notNull(),
    prompt: text().notNull(),
    expertise: text({ mode: "json" }).notNull().$type<string[]>(),
    workspace_read: text({ mode: "json" }).notNull().$type<string[]>(),
    workspace_write: text({ mode: "json" }).notNull().$type<string[]>(),
    relationships: text({ mode: "json" }).notNull().$type<{
      reports_to?: string
      collaborates_with: string[]
      reviews: string[]
      reviewed_by: string[]
    }>(),
    status: text().notNull().$type<"idle" | "working" | "waiting" | "retired">(),
    steps_used: integer()
      .notNull()
      .$default(() => 0),
    tokens_consumed: integer()
      .notNull()
      .$default(() => 0),
    ...Timestamps,
  },
  (table) => [index("agent_instance_team_idx").on(table.team_session_id)],
)

export const TeamMessageTable = sqliteTable(
  "team_message",
  {
    id: text().primaryKey(),
    team_session_id: text()
      .notNull()
      .references(() => TeamSessionTable.id, { onDelete: "cascade" }),
    from_role: text().notNull(),
    to_role: text(),
    type: text()
      .notNull()
      .$type<
        | "proposal"
        | "critique"
        | "question"
        | "answer"
        | "decision"
        | "handoff"
        | "status"
        | "artifact"
        | "spawn_request"
        | "escalation"
      >(),
    content: text().notNull(),
    ref_ids: text({ mode: "json" }).$type<string[]>(),
    workspace_mutations: text({ mode: "json" }).$type<
      Array<{
        section: string
        operation: "set" | "append" | "update" | "remove"
        path: string
        value: unknown
      }>
    >(),
    ...Timestamps,
  },
  (table) => [index("team_message_session_idx").on(table.team_session_id, table.time_created)],
)

export const ReviewThreadTable = sqliteTable(
  "review_thread",
  {
    id: text().primaryKey(),
    team_session_id: text()
      .notNull()
      .references(() => TeamSessionTable.id, { onDelete: "cascade" }),
    artifact_ref: text().notNull(),
    author_role: text().notNull(),
    reviewer_role: text().notNull(),
    status: text().notNull().$type<"active" | "approved" | "needs_revision" | "escalated">(),
    round: integer()
      .notNull()
      .$default(() => 0),
    ...Timestamps,
  },
  (table) => [index("review_thread_session_idx").on(table.team_session_id)],
)
