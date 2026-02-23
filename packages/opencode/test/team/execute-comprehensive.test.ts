import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Execute } from "../../src/team/execute"
import { Workspace } from "../../src/team/workspace"
import { TeamMessage } from "../../src/team/message"
import { Roster } from "../../src/team/roster"
import { Identifier } from "../../src/id/id"
import { Database } from "../../src/storage/db"
import { TeamSessionTable, AgentInstanceTable } from "../../src/team/team.sql"
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
        expertise: ["skill1"],
        workspace_read: ["goal", "plan", "decisions"],
        workspace_write: ["artifacts", "questions"],
        relationships: { collaborates_with: ["dev"], reviews: [], reviewed_by: ["qa"] },
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

describe("team.execute.parseOutput", () => {
  test("extracts single proposal", () => {
    const result = Execute.parseOutput("[PROPOSAL]\nUse a microservices architecture.\n")
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toContain("microservices")
  })

  test("extracts multiple proposals", () => {
    const result = Execute.parseOutput("[PROPOSAL]\nFirst approach.\n\n[PROPOSAL]\nSecond approach.\n")
    expect(result.proposals).toHaveLength(2)
    expect(result.proposals[0]).toContain("First")
    expect(result.proposals[1]).toContain("Second")
  })

  test("extracts questions with target role", () => {
    const result = Execute.parseOutput("[QUESTION: architect]\nShould we use REST or GraphQL?\n")
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0].target).toBe("architect")
    expect(result.questions[0].content).toContain("REST or GraphQL")
  })

  test("extracts multiple questions to different roles", () => {
    const text = [
      "[QUESTION: architect]",
      "What pattern?",
      "",
      "[QUESTION: security-reviewer]",
      "Is JWT safe enough?",
    ].join("\n")
    const result = Execute.parseOutput(text)
    expect(result.questions).toHaveLength(2)
    expect(result.questions[0].target).toBe("architect")
    expect(result.questions[1].target).toBe("security-reviewer")
  })

  test("extracts concerns", () => {
    const result = Execute.parseOutput("[CONCERN: security]\nXSS vulnerability in token storage.\n")
    expect(result.concerns).toHaveLength(1)
    expect(result.concerns[0]).toContain("security")
  })

  test("extracts artifacts", () => {
    const result = Execute.parseOutput("[ARTIFACT]\nfunction hello() { return 'world' }\n")
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toContain("function hello")
  })

  test("extracts multiple artifacts", () => {
    const text = "[ARTIFACT]\nconst a = 1\n\n[ARTIFACT]\nconst b = 2\n"
    const result = Execute.parseOutput(text)
    expect(result.artifacts).toHaveLength(2)
  })

  test("extracts spawn requests", () => {
    const result = Execute.parseOutput("[SPAWN: security-reviewer]\nNeed security expert.\n")
    expect(result.spawnRequests).toHaveLength(1)
    expect(result.spawnRequests[0].role).toBe("security-reviewer")
    expect(result.spawnRequests[0].reason).toContain("security expert")
  })

  test("extracts critiques", () => {
    const result = Execute.parseOutput("[CRITIQUE]\nError handling too broad.\n")
    expect(result.critiques).toHaveLength(1)
    expect(result.critiques[0]).toContain("Error handling")
  })

  test("extracts multiple critiques", () => {
    const text = "[CRITIQUE]\nIssue 1.\n\n[CRITIQUE]\nIssue 2.\n"
    const result = Execute.parseOutput(text)
    expect(result.critiques).toHaveLength(2)
  })

  test("detects COMPLETE signal", () => {
    const result = Execute.parseOutput("[COMPLETE]\nAll tasks finished.\n")
    expect(result.complete).toBe(true)
    expect(result.completeSummary).toContain("All tasks finished")
  })

  test("COMPLETE with no summary", () => {
    const result = Execute.parseOutput("[COMPLETE]\n")
    expect(result.complete).toBe(true)
    expect(result.completeSummary).toBeUndefined()
  })

  test("detects APPROVED signal", () => {
    const result = Execute.parseOutput("[APPROVED]\nLooks good.\n")
    expect(result.approved).toBe(true)
    expect(result.complete).toBe(true)
  })

  test("APPROVED sets complete to true", () => {
    const result = Execute.parseOutput("Some text\n[APPROVED]\n")
    expect(result.approved).toBe(true)
    expect(result.complete).toBe(true)
  })

  test("APPROVED is case-insensitive", () => {
    const lower = Execute.parseOutput("[approved]\nLooks good.\n")
    expect(lower.approved).toBe(true)
    expect(lower.complete).toBe(true)

    const mixed = Execute.parseOutput("[Approved]\nFine.\n")
    expect(mixed.approved).toBe(true)
  })

  test("COMPLETE is terminated by tag-set (not just any bracket)", () => {
    // [COMPLETE] followed by [ARTIFACT] should be terminated properly
    const text = "[COMPLETE]\nSummary text here.\n\n[ARTIFACT]\nconst x = 1"
    const result = Execute.parseOutput(text)
    expect(result.complete).toBe(true)
    expect(result.completeSummary).toBe("Summary text here.")
    expect(result.artifacts).toHaveLength(1)
  })

  test("handles empty text", () => {
    const result = Execute.parseOutput("")
    expect(result.proposals).toHaveLength(0)
    expect(result.questions).toHaveLength(0)
    expect(result.concerns).toHaveLength(0)
    expect(result.artifacts).toHaveLength(0)
    expect(result.spawnRequests).toHaveLength(0)
    expect(result.critiques).toHaveLength(0)
    expect(result.complete).toBe(false)
    expect(result.approved).toBe(false)
    expect(result.text).toBe("")
  })

  test("handles plain text with no signals", () => {
    const result = Execute.parseOutput("Just some analysis.")
    expect(result.proposals).toHaveLength(0)
    expect(result.text).toContain("Just some analysis")
  })

  test("preserves full text in result", () => {
    const input = "[PROPOSAL]\nSome proposal.\n\n[COMPLETE]\nDone."
    const result = Execute.parseOutput(input)
    expect(result.text).toBe(input)
  })

  test("handles mixed signals in one output", () => {
    const input = [
      "[PROPOSAL]",
      "Use JWT tokens.",
      "",
      "[QUESTION: security-reviewer]",
      "RS256 or HS256?",
      "",
      "[CONCERN: performance]",
      "Token validation may be slow.",
      "",
      "[ARTIFACT]",
      "const verify = jwt.verify(token, key)",
      "",
      "[CRITIQUE]",
      "Missing rate limiting.",
      "",
      "[SPAWN: devops]",
      "Need deployment config.",
      "",
      "[COMPLETE]",
      "Initial implementation done.",
    ].join("\n")

    const result = Execute.parseOutput(input)
    expect(result.proposals).toHaveLength(1)
    expect(result.questions).toHaveLength(1)
    expect(result.concerns).toHaveLength(1)
    expect(result.artifacts).toHaveLength(1)
    expect(result.critiques).toHaveLength(1)
    expect(result.spawnRequests).toHaveLength(1)
    expect(result.complete).toBe(true)
  })

  test("handles hyphenated role names in QUESTION", () => {
    const result = Execute.parseOutput("[QUESTION: database-specialist]\nWhat index strategy?\n")
    expect(result.questions[0].target).toBe("database-specialist")
  })

  test("handles hyphenated role names in SPAWN", () => {
    const result = Execute.parseOutput("[SPAWN: performance-specialist]\nNeed perf analysis.\n")
    expect(result.spawnRequests[0].role).toBe("performance-specialist")
  })

  test("tags are case-insensitive", () => {
    const result = Execute.parseOutput("[proposal]\nLowercase tag.\n")
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toContain("Lowercase")
  })

  test("tag terminated by markdown heading", () => {
    const text = "[PROPOSAL]\nSome proposal text.\n\n## Next Section\nMore text."
    const result = Execute.parseOutput(text)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).not.toContain("Next Section")
  })

  test("tag at end of text (terminated by $)", () => {
    const result = Execute.parseOutput("[ARTIFACT]\nconst x = 42")
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toBe("const x = 42")
  })

  test("whitespace trimming in extracted content", () => {
    const result = Execute.parseOutput("[PROPOSAL]\n  \n  Trimmed content.  \n  \n")
    expect(result.proposals[0]).toBe("Trimmed content.")
  })
})

