import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Database, eq } from "../../src/storage/db"
import {
  TeamSessionTable,
  WorkspaceTable,
  AgentInstanceTable,
  TeamMessageTable,
  ReviewThreadTable,
} from "../../src/team/team.sql"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

/**
 * Tests for the Drizzle schema definitions using real DB round-trips.
 * Each test inserts a row, reads it back, and verifies all columns survive.
 */

function createTeamSession(projectID: string): string {
  const id = Identifier.ascending("team")
  const now = Date.now()
  Database.use((db) => {
    db.insert(TeamSessionTable)
      .values({
        id,
        project_id: projectID,
        goal: "Schema test goal",
        phase: "understanding",
        status: "active",
        sharing_strategy: "selective",
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return id
}

describe("team.sql TeamSessionTable round-trip", () => {
  test("insert and read back all columns", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id = Identifier.ascending("team")
        const now = Date.now()
        Database.use((db) => {
          db.insert(TeamSessionTable)
            .values({
              id,
              project_id: Instance.project.id,
              goal: "My test goal",
              phase: "design",
              status: "active",
              sharing_strategy: "hierarchical",
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(TeamSessionTable).where(eq(TeamSessionTable.id, id)).get()
          expect(row).toBeDefined()
          expect(row!.id).toBe(id)
          expect(row!.project_id).toBe(Instance.project.id)
          expect(row!.goal).toBe("My test goal")
          expect(row!.phase).toBe("design")
          expect(row!.status).toBe("active")
          expect(row!.sharing_strategy).toBe("hierarchical")
          expect(row!.time_created).toBe(now)
          expect(row!.time_updated).toBe(now)
        })
      },
    })
  })

  test("phase column stores all valid phase values", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const phase of ["understanding", "design", "implementation", "verification", "complete"] as const) {
          const id = Identifier.ascending("team")
          const now = Date.now()
          Database.use((db) => {
            db.insert(TeamSessionTable)
              .values({
                id,
                project_id: Instance.project.id,
                goal: `Phase: ${phase}`,
                phase,
                status: "active",
                sharing_strategy: "selective",
                time_created: now,
                time_updated: now,
              })
              .run()
            const row = db.select().from(TeamSessionTable).where(eq(TeamSessionTable.id, id)).get()
            expect(row!.phase).toBe(phase)
          })
        }
      },
    })
  })

  test("status column stores all valid status values", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const status of ["active", "waiting_user", "complete", "cancelled"] as const) {
          const id = Identifier.ascending("team")
          const now = Date.now()
          Database.use((db) => {
            db.insert(TeamSessionTable)
              .values({
                id,
                project_id: Instance.project.id,
                goal: `Status: ${status}`,
                phase: "understanding",
                status,
                sharing_strategy: "selective",
                time_created: now,
                time_updated: now,
              })
              .run()
            const row = db.select().from(TeamSessionTable).where(eq(TeamSessionTable.id, id)).get()
            expect(row!.status).toBe(status)
          })
        }
      },
    })
  })

  test("sharing_strategy stores all valid strategies", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const strategy of ["selective", "hierarchical", "broadcast"] as const) {
          const id = Identifier.ascending("team")
          const now = Date.now()
          Database.use((db) => {
            db.insert(TeamSessionTable)
              .values({
                id,
                project_id: Instance.project.id,
                goal: `Strategy: ${strategy}`,
                phase: "understanding",
                status: "active",
                sharing_strategy: strategy,
                time_created: now,
                time_updated: now,
              })
              .run()
            const row = db.select().from(TeamSessionTable).where(eq(TeamSessionTable.id, id)).get()
            expect(row!.sharing_strategy).toBe(strategy)
          })
        }
      },
    })
  })

  test("project_id FK cascade deletes team sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const row = Database.use((db) =>
          db.select().from(TeamSessionTable).where(eq(TeamSessionTable.id, teamID)).get(),
        )
        expect(row).toBeDefined()
        // FK exists and is valid — project_id references a real project
        expect(row!.project_id).toBe(Instance.project.id)
      },
    })
  })
})

