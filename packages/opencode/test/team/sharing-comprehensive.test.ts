import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Workspace } from "../../src/team/workspace"
import { TeamMessage } from "../../src/team/message"
import { Review } from "../../src/team/review"
import { Roster } from "../../src/team/roster"
import { Identifier } from "../../src/id/id"
import { Database } from "../../src/storage/db"
import { TeamSessionTable, AgentInstanceTable } from "../../src/team/team.sql"
import { resolve } from "../../src/team/sharing/strategy"
import { selective } from "../../src/team/sharing/selective"
import { hierarchical } from "../../src/team/sharing/hierarchical"
import { broadcast } from "../../src/team/sharing/broadcast"
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
        phase: "design",
        status: "active",
        sharing_strategy: "selective",
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return id
}

function insertAgent(
  teamSessionID: string,
  role: string,
  opts?: { read?: string[]; write?: string[]; collabs?: string[]; reviewedBy?: string[] },
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
        expertise: ["skill"],
        workspace_read: opts?.read ?? ["goal", "plan", "decisions"],
        workspace_write: opts?.write ?? ["artifacts", "questions"],
        relationships: {
          collaborates_with: opts?.collabs ?? [],
          reviews: [],
          reviewed_by: opts?.reviewedBy ?? [],
        },
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

describe("sharing.strategy.resolve", () => {
  test("resolves selective strategy", () => {
    const s = resolve("selective")
    expect(s.name).toBe("selective")
  })

  test("resolves hierarchical strategy", () => {
    const s = resolve("hierarchical")
    expect(s.name).toBe("hierarchical")
  })

  test("resolves broadcast strategy", () => {
    const s = resolve("broadcast")
    expect(s.name).toBe("broadcast")
  })
})

describe("sharing.selective.buildContext", () => {
  test("includes team goal, role, and phase", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Build auth system")

        const agent = Roster.getByID(agentID)!
        const ctx = selective.buildContext({ agent, teamSessionID: teamID, teamGoal: "Build auth", phase: "design" })

        expect(ctx).toContain("Build auth")
        expect(ctx).toContain("developer")
        expect(ctx).toContain("design")
      },
    })
  })

  test("includes workspace summary", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Build REST API")

        const agent = Roster.getByID(agentID)!
        const ctx = selective.buildContext({ agent, teamSessionID: teamID, teamGoal: "goal", phase: "design" })
        expect(ctx).toContain("## Workspace Summary")
        expect(ctx).toContain("Build REST API")
      },
    })
  })

  test("includes detailed sections agent has read access to", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { read: ["goal", "plan", "decisions"] })
        Workspace.create(teamID, "Test")

        Workspace.addDecision(teamID, {
          description: "Use REST",
          rationale: "Simple",
          alternatives: [],
          made_by: "arch",
          status: "approved",
        })

        const agent = Roster.getByID(agentID)!
        const ctx = selective.buildContext({ agent, teamSessionID: teamID, teamGoal: "goal", phase: "design" })
        expect(ctx).toContain("(detail)")
      },
    })
  })

  test("includes messages relevant to agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "architect",
          toRole: "developer",
          type: "handoff",
          content: "Please implement login",
        })

        const agent = Roster.getByID(agentID)!
        const ctx = selective.buildContext({ agent, teamSessionID: teamID, teamGoal: "goal", phase: "design" })
        expect(ctx).toContain("## Recent Messages for You")
        expect(ctx).toContain("Please implement login")
      },
    })
  })

  test("includes active reviews involving agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        Review.create({
          teamSessionID: teamID,
          artifactRef: "code v1",
          authorRole: "developer",
          reviewerRole: "qa",
        })

        const agent = Roster.getByID(agentID)!
        const ctx = selective.buildContext({ agent, teamSessionID: teamID, teamGoal: "goal", phase: "design" })
        expect(ctx).toContain("## Your Active Reviews")
        expect(ctx).toContain("you are author")
      },
    })
  })

  test("includes team decisions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        Workspace.addDecision(teamID, {
          description: "Use JWT",
          rationale: "Stateless",
          alternatives: [],
          made_by: "arch",
          status: "approved",
        })

        const agent = Roster.getByID(agentID)!
        const ctx = selective.buildContext({ agent, teamSessionID: teamID, teamGoal: "goal", phase: "design" })
        expect(ctx).toContain("## Team Decisions")
        expect(ctx).toContain("Use JWT")
      },
    })
  })
})

