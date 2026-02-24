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
    expect(result.continuing).toBe(false)
    expect(result.continueDescription).toBeUndefined()
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

describe("Execute.summarizeToolCalls", () => {
  test("returns empty string for no calls", () => {
    expect(Execute.summarizeToolCalls([])).toBe("")
  })

  test("summarizes file modifications", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "edit", title: "Edit file", input: { filePath: "src/auth.ts" }, output: "ok" },
      { tool: "write", title: "Write file", input: { filePath: "src/utils.ts" }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("src/auth.ts")
    expect(result).toContain("src/utils.ts")
    expect(result).toContain("Modified files")
  })

  test("summarizes bash commands", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "bash", title: "Run tests", input: { command: "bun test" }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("bun test")
    expect(result).toContain("Commands")
  })

  test("summarizes mixed tool calls", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "edit", title: "Edit", input: { filePath: "src/main.ts" }, output: "ok" },
      { tool: "bash", title: "Build", input: { command: "npm run build" }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("src/main.ts")
    expect(result).toContain("npm run build")
  })

  test("deduplicates file paths", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "edit", title: "First edit", input: { filePath: "src/main.ts" }, output: "ok" },
      { tool: "edit", title: "Second edit", input: { filePath: "src/main.ts" }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    const count = (result.match(/src\/main\.ts/g) ?? []).length
    expect(count).toBe(1)
  })

  test("falls back to count when no files or commands", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "apply_patch", title: "Patch", input: { patch: "..." }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("1 tool call(s)")
  })

  test("truncates long commands", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "bash", title: "Long cmd", input: { command: "a".repeat(200) }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result.length).toBeLessThan(300)
  })
})

describe("Execute.parseOutput toolCalls default", () => {
  test("parseOutput returns empty toolCalls array", () => {
    const result = Execute.parseOutput("Hello world")
    expect(result.toolCalls).toEqual([])
  })

  test("parseOutput with tags still returns empty toolCalls", () => {
    const result = Execute.parseOutput("[COMPLETE] Done")
    expect(result.toolCalls).toEqual([])
    expect(result.complete).toBe(true)
  })
})

describe("Execute.parseOutput edge cases", () => {
  test("[CONCERN: topic] with body text after bracket", () => {
    const text = "[CONCERN: security]\nAdditional details about the vulnerability.\n"
    const result = Execute.parseOutput(text)
    expect(result.concerns).toHaveLength(1)
    expect(result.concerns[0]).toContain("security")
    expect(result.concerns[0]).toContain("Additional details")
  })

  test("[DECISION] acts as terminator for preceding tag", () => {
    const text = "[PROPOSAL]\nUse REST API.\n\n[DECISION]\nApproved."
    const result = Execute.parseOutput(text)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).not.toContain("Approved")
  })

  test("both [COMPLETE] and [APPROVED] in same text", () => {
    const text = "[COMPLETE]\nAll done.\n\n[APPROVED]\nLooks good."
    const result = Execute.parseOutput(text)
    expect(result.complete).toBe(true)
    expect(result.approved).toBe(true)
    expect(result.completeSummary).toBe("All done.")
  })

  test("[CONCERN] with no body after bracket", () => {
    const text = "[CONCERN: memory leak]\n"
    const result = Execute.parseOutput(text)
    expect(result.concerns).toHaveLength(1)
    expect(result.concerns[0]).toBe("memory leak")
  })
})

describe("Execute.extractAssistantText edge cases", () => {
  test("does NOT handle parts array (unlike Orchestrator.extractText)", () => {
    const result = Execute.extractAssistantText({
      parts: [{ type: "text", text: "hello" }],
    })
    // extractAssistantText does not handle the parts structure — falls through to String()
    expect(result).toBe("[object Object]")
  })

  test("handles empty object", () => {
    expect(Execute.extractAssistantText({})).toBe("[object Object]")
  })

  test("handles object with numeric text field", () => {
    expect(Execute.extractAssistantText({ text: 42 })).toBe("[object Object]")
  })
})

