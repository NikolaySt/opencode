import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Roster } from "../../src/team/roster"
import { Identifier } from "../../src/id/id"
import { Database } from "../../src/storage/db"
import { TeamSessionTable, AgentInstanceTable } from "../../src/team/team.sql"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function createTeamSession(projectID: string): string {
  const id = Identifier.ascending("team")
  const now = Date.now()
  Database.use((db) => {
    db.insert(TeamSessionTable)
      .values({
        id,
        project_id: projectID,
        goal: "Test goal",
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

/** Insert an agent row directly to avoid Session.create dependency */
function insertAgent(
  teamSessionID: string,
  role: string,
  opts?: Partial<{ status: Roster.Status; steps: number; tokens: number }>,
): string {
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
        expertise: ["skill1", "skill2"],
        workspace_read: ["goal", "plan"],
        workspace_write: ["artifacts"],
        relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
        status: opts?.status ?? "idle",
        steps_used: opts?.steps ?? 0,
        tokens_consumed: opts?.tokens ?? 0,
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return id
}

describe("team.roster.get", () => {
  test("returns agent by role", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        insertAgent(teamID, "architect")

        const agent = Roster.get(teamID, "architect")
        expect(agent).toBeDefined()
        expect(agent!.role).toBe("architect")
        expect(agent!.teamSessionID).toBe(teamID)
      },
    })
  })

  test("returns undefined for non-existent role", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        expect(Roster.get(teamID, "nonexistent")).toBeUndefined()
      },
    })
  })

  test("returns undefined for retired agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        insertAgent(teamID, "old-agent", { status: "retired" })

        expect(Roster.get(teamID, "old-agent")).toBeUndefined()
      },
    })
  })
})

describe("team.roster.getByID", () => {
  test("returns agent by ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        const agent = Roster.getByID(id)
        expect(agent).toBeDefined()
        expect(agent!.id).toBe(id)
        expect(agent!.role).toBe("developer")
      },
    })
  })

  test("returns undefined for non-existent ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Roster.getByID("agt_nonexistent")).toBeUndefined()
      },
    })
  })

  test("returns retired agents (unlike get by role)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "retired-dev", { status: "retired" })

        const agent = Roster.getByID(id)
        expect(agent).toBeDefined()
        expect(agent!.status).toBe("retired")
      },
    })
  })
})

describe("team.roster.list", () => {
  test("returns all non-retired agents", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        insertAgent(teamID, "architect")
        insertAgent(teamID, "developer")
        insertAgent(teamID, "old-agent", { status: "retired" })

        const agents = Roster.list(teamID)
        expect(agents).toHaveLength(2)
        const roles = agents.map((a) => a.role)
        expect(roles).toContain("architect")
        expect(roles).toContain("developer")
      },
    })
  })

  test("returns empty for team with no agents", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        expect(Roster.list(teamID)).toEqual([])
      },
    })
  })
})

describe("team.roster.all", () => {
  test("returns ALL agents including retired", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        insertAgent(teamID, "architect")
        insertAgent(teamID, "old-agent", { status: "retired" })

        const agents = Roster.all(teamID)
        expect(agents).toHaveLength(2)
      },
    })
  })
})

describe("team.roster.retire", () => {
  test("sets agent status to retired", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        Roster.retire(id)

        const agent = Roster.getByID(id)
        expect(agent!.status).toBe("retired")
      },
    })
  })

  test("retired agent disappears from list()", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        expect(Roster.list(teamID)).toHaveLength(1)
        Roster.retire(id)
        expect(Roster.list(teamID)).toHaveLength(0)
      },
    })
  })

  test("emits Retired bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "qa")

        let received = false
        const unsub = Bus.subscribe(Roster.Event.Retired, (event) => {
          received = true
          expect(event.properties.info.role).toBe("qa")
          expect(event.properties.info.status).toBe("retired")
        })

        Roster.retire(id)
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })

  test("does nothing for non-existent agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Should not throw
        Roster.retire("agt_nonexistent")
      },
    })
  })
})

describe("team.roster.setStatus", () => {
  test("changes agent status to working", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        Roster.setStatus(id, "working")
        expect(Roster.getByID(id)!.status).toBe("working")
      },
    })
  })

  test("changes agent status to waiting", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        Roster.setStatus(id, "waiting")
        expect(Roster.getByID(id)!.status).toBe("waiting")
      },
    })
  })

  test("emits Updated bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        let received = false
        const unsub = Bus.subscribe(Roster.Event.Updated, (event) => {
          received = true
          expect(event.properties.info.status).toBe("working")
        })

        Roster.setStatus(id, "working")
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })
})