describe("sharing.selective.propagate", () => {
  test("applies mutations to allowed workspace sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: ["artifacts"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = selective.propagate({
          agent,
          teamSessionID: teamID,
          output: "some output",
          mutations: [{ section: "artifacts", operation: "set", path: "code.ts", value: "code" }],
        })

        expect(result.updated).toContain("artifacts")
      },
    })
  })

  test("skips mutations to sections agent cannot write", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: ["artifacts"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = selective.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [{ section: "plan", operation: "set", path: "status", value: "approved" }],
        })

        expect(result.updated).not.toContain("plan")
      },
    })
  })

  test("notifies collaborators and reviewers", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { collabs: ["architect"], reviewedBy: ["qa"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = selective.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [],
        })

        expect(result.notify).toContain("architect")
        expect(result.notify).toContain("qa")
      },
    })
  })

  test("applies append mutations to array sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: ["artifacts", "constraints"] })
        Workspace.create(teamID, "Test")

        // Set constraints to an initial array so append has something to add to
        Workspace.set(teamID, "constraints", ["C1"])

        const agent = Roster.getByID(agentID)!
        const result = selective.propagate({
          agent,
          teamSessionID: teamID,
          output: "some output",
          mutations: [{ section: "constraints", operation: "append", path: "", value: "C2" }],
        })

        expect(result.updated).toContain("constraints")
        // Verify the append actually happened
        const constraints = Workspace.get(teamID, "constraints") as string[]
        expect(constraints).toContain("C1")
        expect(constraints).toContain("C2")
        expect(constraints).toHaveLength(2)
      },
    })
  })

  test("deduplicates notify list", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        // Same role in both collaborators and reviewed_by
        const agentID = insertAgent(teamID, "developer", { collabs: ["qa"], reviewedBy: ["qa"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = selective.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [],
        })

        const qaCount = result.notify.filter((r) => r === "qa").length
        expect(qaCount).toBe(1)
      },
    })
  })
})

describe("sharing.selective.summarize", () => {
  test("returns workspace summary", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "My goal text")

        const summary = selective.summarize(teamID)
        expect(summary).toContain("My goal text")
      },
    })
  })
})

describe("sharing.hierarchical.buildContext", () => {
  test("includes workspace overview but no messages or reviews", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Build system")

        // Send messages and create reviews
        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "arch",
          toRole: "developer",
          type: "handoff",
          content: "Should not appear",
        })
        Review.create({ teamSessionID: teamID, artifactRef: "code", authorRole: "developer", reviewerRole: "qa" })

        const agent = Roster.getByID(agentID)!
        const ctx = hierarchical.buildContext({
          agent,
          teamSessionID: teamID,
          teamGoal: "Build system",
          phase: "design",
        })

        expect(ctx).toContain("## Workspace Overview")
        expect(ctx).toContain("## Communication")
        expect(ctx).toContain("All communication goes through the orchestrator")
        expect(ctx).not.toContain("## Recent Messages for You")
        expect(ctx).not.toContain("## Your Active Reviews")
      },
    })
  })

  test("includes workspace sections agent has read access to", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { read: ["goal", "plan"] })
        Workspace.create(teamID, "Test goal")

        const agent = Roster.getByID(agentID)!
        const ctx = hierarchical.buildContext({
          agent,
          teamSessionID: teamID,
          teamGoal: "goal",
          phase: "design",
        })

        expect(ctx).toContain("## goal")
        expect(ctx).toContain("Test goal")
      },
    })
  })
})