describe("Execute.summarizeToolCalls edge cases", () => {
  test("extracts file from input.file instead of input.filePath", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "write", title: "Write", input: { file: "src/new.ts" }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("src/new.ts")
    expect(result).toContain("Modified files")
  })

  test("extracts file from input.path instead of input.filePath", () => {
    const calls: Execute.ToolCallInfo[] = [{ tool: "edit", title: "Edit", input: { path: "src/old.ts" }, output: "ok" }]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("src/old.ts")
  })

  test("extracts command from input.cmd instead of input.command", () => {
    const calls: Execute.ToolCallInfo[] = [{ tool: "bash", title: "Run", input: { cmd: "npm test" }, output: "ok" }]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("npm test")
    expect(result).toContain("Commands")
  })

  test("coerces non-string file value via String()", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "edit", title: "Edit", input: { filePath: 42 as any }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("42")
  })

  test("coerces non-string command value via String()", () => {
    const calls: Execute.ToolCallInfo[] = [{ tool: "bash", title: "Run", input: { command: 123 as any }, output: "ok" }]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("123")
  })

  test("multiedit tool calls fall through to generic count (no file extraction)", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "multiedit", title: "Multi edit", input: { edits: [] }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    // multiedit is in ACTION_TOOLS but not in summarize's file extraction list
    expect(result).toContain("1 tool call(s)")
  })

  test("patch tool extracts file path", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "patch", title: "Patch", input: { filePath: "src/fix.ts" }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("src/fix.ts")
  })

  test("apply_patch tool extracts file path", () => {
    const calls: Execute.ToolCallInfo[] = [
      { tool: "apply_patch", title: "Apply", input: { filePath: "src/diff.ts" }, output: "ok" },
    ]
    const result = Execute.summarizeToolCalls(calls)
    expect(result).toContain("src/diff.ts")
  })
})

describe("Execute.extractToolCalls", () => {
  test("returns empty array for non-existent session", async () => {
    // extractToolCalls catches errors and returns []
    const result = await Execute.extractToolCalls("session_nonexistent_1234")
    expect(result).toEqual([])
  })
})

describe("Execute.buildContext edge cases", () => {
  test("returns empty decisions when workspace has none", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        const agent = Roster.getByID(agentID)!
        const ctx = Execute.buildContext(agent, teamID)
        expect(ctx.decisions).toEqual([])
      },
    })
  })

  test("returns empty openQuestions when none routed to agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test")

        // Add question routed to a different role
        Workspace.addQuestion(teamID, { question: "For arch", asked_by: "dev", routed_to: "architect", status: "open" })

        const agent = Roster.getByID(agentID)!
        const ctx = Execute.buildContext(agent, teamID)
        expect(ctx.openQuestions).toEqual([])
      },
    })
  })
})