describe("team.roster.updateMetrics", () => {
  test("sets absolute steps and tokens", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        Roster.updateMetrics(id, 5, 1000)
        const agent = Roster.getByID(id)!
        expect(agent.stepsUsed).toBe(5)
        expect(agent.tokensConsumed).toBe(1000)
      },
    })
  })
})

describe("team.roster.incrementSteps", () => {
  test("increments by 1 by default", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        Roster.incrementSteps(id)
        expect(Roster.getByID(id)!.stepsUsed).toBe(1)

        Roster.incrementSteps(id)
        expect(Roster.getByID(id)!.stepsUsed).toBe(2)
      },
    })
  })

  test("increments by custom count", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        Roster.incrementSteps(id, 5)
        expect(Roster.getByID(id)!.stepsUsed).toBe(5)
      },
    })
  })

  test("does nothing for non-existent agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Should not throw
        Roster.incrementSteps("agt_nonexistent")
      },
    })
  })
})

describe("team.roster.incrementTokens", () => {
  test("increments tokens consumed", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const id = insertAgent(teamID, "developer")

        Roster.incrementTokens(id, 500)
        expect(Roster.getByID(id)!.tokensConsumed).toBe(500)

        Roster.incrementTokens(id, 300)
        expect(Roster.getByID(id)!.tokensConsumed).toBe(800)
      },
    })
  })

  test("does nothing for non-existent agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        Roster.incrementTokens("agt_nonexistent", 100)
      },
    })
  })
})

describe("team.roster.shouldRetire", () => {
  test("returns retire=true for idle agent with no active reviews", () => {
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "developer",
      prompt: "test",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 5,
      tokensConsumed: 1000,
      time: { created: 0, updated: 0 },
    }

    const result = Roster.shouldRetire(agent, [])
    expect(result.retire).toBe(true)
    expect(result.reason).toContain("no active tasks")
  })

  test("returns retire=false for already retired agent", () => {
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "developer",
      prompt: "test",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "retired",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const result = Roster.shouldRetire(agent, [])
    expect(result.retire).toBe(false)
    expect(result.reason).toBe("already retired")
  })

  test("returns retire=false for working agent", () => {
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "developer",
      prompt: "test",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "working",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const result = Roster.shouldRetire(agent, [])
    expect(result.retire).toBe(false)
    expect(result.reason).toBe("currently working")
  })

  test("returns retire=false for agent involved as author in active review", () => {
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "developer",
      prompt: "test",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const result = Roster.shouldRetire(agent, [{ authorRole: "developer", reviewerRole: "qa" }])
    expect(result.retire).toBe(false)
    expect(result.reason).toContain("involved in 1 active review")
  })

  test("returns retire=false for agent involved as reviewer in active review", () => {
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "qa",
      prompt: "test",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const result = Roster.shouldRetire(agent, [{ authorRole: "developer", reviewerRole: "qa" }])
    expect(result.retire).toBe(false)
    expect(result.reason).toContain("involved in 1 active review")
  })

  test("counts multiple active reviews", () => {
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "developer",
      prompt: "test",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "waiting",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const result = Roster.shouldRetire(agent, [
      { authorRole: "developer", reviewerRole: "qa" },
      { authorRole: "developer", reviewerRole: "security-reviewer" },
    ])
    expect(result.retire).toBe(false)
    expect(result.reason).toContain("2 active review")
  })
})

describe("team.roster.Info schema", () => {
  test("validates full Info object", () => {
    const info = Roster.Info.parse({
      id: "agt_1",
      teamSessionID: "team_1",
      role: "architect",
      prompt: "You are an architect",
      expertise: ["design", "patterns"],
      workspaceRead: ["goal"],
      workspaceWrite: ["plan"],
      relationships: {
        reports_to: "orchestrator",
        collaborates_with: ["developer"],
        reviews: ["qa"],
        reviewed_by: [],
      },
      status: "idle",
      stepsUsed: 3,
      tokensConsumed: 500,
      time: { created: 1000, updated: 2000 },
    })
    expect(info.relationships.reports_to).toBe("orchestrator")
    expect(info.relationships.collaborates_with).toEqual(["developer"])
  })

  test("Status enum has all expected values", () => {
    for (const status of ["idle", "working", "waiting", "retired"] as const) {
      expect(Roster.Status.parse(status)).toBe(status)
    }
  })

  test("Status rejects invalid values", () => {
    expect(() => Roster.Status.parse("invalid")).toThrow()
  })
})