describe("sharing.hierarchical.propagate", () => {
  test("only notifies orchestrator", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { collabs: ["architect", "qa"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = hierarchical.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [],
        })

        expect(result.notify).toEqual(["orchestrator"])
      },
    })
  })

  test("applies mutations respecting write permissions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: ["artifacts"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = hierarchical.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [
            { section: "artifacts", operation: "set", path: "x", value: "y" },
            { section: "plan", operation: "set", path: "status", value: "done" },
          ],
        })

        expect(result.updated).toContain("artifacts")
        expect(result.updated).not.toContain("plan")
      },
    })
  })

  test("applies append mutations to array sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: ["constraints"] })
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "constraints", ["existing"])

        const agent = Roster.getByID(agentID)!
        const result = hierarchical.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [{ section: "constraints", operation: "append", path: "", value: "new-item" }],
        })

        expect(result.updated).toContain("constraints")
        const constraints = Workspace.get(teamID, "constraints") as string[]
        expect(constraints).toEqual(["existing", "new-item"])
        // Hierarchical always only notifies orchestrator
        expect(result.notify).toEqual(["orchestrator"])
      },
    })
  })
})

describe("sharing.hierarchical.summarize", () => {
  test("returns workspace summary", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Hierarchical goal")

        expect(hierarchical.summarize(teamID)).toContain("Hierarchical goal")
      },
    })
  })
})

describe("sharing.broadcast.buildContext", () => {
  test("includes all workspace sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Broadcast goal")

        Workspace.set(teamID, "constraints", ["C1", "C2"])

        const agent = Roster.getByID(agentID)!
        const ctx = broadcast.buildContext({
          agent,
          teamSessionID: teamID,
          teamGoal: "Broadcast goal",
          phase: "implementation",
        })

        expect(ctx).toContain("## goal")
        expect(ctx).toContain("Broadcast goal")
        expect(ctx).toContain("## constraints")
        expect(ctx).toContain("C1")
      },
    })
  })

  test("includes ALL recent messages (not just agent's)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        TeamMessage.send({ teamSessionID: teamID, fromRole: "arch", toRole: "qa", type: "handoff", content: "QA task" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "orch", type: "status", content: "Phase update" })

        const agent = Roster.getByID(agentID)!
        const ctx = broadcast.buildContext({
          agent,
          teamSessionID: teamID,
          teamGoal: "goal",
          phase: "design",
        })

        expect(ctx).toContain("## All Recent Team Messages")
        expect(ctx).toContain("QA task")
        expect(ctx).toContain("Phase update")
      },
    })
  })

  test("includes all active reviews", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        Review.create({ teamSessionID: teamID, artifactRef: "code", authorRole: "arch", reviewerRole: "sec" })

        const agent = Roster.getByID(agentID)!
        const ctx = broadcast.buildContext({
          agent,
          teamSessionID: teamID,
          teamGoal: "goal",
          phase: "design",
        })

        expect(ctx).toContain("## Active Reviews")
        expect(ctx).toContain("arch -> sec")
      },
    })
  })

  test("includes team roster", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        insertAgent(teamID, "architect")
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const ctx = broadcast.buildContext({
          agent,
          teamSessionID: teamID,
          teamGoal: "goal",
          phase: "design",
        })

        expect(ctx).toContain("## Team Roster")
        expect(ctx).toContain("developer")
        expect(ctx).toContain("architect")
      },
    })
  })
})