describe("team.execute.buildContext", () => {
  test("returns context with workspace summary and messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Build REST API")

        Workspace.addDecision(teamID, {
          description: "Use Express",
          rationale: "Mature framework",
          alternatives: ["Fastify"],
          made_by: "architect",
          status: "approved",
        })

        Workspace.addQuestion(teamID, {
          question: "Which auth?",
          asked_by: "dev",
          routed_to: "developer",
          status: "open",
        })

        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "arch",
          toRole: "developer",
          type: "handoff",
          content: "Implement login",
        })

        const agent = Roster.getByID(agentID)!
        const ctx = Execute.buildContext(agent, teamID)

        expect(ctx.workspaceSummary).toContain("Build REST API")
        expect(ctx.decisions).toHaveLength(1)
        expect(ctx.decisions[0].description).toBe("Use Express")
        expect(ctx.openQuestions).toHaveLength(1)
        expect(ctx.openQuestions[0].question).toBe("Which auth?")
        expect(ctx.relevantMessages.length).toBeGreaterThan(0)
      },
    })
  })

  test("filters questions to agent's role", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        Workspace.addQuestion(teamID, { question: "For dev", asked_by: "a", routed_to: "developer", status: "open" })
        Workspace.addQuestion(teamID, { question: "For arch", asked_by: "a", routed_to: "architect", status: "open" })

        const agent = Roster.getByID(agentID)!
        const ctx = Execute.buildContext(agent, teamID)
        expect(ctx.openQuestions).toHaveLength(1)
        expect(ctx.openQuestions[0].question).toBe("For dev")
      },
    })
  })
})