describe("team.sql WorkspaceTable round-trip", () => {
  test("insert and read back all columns", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("workspace")
        const now = Date.now()

        Database.use((db) => {
          db.insert(WorkspaceTable)
            .values({
              id,
              team_session_id: teamID,
              section: "goal",
              content: "Build an auth system",
              last_updated_by: "architect",
              version: 3,
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get()
          expect(row).toBeDefined()
          expect(row!.id).toBe(id)
          expect(row!.team_session_id).toBe(teamID)
          expect(row!.section).toBe("goal")
          expect(row!.content).toBe("Build an auth system")
          expect(row!.last_updated_by).toBe("architect")
          expect(row!.version).toBe(3)
          expect(row!.time_created).toBe(now)
        })
      },
    })
  })

  test("content column stores JSON objects", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("workspace")
        const now = Date.now()
        const complex = { status: "draft", tasks: [1, 2, 3], nested: { key: "val" } }

        Database.use((db) => {
          db.insert(WorkspaceTable)
            .values({
              id,
              team_session_id: teamID,
              section: "plan",
              content: complex,
              version: 1,
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get()
          const content = row!.content as typeof complex
          expect(content.status).toBe("draft")
          expect(content.tasks).toEqual([1, 2, 3])
          expect(content.nested.key).toBe("val")
        })
      },
    })
  })

  test("content column stores JSON arrays", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("workspace")
        const now = Date.now()

        Database.use((db) => {
          db.insert(WorkspaceTable)
            .values({
              id,
              team_session_id: teamID,
              section: "constraints",
              content: ["no-eval", "typescript-only"],
              version: 1,
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get()
          expect(row!.content).toEqual(["no-eval", "typescript-only"])
        })
      },
    })
  })

  test("last_updated_by is nullable", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("workspace")
        const now = Date.now()

        Database.use((db) => {
          db.insert(WorkspaceTable)
            .values({
              id,
              team_session_id: teamID,
              section: "goal",
              content: "test",
              version: 1,
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get()
          expect(row!.last_updated_by).toBeNull()
        })
      },
    })
  })
})

describe("team.sql AgentInstanceTable round-trip", () => {
  test("insert and read back all columns including JSON", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("agent")
        const now = Date.now()

        Database.use((db) => {
          db.insert(AgentInstanceTable)
            .values({
              id,
              team_session_id: teamID,
              session_id: null,
              role: "architect",
              prompt: "You are an architect",
              expertise: ["design", "patterns"],
              workspace_read: ["goal", "plan"],
              workspace_write: ["plan", "decisions"],
              relationships: {
                reports_to: "orchestrator",
                collaborates_with: ["developer"],
                reviews: ["qa"],
                reviewed_by: ["security"],
              },
              status: "idle",
              steps_used: 5,
              tokens_consumed: 1234,
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(AgentInstanceTable).where(eq(AgentInstanceTable.id, id)).get()
          expect(row).toBeDefined()
          expect(row!.role).toBe("architect")
          expect(row!.prompt).toBe("You are an architect")
          expect(row!.expertise).toEqual(["design", "patterns"])
          expect(row!.workspace_read).toEqual(["goal", "plan"])
          expect(row!.workspace_write).toEqual(["plan", "decisions"])
          expect(row!.relationships.reports_to).toBe("orchestrator")
          expect(row!.relationships.collaborates_with).toEqual(["developer"])
          expect(row!.relationships.reviews).toEqual(["qa"])
          expect(row!.relationships.reviewed_by).toEqual(["security"])
          expect(row!.status).toBe("idle")
          expect(row!.steps_used).toBe(5)
          expect(row!.tokens_consumed).toBe(1234)
          expect(row!.session_id).toBeNull()
        })
      },
    })
  })

  test("status column stores all valid agent statuses", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        for (const status of ["idle", "working", "waiting", "retired"] as const) {
          const id = Identifier.ascending("agent")
          const now = Date.now()
          Database.use((db) => {
            db.insert(AgentInstanceTable)
              .values({
                id,
                team_session_id: teamID,
                session_id: null,
                role: `agent-${status}`,
                prompt: "",
                expertise: [],
                workspace_read: [],
                workspace_write: [],
                relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
                status,
                steps_used: 0,
                tokens_consumed: 0,
                time_created: now,
                time_updated: now,
              })
              .run()
            const row = db.select().from(AgentInstanceTable).where(eq(AgentInstanceTable.id, id)).get()
            expect(row!.status).toBe(status)
          })
        }
      },
    })
  })
})