describe("sharing.broadcast.propagate", () => {
  test("notifies all other team members", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        insertAgent(teamID, "architect")
        insertAgent(teamID, "qa")
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = broadcast.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [],
        })

        expect(result.notify).toContain("architect")
        expect(result.notify).toContain("qa")
        expect(result.notify).not.toContain("developer") // Not the agent itself
      },
    })
  })

  test("applies mutations without write permission check", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        // Agent has NO write permissions, but broadcast ignores that
        const agentID = insertAgent(teamID, "developer", { write: [] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = broadcast.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [{ section: "plan", operation: "set", path: "status", value: "done" }],
        })

        expect(result.updated).toContain("plan")
      },
    })
  })

  test("applies append mutations to array sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: [] })
        Workspace.create(teamID, "Test")

        // Set constraints to an initial array
        Workspace.set(teamID, "constraints", ["existing"])

        const agent = Roster.getByID(agentID)!
        const result = broadcast.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [{ section: "constraints", operation: "append", path: "", value: "new-item" }],
        })

        expect(result.updated).toContain("constraints")
        const constraints = Workspace.get(teamID, "constraints") as string[]
        expect(constraints).toContain("existing")
        expect(constraints).toContain("new-item")
        expect(constraints).toHaveLength(2)
      },
    })
  })
})

describe("sharing.broadcast.summarize", () => {
  test("returns workspace summary", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Broadcast summary goal")

        expect(broadcast.summarize(teamID)).toContain("Broadcast summary goal")
      },
    })
  })
})

describe("sharing propagate with unsupported operations", () => {
  test("selective propagate with 'remove' op: added to updated but data unchanged", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: ["artifacts"] })
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "artifacts", { keep: "this" })
        const agent = Roster.getByID(agentID)!
        const result = selective.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [{ section: "artifacts", operation: "remove", path: "keep", value: "this" }],
        })

        // "remove" passes write-permission check so section is pushed to updated,
        // but the data is NOT actually modified (no "remove" handler)
        expect(result.updated).toContain("artifacts")
        const artifacts = Workspace.get(teamID, "artifacts") as Record<string, unknown>
        expect(artifacts.keep).toBe("this")
      },
    })
  })

  test("hierarchical ignores 'update' operation mutation", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer", { write: ["plan"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const result = hierarchical.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [{ section: "plan", operation: "update", path: "status", value: "approved" }],
        })

        // "update" is not handled — section still gets pushed to updated (because the push is after the if/else)
        // Actually examining the source: push happens AFTER the if/else block for all mutations
        // So "update" will add to updated[] but NOT actually modify the workspace
        expect(result.updated).toContain("plan")
      },
    })
  })

  test("broadcast ignores 'remove' operation mutation", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "artifacts", { data: "keep" })
        const agent = Roster.getByID(agentID)!
        const result = broadcast.propagate({
          agent,
          teamSessionID: teamID,
          output: "output",
          mutations: [{ section: "artifacts", operation: "remove", path: "data", value: "keep" }],
        })

        // "remove" not handled but push still adds to updated
        expect(result.updated).toContain("artifacts")
        // Data should be unchanged since "remove" wasn't actually applied
        const artifacts = Workspace.get(teamID, "artifacts") as Record<string, unknown>
        expect(artifacts.data).toBe("keep")
      },
    })
  })
})

describe("sharing.selective.buildContext empty section filtering", () => {
  test("excludes empty array/object sections from detailed view", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        // Agent has read access to constraints (empty array) and artifacts (empty object)
        const agentID = insertAgent(teamID, "developer", { read: ["constraints", "artifacts"] })
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const ctx = selective.buildContext({ agent, teamSessionID: teamID, teamGoal: "goal", phase: "design" })

        // Empty arrays and objects should be filtered out
        expect(ctx).not.toContain("## constraints (detail)")
        expect(ctx).not.toContain("## artifacts (detail)")
      },
    })
  })
})

describe("sharing.broadcast.buildContext empty section filtering", () => {
  test("excludes empty array/object sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const ctx = broadcast.buildContext({ agent, teamSessionID: teamID, teamGoal: "goal", phase: "design" })

        // Should include goal (non-empty string)
        expect(ctx).toContain("## goal")
        // constraints is [] by default — should be excluded
        expect(ctx).not.toMatch(/## constraints\n\[\]/)
      },
    })
  })
})