describe("Execute.parseOutput [CONTINUE] signal", () => {
  test("extracts CONTINUE signal", () => {
    const result = Execute.parseOutput("[CONTINUE]\nWrite unit tests for the login endpoint.\n")
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBe("Write unit tests for the login endpoint.")
  })

  test("CONTINUE with no description", () => {
    const result = Execute.parseOutput("[CONTINUE]\n")
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBeUndefined()
  })

  test("CONTINUE is case-insensitive", () => {
    const result = Execute.parseOutput("[continue]\nNext step here.\n")
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBe("Next step here.")
  })

  test("CONTINUE does not set complete", () => {
    const result = Execute.parseOutput("[CONTINUE]\nMore work needed.\n")
    expect(result.continuing).toBe(true)
    expect(result.complete).toBe(false)
  })

  test("CONTINUE and COMPLETE together: complete wins", () => {
    const text = "[CONTINUE]\nActually...\n\n[COMPLETE]\nAll done."
    const result = Execute.parseOutput(text)
    expect(result.continuing).toBe(true)
    expect(result.complete).toBe(true)
  })

  test("CONTINUE terminated by other tags", () => {
    const text = "[CONTINUE]\nNext: write tests.\n\n[ARTIFACT]\nconst test = 1"
    const result = Execute.parseOutput(text)
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBe("Next: write tests.")
    expect(result.artifacts).toHaveLength(1)
  })

  test("[CONTINUE] terminates preceding [PROPOSAL]", () => {
    const text = "[PROPOSAL]\nUse microservices.\n\n[CONTINUE]\nNext: implement gateway."
    const result = Execute.parseOutput(text)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toBe("Use microservices.")
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBe("Next: implement gateway.")
  })

  test("[CONTINUE] terminates preceding [CRITIQUE]", () => {
    const text = "[CRITIQUE]\nMissing validation.\n\n[CONTINUE]\nNext: add input checks."
    const result = Execute.parseOutput(text)
    expect(result.critiques).toHaveLength(1)
    expect(result.critiques[0]).toBe("Missing validation.")
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBe("Next: add input checks.")
  })

  test("[CONTINUE] terminated by ## heading", () => {
    const text = "[CONTINUE]\nNext: write tests.\n\n## Summary\nSome summary text."
    const result = Execute.parseOutput(text)
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBe("Next: write tests.")
  })

  test("plain text without CONTINUE has continuing=false", () => {
    const result = Execute.parseOutput("Just some analysis without signals.")
    expect(result.continuing).toBe(false)
    expect(result.continueDescription).toBeUndefined()
  })

  test("mixed signals with CONTINUE", () => {
    const text = [
      "[ARTIFACT]",
      "function login() {}",
      "",
      "[CONCERN: testing]",
      "No tests yet.",
      "",
      "[CONTINUE]",
      "Next: add comprehensive test coverage.",
    ].join("\n")
    const result = Execute.parseOutput(text)
    expect(result.artifacts).toHaveLength(1)
    expect(result.concerns).toHaveLength(1)
    expect(result.continuing).toBe(true)
    expect(result.continueDescription).toBe("Next: add comprehensive test coverage.")
    expect(result.complete).toBe(false)
  })
})

describe("Execute.buildContinueMessage", () => {
  test("includes step index, previous summary, and continue description", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Build auth system")

        const agent = Roster.getByID(agentID)!
        const msg = Execute.buildContinueMessage(
          agent,
          teamID,
          "Build auth system",
          "implementation",
          "Implemented login endpoint",
          1,
          "Write unit tests for login",
        )

        expect(msg).toContain("Build auth system")
        expect(msg).toContain("developer")
        expect(msg).toContain("implementation")
        expect(msg).toContain("step 2") // stepIndex 1 => "step 2"
        expect(msg).toContain("Implemented login endpoint")
        expect(msg).toContain("Write unit tests for login")
        expect(msg).toContain("## Your Next Step")
      },
    })
  })

  test("uses fallback text when no continue description", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "architect")
        Workspace.create(teamID, "Design API")

        const agent = Roster.getByID(agentID)!
        const msg = Execute.buildContinueMessage(agent, teamID, "Design API", "design", "Previous step done", 2)

        expect(msg).toContain("## Continue Your Assignment")
        expect(msg).not.toContain("## Your Next Step")
      },
    })
  })

  test("includes open questions routed to agent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Build auth system")

        Workspace.addQuestion(teamID, {
          question: "Should we use OAuth2 or SAML?",
          asked_by: "architect",
          routed_to: "developer",
          status: "open",
        })

        // Question for a different role — should NOT appear
        Workspace.addQuestion(teamID, {
          question: "Is the DB normalized?",
          asked_by: "developer",
          routed_to: "architect",
          status: "open",
        })

        const agent = Roster.getByID(agentID)!
        const msg = Execute.buildContinueMessage(
          agent,
          teamID,
          "Build auth system",
          "implementation",
          "Previous step done",
          1,
          "Answer outstanding questions",
        )

        expect(msg).toContain("## Questions Routed to You")
        expect(msg).toContain("Should we use OAuth2 or SAML?")
        expect(msg).toContain("From architect:")
        // The "Questions Routed to You" section should only have questions for developer.
        // Extract the section and verify architect's question is NOT in it.
        const routedSection = msg.split("## Questions Routed to You")[1]?.split("##")[0] ?? ""
        expect(routedSection).not.toContain("Is the DB normalized?")
      },
    })
  })

  test("includes updated decisions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const agentID = insertAgent(teamID, "developer")
        Workspace.create(teamID, "Test project")

        Workspace.addDecision(teamID, {
          description: "Use REST API",
          rationale: "Simpler",
          alternatives: ["GraphQL"],
          made_by: "architect",
          status: "approved",
        })

        const agent = Roster.getByID(agentID)!
        const msg = Execute.buildContinueMessage(
          agent,
          teamID,
          "Test project",
          "implementation",
          "Step 1 done",
          1,
          "Step 2",
        )

        expect(msg).toContain("Use REST API")
        expect(msg).toContain("Decisions (may have been updated)")
      },
    })
  })
})

