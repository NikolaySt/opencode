import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team/index"
import { Workspace } from "../../src/team/workspace"
import { Roster } from "../../src/team/roster"
import { TeamMessage } from "../../src/team/message"
import { Identifier } from "../../src/id/id"
import { Database } from "../../src/storage/db"
import { TeamSessionTable, AgentInstanceTable } from "../../src/team/team.sql"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function createTeamSessionDirect(projectID: string, opts?: { status?: string; phase?: string }): string {
  const id = Identifier.ascending("team")
  const now = Date.now()
  Database.use((db) => {
    db.insert(TeamSessionTable)
      .values({
        id,
        project_id: projectID,
        goal: "Test goal",
        phase: (opts?.phase as any) ?? "understanding",
        status: (opts?.status as any) ?? "active",
        sharing_strategy: "selective",
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return id
}

function insertAgent(teamSessionID: string, role: string): string {
  const id = Identifier.ascending("agent")
  const now = Date.now()
  Database.use((db) => {
    db.insert(AgentInstanceTable)
      .values({
        id,
        team_session_id: teamSessionID,
        session_id: null,
        role,
        prompt: `You are a ${role}`,
        expertise: ["skill"],
        workspace_read: ["goal"],
        workspace_write: ["artifacts"],
        relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
        status: "idle",
        steps_used: 0,
        tokens_consumed: 0,
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return id
}

describe("team.Team.Phase", () => {
  test("re-exports Orchestrator.Phase", () => {
    expect(Team.Phase.options).toHaveLength(5)
    expect(Team.Phase.options).toContain("understanding")
    expect(Team.Phase.options).toContain("complete")
  })
})

describe("team.Team.Status", () => {
  test("has all 4 expected statuses", () => {
    const statuses = Team.Status.options
    expect(statuses).toHaveLength(4)
    expect(statuses).toContain("active")
    expect(statuses).toContain("waiting_user")
    expect(statuses).toContain("complete")
    expect(statuses).toContain("cancelled")
  })

  test("validates valid status", () => {
    for (const s of ["active", "waiting_user", "complete", "cancelled"] as const) {
      expect(Team.Status.parse(s)).toBe(s)
    }
  })

  test("rejects invalid status", () => {
    expect(() => Team.Status.parse("invalid")).toThrow()
  })
})

describe("team.Team.Info schema", () => {
  test("validates full Info object", () => {
    const info = Team.Info.parse({
      id: "team_1",
      projectID: "proj_1",
      goal: "Build auth",
      phase: "design",
      status: "active",
      sharingStrategy: "selective",
      time: { created: 1000, updated: 2000 },
    })
    expect(info.sharingStrategy).toBe("selective")
  })

  test("validates all sharing strategies", () => {
    for (const strategy of ["selective", "hierarchical", "broadcast"] as const) {
      const info = Team.Info.parse({
        id: "t",
        projectID: "p",
        goal: "g",
        phase: "understanding",
        status: "active",
        sharingStrategy: strategy,
        time: { created: 0, updated: 0 },
      })
      expect(info.sharingStrategy).toBe(strategy)
    }
  })
})

describe("team.Team.create", () => {
  test("creates a team session with workspace and correct defaults", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await Team.create({ goal: "Build a REST API" })

        expect(info.id).toMatch(/^team_/)
        expect(info.projectID).toBe(Instance.project.id)
        expect(info.goal).toBe("Build a REST API")
        expect(info.phase).toBe("understanding")
        expect(info.status).toBe("active")
        expect(info.sharingStrategy).toBe("selective")
        expect(info.time.created).toBeGreaterThan(0)

        // Verify it was persisted to DB
        const fetched = Team.get(info.id)
        expect(fetched).toBeDefined()
        expect(fetched!.goal).toBe("Build a REST API")

        // Verify workspace was initialized
        const goal = Workspace.get(info.id, "goal")
        expect(goal).toBe("Build a REST API")
        const constraints = Workspace.get(info.id, "constraints")
        expect(constraints).toEqual([])
      },
    })
  })

  test("creates a team session with custom sharing strategy", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await Team.create({ goal: "Test", sharingStrategy: "broadcast" })

        expect(info.sharingStrategy).toBe("broadcast")
        const fetched = Team.get(info.id)
        expect(fetched!.sharingStrategy).toBe("broadcast")
      },
    })
  })
})

describe("team.Team.get", () => {
  test("retrieves team session by ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)

        const team = Team.get(teamID)
        expect(team).toBeDefined()
        expect(team!.id).toBe(teamID)
        expect(team!.goal).toBe("Test goal")
        expect(team!.phase).toBe("understanding")
        expect(team!.status).toBe("active")
      },
    })
  })

  test("returns undefined for non-existent ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Team.get("team_nonexistent")).toBeUndefined()
      },
    })
  })
})

describe("team.Team.cancel", () => {
  test("retires all agents and sets status to cancelled", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)
        insertAgent(teamID, "architect")
        insertAgent(teamID, "developer")

        expect(Roster.list(teamID)).toHaveLength(2)

        Team.cancel(teamID)

        // All agents retired
        expect(Roster.list(teamID)).toHaveLength(0)
        expect(Roster.all(teamID)).toHaveLength(2) // Still exist, just retired

        // Status is cancelled
        const team = Team.get(teamID)
        expect(team!.status).toBe("cancelled")
      },
    })
  })

  test("handles team with no agents", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)

        Team.cancel(teamID)

        const team = Team.get(teamID)
        expect(team!.status).toBe("cancelled")
      },
    })
  })
})