describe("team.execute.buildMessage", () => {
  test("includes team goal, role, and phase", () => {
    const context: Execute.AgentContext = {
      workspaceSummary: "Summary text",
      relevantMessages: [],
      decisions: [],
      openQuestions: [],
    }
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "developer",
      prompt: "You are a developer",
      expertise: ["coding"],
      workspaceRead: ["goal"],
      workspaceWrite: ["artifacts"],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const msg = Execute.buildMessage("Build login endpoint", context, agent, "Auth system", "implementation")
    expect(msg).toContain("Auth system")
    expect(msg).toContain("developer")
    expect(msg).toContain("implementation")
    expect(msg).toContain("Build login endpoint")
    expect(msg).toContain("Summary text")
  })

  test("includes decisions when present", () => {
    const context: Execute.AgentContext = {
      workspaceSummary: "Summary",
      relevantMessages: [],
      decisions: [
        {
          id: "d1",
          description: "Use JWT",
          rationale: "Stateless",
          alternatives: [],
          made_by: "arch",
          status: "approved",
          timestamp: 0,
        },
      ],
      openQuestions: [],
    }
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "dev",
      prompt: "",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const msg = Execute.buildMessage("task", context, agent, "goal", "design")
    expect(msg).toContain("## Previous Decisions")
    expect(msg).toContain("Use JWT")
  })

  test("includes open questions routed to agent", () => {
    const context: Execute.AgentContext = {
      workspaceSummary: "Summary",
      relevantMessages: [],
      decisions: [],
      openQuestions: [{ id: "q1", question: "Which DB?", asked_by: "dev", routed_to: "arch", status: "open" }],
    }
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "arch",
      prompt: "",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const msg = Execute.buildMessage("task", context, agent, "goal", "design")
    expect(msg).toContain("## Questions Routed to You")
    expect(msg).toContain("Which DB?")
  })

  test("includes recent messages (truncated to 10)", () => {
    const messages: TeamMessage.Info[] = Array.from({ length: 15 }, (_, i) => ({
      id: `msg_${i}`,
      teamSessionID: "team_1",
      fromRole: "a",
      type: "status" as const,
      content: `Message ${i}`,
      timestamp: i,
    }))

    const context: Execute.AgentContext = {
      workspaceSummary: "S",
      relevantMessages: messages,
      decisions: [],
      openQuestions: [],
    }
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "dev",
      prompt: "",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const msg = Execute.buildMessage("task", context, agent, "goal", "design")
    expect(msg).toContain("## Recent Team Communication")
    // Should show last 10 (indices 5-14)
    expect(msg).toContain("Message 5")
    expect(msg).toContain("Message 14")
    expect(msg).not.toContain("Message 4")
  })

  test("excludes sections when empty", () => {
    const context: Execute.AgentContext = {
      workspaceSummary: "Summary",
      relevantMessages: [],
      decisions: [],
      openQuestions: [],
    }
    const agent: Roster.Info = {
      id: "agt_1",
      teamSessionID: "team_1",
      role: "dev",
      prompt: "",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
      status: "idle",
      stepsUsed: 0,
      tokensConsumed: 0,
      time: { created: 0, updated: 0 },
    }

    const msg = Execute.buildMessage("task", context, agent, "goal", "design")
    expect(msg).not.toContain("## Previous Decisions")
    expect(msg).not.toContain("## Questions Routed to You")
    expect(msg).not.toContain("## Recent Team Communication")
  })
})

describe("team.execute.AgentResult defaults", () => {
  test("parseOutput on plain text returns empty arrays and false flags", () => {
    const result = Execute.parseOutput("plain text with no tags")
    expect(result.text).toBe("plain text with no tags")
    expect(result.proposals).toEqual([])
    expect(result.questions).toEqual([])
    expect(result.concerns).toEqual([])
    expect(result.artifacts).toEqual([])
    expect(result.spawnRequests).toEqual([])
    expect(result.critiques).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.completeSummary).toBeUndefined()
    expect(result.approved).toBe(false)
  })
})

describe("team.execute.extractAssistantText", () => {
  test("returns empty string for null", () => {
    expect(Execute.extractAssistantText(null)).toBe("")
  })

  test("returns empty string for undefined", () => {
    expect(Execute.extractAssistantText(undefined)).toBe("")
  })

  test("returns string as-is", () => {
    expect(Execute.extractAssistantText("hello world")).toBe("hello world")
  })

  test("extracts from object with text field", () => {
    expect(Execute.extractAssistantText({ text: "from text" })).toBe("from text")
  })

  test("extracts from object with content field", () => {
    expect(Execute.extractAssistantText({ content: "from content" })).toBe("from content")
  })

  test("prefers text field over content field", () => {
    expect(Execute.extractAssistantText({ text: "win", content: "lose" })).toBe("win")
  })

  test("falls back to String() for numbers", () => {
    expect(Execute.extractAssistantText(42)).toBe("42")
  })

  test("falls back to String() for boolean", () => {
    expect(Execute.extractAssistantText(true)).toBe("true")
  })

  test("returns empty string for empty string", () => {
    expect(Execute.extractAssistantText("")).toBe("")
  })

  test("handles object with no recognized fields", () => {
    expect(Execute.extractAssistantText({ foo: "bar" })).toBe("[object Object]")
  })
})