describe("Execute.mergeResults", () => {
  function makeResult(overrides: Partial<Execute.AgentResult> = {}): Execute.AgentResult {
    return {
      text: "",
      proposals: [],
      questions: [],
      concerns: [],
      artifacts: [],
      spawnRequests: [],
      complete: false,
      continuing: false,
      critiques: [],
      approved: false,
      toolCalls: [],
      ...overrides,
    }
  }

  function makeStep(index: number, result: Execute.AgentResult, description = `Step ${index}`): Execute.SubStep {
    return { index, description, result, timestamp: Date.now() }
  }

  test("joins text with separator", () => {
    const steps = [
      makeStep(0, makeResult({ text: "Step one output" })),
      makeStep(1, makeResult({ text: "Step two output" })),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.text).toBe("Step one output\n\n---\n\nStep two output")
  })

  test("flatMaps proposals across steps", () => {
    const steps = [makeStep(0, makeResult({ proposals: ["P1", "P2"] })), makeStep(1, makeResult({ proposals: ["P3"] }))]
    const merged = Execute.mergeResults(steps)
    expect(merged.proposals).toEqual(["P1", "P2", "P3"])
  })

  test("flatMaps questions across steps", () => {
    const steps = [
      makeStep(0, makeResult({ questions: [{ target: "arch", content: "Q1" }] })),
      makeStep(1, makeResult({ questions: [{ target: "qa", content: "Q2" }] })),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.questions).toEqual([
      { target: "arch", content: "Q1" },
      { target: "qa", content: "Q2" },
    ])
  })

  test("flatMaps concerns across steps", () => {
    const steps = [makeStep(0, makeResult({ concerns: ["C1"] })), makeStep(1, makeResult({ concerns: ["C2", "C3"] }))]
    const merged = Execute.mergeResults(steps)
    expect(merged.concerns).toEqual(["C1", "C2", "C3"])
  })

  test("flatMaps artifacts across steps", () => {
    const steps = [makeStep(0, makeResult({ artifacts: ["A1"] })), makeStep(1, makeResult({ artifacts: ["A2"] }))]
    const merged = Execute.mergeResults(steps)
    expect(merged.artifacts).toEqual(["A1", "A2"])
  })

  test("flatMaps spawnRequests across steps", () => {
    const steps = [
      makeStep(0, makeResult({ spawnRequests: [{ role: "qa", reason: "need tests" }] })),
      makeStep(1, makeResult({ spawnRequests: [{ role: "security-reviewer", reason: "audit" }] })),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.spawnRequests).toEqual([
      { role: "qa", reason: "need tests" },
      { role: "security-reviewer", reason: "audit" },
    ])
  })

  test("flatMaps critiques across steps", () => {
    const steps = [
      makeStep(0, makeResult({ critiques: ["Bad naming"] })),
      makeStep(1, makeResult({ critiques: ["Missing error handling"] })),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.critiques).toEqual(["Bad naming", "Missing error handling"])
  })

  test("flatMaps toolCalls across steps", () => {
    const tc1: Execute.ToolCallInfo = { tool: "edit", title: "Edit", input: { filePath: "a.ts" }, output: "ok" }
    const tc2: Execute.ToolCallInfo = { tool: "bash", title: "Run", input: { command: "test" }, output: "ok" }
    const steps = [makeStep(0, makeResult({ toolCalls: [tc1] })), makeStep(1, makeResult({ toolCalls: [tc2] }))]
    const merged = Execute.mergeResults(steps)
    expect(merged.toolCalls).toEqual([tc1, tc2])
  })

  test("complete taken from last step", () => {
    const steps = [
      makeStep(0, makeResult({ complete: false })),
      makeStep(1, makeResult({ complete: true, completeSummary: "All done" })),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.complete).toBe(true)
    expect(merged.completeSummary).toBe("All done")
  })

  test("complete false when last step is not complete", () => {
    const steps = [
      makeStep(0, makeResult({ complete: true, completeSummary: "Step 1 done" })),
      makeStep(1, makeResult({ complete: false })),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.complete).toBe(false)
    expect(merged.completeSummary).toBeUndefined()
  })

  test("continuing is always false in merged result", () => {
    const steps = [
      makeStep(0, makeResult({ continuing: true, continueDescription: "more work" })),
      makeStep(1, makeResult({ continuing: true, continueDescription: "even more" })),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.continuing).toBe(false)
  })

  test("approved is true if ANY step approved", () => {
    const steps = [makeStep(0, makeResult({ approved: false })), makeStep(1, makeResult({ approved: true }))]
    const merged = Execute.mergeResults(steps)
    expect(merged.approved).toBe(true)
  })

  test("approved is false when no step approved", () => {
    const steps = [makeStep(0, makeResult({ approved: false })), makeStep(1, makeResult({ approved: false }))]
    const merged = Execute.mergeResults(steps)
    expect(merged.approved).toBe(false)
  })

  test("approved true from first step only", () => {
    const steps = [makeStep(0, makeResult({ approved: true })), makeStep(1, makeResult({ approved: false }))]
    const merged = Execute.mergeResults(steps)
    expect(merged.approved).toBe(true)
  })

  test("single step returns its result mostly unchanged", () => {
    const result = makeResult({
      text: "Only step",
      proposals: ["P1"],
      complete: true,
      completeSummary: "Done",
      approved: true,
    })
    const steps = [makeStep(0, result)]
    const merged = Execute.mergeResults(steps)
    expect(merged.text).toBe("Only step")
    expect(merged.proposals).toEqual(["P1"])
    expect(merged.complete).toBe(true)
    expect(merged.completeSummary).toBe("Done")
    expect(merged.approved).toBe(true)
    expect(merged.continuing).toBe(false)
  })

  test("empty steps array", () => {
    const merged = Execute.mergeResults([])
    expect(merged.text).toBe("")
    expect(merged.proposals).toEqual([])
    expect(merged.questions).toEqual([])
    expect(merged.concerns).toEqual([])
    expect(merged.artifacts).toEqual([])
    expect(merged.spawnRequests).toEqual([])
    expect(merged.critiques).toEqual([])
    expect(merged.toolCalls).toEqual([])
    expect(merged.complete).toBe(false)
    expect(merged.completeSummary).toBeUndefined()
    expect(merged.continuing).toBe(false)
    expect(merged.approved).toBe(false)
  })

  test("three steps merge all arrays correctly", () => {
    const steps = [
      makeStep(0, makeResult({ proposals: ["P1"], artifacts: ["A1"], text: "One" })),
      makeStep(1, makeResult({ proposals: ["P2"], concerns: ["C1"], text: "Two" })),
      makeStep(
        2,
        makeResult({
          proposals: ["P3"],
          critiques: ["K1"],
          text: "Three",
          complete: true,
          completeSummary: "Finished",
        }),
      ),
    ]
    const merged = Execute.mergeResults(steps)
    expect(merged.proposals).toEqual(["P1", "P2", "P3"])
    expect(merged.artifacts).toEqual(["A1"])
    expect(merged.concerns).toEqual(["C1"])
    expect(merged.critiques).toEqual(["K1"])
    expect(merged.complete).toBe(true)
    expect(merged.completeSummary).toBe("Finished")
    expect(merged.text).toContain("One")
    expect(merged.text).toContain("Two")
    expect(merged.text).toContain("Three")
    expect(merged.text).toContain("---")
  })
})