describe("team.Team.status", () => {
  test("returns full status report", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)
        Workspace.create(teamID, "Build auth system")
        insertAgent(teamID, "architect")
        insertAgent(teamID, "developer")

        TeamMessage.send({ teamSessionID: teamID, fromRole: "orch", type: "status", content: "Started" })

        Workspace.addQuestion(teamID, { question: "REST or gRPC?", asked_by: "dev", status: "open" })

        const status = Team.status(teamID)
        expect(status).toBeDefined()
        expect(status!.info.id).toBe(teamID)
        expect(status!.info.goal).toBe("Test goal")
        expect(status!.roster).toHaveLength(2)
        expect(status!.roster[0]).toHaveProperty("role")
        expect(status!.roster[0]).toHaveProperty("status")
        expect(status!.roster[0]).toHaveProperty("expertise")
        expect(status!.recentActivity).toHaveLength(1)
        expect(status!.recentActivity[0].from).toBe("orch")
        expect(status!.openQuestions).toHaveLength(1)
        expect(status!.workspaceSummary).toContain("Build auth system")
      },
    })
  })

  test("returns undefined for non-existent team", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Team.status("team_nonexistent")).toBeUndefined()
      },
    })
  })

  test("truncates message content to 100 chars", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)
        Workspace.create(teamID, "Test")

        const longContent = "x".repeat(200)
        TeamMessage.send({ teamSessionID: teamID, fromRole: "a", type: "status", content: longContent })

        const status = Team.status(teamID)
        expect(status!.recentActivity[0].content.length).toBe(100)
      },
    })
  })

  test("includes modifiedFiles from workspace artifacts", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "artifacts", { modified_files: ["src/auth.ts", "src/utils.ts"] }, "developer")

        const status = Team.status(teamID)
        expect(status!.modifiedFiles).toEqual(["src/auth.ts", "src/utils.ts"])
      },
    })
  })

  test("includes commandsRun from workspace artifacts", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(
          teamID,
          "artifacts",
          { commands_run: [{ command: "bun test", output: "pass", title: "Run tests" }] },
          "qa",
        )

        const status = Team.status(teamID)
        expect(status!.commandsRun).toHaveLength(1)
        expect(status!.commandsRun[0].command).toBe("bun test")
      },
    })
  })

  test("returns empty arrays when no tool activity", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)
        Workspace.create(teamID, "Test")

        const status = Team.status(teamID)
        expect(status!.modifiedFiles).toEqual([])
        expect(status!.commandsRun).toEqual([])
      },
    })
  })
})

describe("team.Team.Event", () => {
  test("Created event has correct type and validates payload", () => {
    expect(Team.Event.Created.type).toBe("team.created")
    const parsed = Team.Event.Created.properties.parse({
      info: {
        id: "team_1",
        projectID: "proj_1",
        goal: "Test",
        phase: "understanding",
        status: "active",
        sharingStrategy: "selective",
        time: { created: 0, updated: 0 },
      },
    })
    expect(parsed.info.goal).toBe("Test")
  })

  test("Updated event has correct type and validates payload", () => {
    expect(Team.Event.Updated.type).toBe("team.updated")
    const parsed = Team.Event.Updated.properties.parse({
      info: {
        id: "team_1",
        projectID: "proj_1",
        goal: "Test",
        phase: "design",
        status: "active",
        sharingStrategy: "selective",
        time: { created: 0, updated: 0 },
      },
    })
    expect(parsed.info.phase).toBe("design")
  })

  test("Completed event has correct type and validates payload", () => {
    expect(Team.Event.Completed.type).toBe("team.completed")
    const parsed = Team.Event.Completed.properties.parse({
      info: {
        id: "team_1",
        projectID: "proj_1",
        goal: "Test",
        phase: "complete",
        status: "complete",
        sharingStrategy: "selective",
        time: { created: 0, updated: 0 },
      },
      summary: "All done",
    })
    expect(parsed.summary).toBe("All done")
  })

  test("Created event fires during Team.create()", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let received = false
        const unsub = Bus.subscribe(Team.Event.Created, (event) => {
          received = true
          expect(event.properties.info.goal).toBe("Event test goal")
          expect(event.properties.info.phase).toBe("understanding")
          expect(event.properties.info.status).toBe("active")
        })

        await Team.create({ goal: "Event test goal" })
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })

  test("Updated event fires during Team.cancel()", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)

        let received = false
        const unsub = Bus.subscribe(Team.Event.Updated, (event) => {
          if (event.properties.info.id === teamID) {
            received = true
            expect(event.properties.info.status).toBe("cancelled")
          }
        })

        Team.cancel(teamID)
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })
})

describe("team.Team.create with hierarchical strategy", () => {
  test("persists hierarchical sharing strategy", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await Team.create({ goal: "Test", sharingStrategy: "hierarchical" })
        expect(info.sharingStrategy).toBe("hierarchical")
        const fetched = Team.get(info.id)
        expect(fetched!.sharingStrategy).toBe("hierarchical")
      },
    })
  })
})

describe("team.Team.status edge cases", () => {
  test("returns empty arrays when artifacts has other keys but no modified_files/commands_run", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSessionDirect(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "artifacts", { some_other_key: "value" }, "system")

        const status = Team.status(teamID)
        expect(status!.modifiedFiles).toEqual([])
        expect(status!.commandsRun).toEqual([])
      },
    })
  })

  test("fromRow maps time.created and time.updated correctly", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await Team.create({ goal: "Time test" })
        const fetched = Team.get(info.id)

        expect(fetched!.time.created).toBe(info.time.created)
        expect(fetched!.time.updated).toBe(info.time.updated)
        expect(fetched!.time.created).toBeGreaterThan(0)
      },
    })
  })
})