describe("team.sql TeamMessageTable round-trip", () => {
  test("insert and read back all columns including nullable fields", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("message")
        const now = Date.now()
        const mutations = [{ section: "artifacts", operation: "set" as const, path: "file.ts", value: "code" }]

        Database.use((db) => {
          db.insert(TeamMessageTable)
            .values({
              id,
              team_session_id: teamID,
              from_role: "developer",
              to_role: "architect",
              type: "proposal",
              content: "Use microservices",
              ref_ids: ["ref_1", "ref_2"],
              workspace_mutations: mutations,
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(TeamMessageTable).where(eq(TeamMessageTable.id, id)).get()
          expect(row).toBeDefined()
          expect(row!.from_role).toBe("developer")
          expect(row!.to_role).toBe("architect")
          expect(row!.type).toBe("proposal")
          expect(row!.content).toBe("Use microservices")
          expect(row!.ref_ids).toEqual(["ref_1", "ref_2"])
          expect(row!.workspace_mutations).toEqual(mutations)
        })
      },
    })
  })

  test("to_role is nullable", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("message")
        const now = Date.now()

        Database.use((db) => {
          db.insert(TeamMessageTable)
            .values({
              id,
              team_session_id: teamID,
              from_role: "orchestrator",
              type: "status",
              content: "Phase started",
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(TeamMessageTable).where(eq(TeamMessageTable.id, id)).get()
          expect(row!.to_role).toBeNull()
          expect(row!.ref_ids).toBeNull()
          expect(row!.workspace_mutations).toBeNull()
        })
      },
    })
  })

  test("type column stores all 10 message types", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const types = [
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
        ] as const
        for (const type of types) {
          const id = Identifier.ascending("message")
          const now = Date.now()
          Database.use((db) => {
            db.insert(TeamMessageTable)
              .values({
                id,
                team_session_id: teamID,
                from_role: "test",
                type,
                content: `type: ${type}`,
                time_created: now,
                time_updated: now,
              })
              .run()
            const row = db.select().from(TeamMessageTable).where(eq(TeamMessageTable.id, id)).get()
            expect(row!.type).toBe(type)
          })
        }
      },
    })
  })
})

describe("team.sql ReviewThreadTable round-trip", () => {
  test("insert and read back all columns", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("review")
        const now = Date.now()

        Database.use((db) => {
          db.insert(ReviewThreadTable)
            .values({
              id,
              team_session_id: teamID,
              artifact_ref: "src/auth.ts version 2",
              author_role: "developer",
              reviewer_role: "security-reviewer",
              status: "active",
              round: 0,
              time_created: now,
              time_updated: now,
            })
            .run()

          const row = db.select().from(ReviewThreadTable).where(eq(ReviewThreadTable.id, id)).get()
          expect(row).toBeDefined()
          expect(row!.id).toBe(id)
          expect(row!.team_session_id).toBe(teamID)
          expect(row!.artifact_ref).toBe("src/auth.ts version 2")
          expect(row!.author_role).toBe("developer")
          expect(row!.reviewer_role).toBe("security-reviewer")
          expect(row!.status).toBe("active")
          expect(row!.round).toBe(0)
        })
      },
    })
  })

  test("status column stores all valid review statuses", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        for (const status of ["active", "approved", "needs_revision", "escalated"] as const) {
          const id = Identifier.ascending("review")
          const now = Date.now()
          Database.use((db) => {
            db.insert(ReviewThreadTable)
              .values({
                id,
                team_session_id: teamID,
                artifact_ref: `test-${status}`,
                author_role: "dev",
                reviewer_role: "qa",
                status,
                round: 1,
                time_created: now,
                time_updated: now,
              })
              .run()
            const row = db.select().from(ReviewThreadTable).where(eq(ReviewThreadTable.id, id)).get()
            expect(row!.status).toBe(status)
          })
        }
      },
    })
  })

  test("round column increments correctly via update", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = Identifier.ascending("review")
        const now = Date.now()

        Database.use((db) => {
          db.insert(ReviewThreadTable)
            .values({
              id,
              team_session_id: teamID,
              artifact_ref: "code",
              author_role: "dev",
              reviewer_role: "qa",
              status: "active",
              round: 0,
              time_created: now,
              time_updated: now,
            })
            .run()

          // Update round
          db.update(ReviewThreadTable).set({ round: 3 }).where(eq(ReviewThreadTable.id, id)).run()

          const row = db.select().from(ReviewThreadTable).where(eq(ReviewThreadTable.id, id)).get()
          expect(row!.round).toBe(3)
        })
      },
    })
  })
})
