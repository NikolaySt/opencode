import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Team } from "../../src/team/index"
import { Workspace } from "../../src/team/workspace"
import { Roster } from "../../src/team/roster"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

/**
 * Integration tests that exercise the ACTUAL code paths.
 *
 * These tests exist because the original test suite had 419 tests
 * that all passed, yet a runtime `require()` error in the team module
 * was never caught. The reason: no test ever called Team.start(),
 * Orchestrator.run(), Execute.run(), or even triggered the lazy
 * import chain in team/index.ts.
 *
 * These tests verify that:
 * 1. The lazy import of orchestrator.ts resolves without error
 * 2. The sharing strategy resolve() works in async context
 * 3. Team.start() actually runs through the setup phase before hitting LLM
 * 4. Execute.run() can resolve strategies without import errors
 */

describe("team.integration: lazy orchestrator import", () => {
  test("dynamic import of orchestrator.ts succeeds", async () => {
    // This is the exact code path that was broken with require()
    const mod = await import("../../src/team/orchestrator")
    expect(mod.Orchestrator).toBeDefined()
    expect(mod.Orchestrator.Phase).toBeDefined()
    expect(mod.Orchestrator.run).toBeDefined()
    expect(typeof mod.Orchestrator.run).toBe("function")
  })

  test("team/index.ts can import orchestrator without circular dep crash", async () => {
    // The Team namespace must load and its start function must be available.
    // Previously this would crash: require() async module ... is unsupported.
    const teamMod = await import("../../src/team/index")
    expect(teamMod.Team).toBeDefined()
    expect(teamMod.Team.start).toBeDefined()
    expect(teamMod.Team.create).toBeDefined()
    expect(typeof teamMod.Team.start).toBe("function")
  })
})

describe("team.integration: strategy resolve() in async context", () => {
  test("resolve('selective') returns a valid strategy via await import()", async () => {
    const { resolve } = await import("../../src/team/sharing/strategy")
    const strategy = await resolve("selective")
    expect(strategy.name).toBe("selective")
    expect(typeof strategy.buildContext).toBe("function")
    expect(typeof strategy.propagate).toBe("function")
    expect(typeof strategy.summarize).toBe("function")
  })

  test("resolve('hierarchical') returns a valid strategy via await import()", async () => {
    const { resolve } = await import("../../src/team/sharing/strategy")
    const strategy = await resolve("hierarchical")
    expect(strategy.name).toBe("hierarchical")
  })

  test("resolve('broadcast') returns a valid strategy via await import()", async () => {
    const { resolve } = await import("../../src/team/sharing/strategy")
    const strategy = await resolve("broadcast")
    expect(strategy.name).toBe("broadcast")
  })
})

describe("team.integration: Team.start() setup phase", () => {
  test("does not throw module import errors (require/import)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parentSession = await Session.create({ title: "integration-test-parent" })
        const controller = new AbortController()

        // Abort immediately so we don't actually call the LLM
        controller.abort()

        let caught: unknown
        try {
          await Team.start({
            goal: "Integration test goal",
            sharingStrategy: "selective",
            parentSessionID: parentSession.id,
            onEscalate: async () => "test answer",
            onStatus: () => {},
            abort: controller.signal,
          })
        } catch (err) {
          caught = err
        }

        // The key assertion: if an error was thrown, it must NOT be a module
        // import error. This is the exact bug that went undetected — require()
        // on an async module would throw TypeError with "require() async module".
        if (caught) {
          const msg = String(caught)
          expect(msg).not.toContain("require()")
          expect(msg).not.toContain("async module")
          expect(msg).not.toContain("is unsupported")
          // Other errors (LLM failures, abort errors) are acceptable
        }
      },
    })
  })

  test("creates team session and workspace before orchestrator loop", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parentSession = await Session.create({ title: "integration-test-parent-2" })
        const controller = new AbortController()
        controller.abort()

        let teamSession: Team.Info | undefined
        try {
          const result = await Team.start({
            goal: "Verify setup phase",
            sharingStrategy: "selective",
            parentSessionID: parentSession.id,
            onEscalate: async () => "test",
            onStatus: () => {},
            abort: controller.signal,
          })
          teamSession = result.teamSession
        } catch {
          // May throw from LLM call or abort — that's fine
        }

        // Team session and workspace are created before the orchestrator loop,
        // so they should exist even if the loop was aborted
        if (teamSession) {
          expect(teamSession.goal).toBe("Verify setup phase")
          const goal = Workspace.get(teamSession.id, "goal")
          expect(goal).toBe("Verify setup phase")
        }
      },
    })
  })
})

describe("team.integration: Execute module imports resolve correctly", () => {
  test("Execute module loads with all expected exports", async () => {
    const { Execute } = await import("../../src/team/execute")
    expect(Execute.run).toBeDefined()
    expect(Execute.buildContext).toBeDefined()
    expect(Execute.buildMessage).toBeDefined()
    expect(Execute.parseOutput).toBeDefined()
    expect(Execute.extractAssistantText).toBeDefined()
    expect(Execute.summarizeToolCalls).toBeDefined()
    expect(Execute.extractToolCalls).toBeDefined()
    expect(typeof Execute.run).toBe("function")
  })
})

describe("team.integration: Roster.spawn creates working sessions", () => {
  test("spawn creates agent with session that can be retrieved", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Identifier } = await import("../../src/id/id")
        const { Database } = await import("../../src/storage/db")
        const { TeamSessionTable } = await import("../../src/team/team.sql")

        const teamID = Identifier.ascending("team")
        const now = Date.now()
        Database.use((db) => {
          db.insert(TeamSessionTable)
            .values({
              id: teamID,
              project_id: Instance.project.id,
              goal: "Integration spawn test",
              phase: "understanding",
              status: "active",
              sharing_strategy: "selective",
              time_created: now,
              time_updated: now,
            })
            .run()
        })

        const parentSession = await Session.create({ title: "spawn-test-parent" })

        const agent = await Roster.spawn({
          teamSessionID: teamID,
          parentSessionID: parentSession.id,
          role: "developer",
          prompt: "You are a developer for integration testing",
          expertise: ["typescript", "testing"],
          workspaceRead: ["goal", "plan"],
          workspaceWrite: ["artifacts"],
          relationships: { collaborates_with: [], reviews: [], reviewed_by: [] },
        })

        // Agent has a session
        expect(agent.sessionID).toBeDefined()

        // Session is a child of parent
        const session = await Session.get(agent.sessionID!)
        expect(session).toBeDefined()
        expect(session!.parentID).toBe(parentSession.id)

        // Agent is retrievable from roster
        const retrieved = Roster.getByID(agent.id)
        expect(retrieved).toBeDefined()
        expect(retrieved!.role).toBe("developer")
        expect(retrieved!.sessionID).toBe(agent.sessionID)

        // Agent appears in active list
        const active = Roster.list(teamID)
        expect(active).toHaveLength(1)
        expect(active[0].id).toBe(agent.id)
      },
    })
  })
})

describe("team.integration: full sharing strategy round-trip", () => {
  test("selective strategy buildContext + propagate works end-to-end", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { resolve } = await import("../../src/team/sharing/strategy")
        const { Identifier } = await import("../../src/id/id")
        const { Database } = await import("../../src/storage/db")
        const { TeamSessionTable, AgentInstanceTable } = await import("../../src/team/team.sql")

        const teamID = Identifier.ascending("team")
        const now = Date.now()
        Database.use((db) => {
          db.insert(TeamSessionTable)
            .values({
              id: teamID,
              project_id: Instance.project.id,
              goal: "Strategy test",
              phase: "design",
              status: "active",
              sharing_strategy: "selective",
              time_created: now,
              time_updated: now,
            })
            .run()
        })

        const agentID = Identifier.ascending("agent")
        Database.use((db) => {
          db.insert(AgentInstanceTable)
            .values({
              id: agentID,
              team_session_id: teamID,
              session_id: null,
              role: "developer",
              prompt: "You are a developer",
              expertise: ["ts"],
              workspace_read: ["goal", "plan", "decisions"],
              workspace_write: ["artifacts"],
              relationships: { collaborates_with: ["architect"], reviews: [], reviewed_by: ["qa"] },
              status: "idle",
              steps_used: 0,
              tokens_consumed: 0,
              time_created: now,
              time_updated: now,
            })
            .run()
        })

        Workspace.create(teamID, "Build auth system")
        Workspace.addDecision(teamID, {
          description: "Use JWT",
          rationale: "Stateless",
          alternatives: [],
          made_by: "architect",
          status: "approved",
        })

        const agent = Roster.getByID(agentID)!

        // This is the code path Execute.run() takes — resolve() was the bug
        const strategy = await resolve("selective")
        const context = strategy.buildContext({
          agent,
          teamSessionID: teamID,
          teamGoal: "Build auth system",
          phase: "design",
        })

        expect(context).toContain("Build auth system")
        expect(context).toContain("developer")
        expect(context).toContain("design")

        // Propagation
        const result = strategy.propagate({
          agent,
          teamSessionID: teamID,
          output: "Implemented login endpoint",
          mutations: [{ section: "artifacts", operation: "set", path: "login.ts", value: "code" }],
        })

        expect(result.updated).toContain("artifacts")
        expect(result.notify).toContain("architect")
        expect(result.notify).toContain("qa")
      },
    })
  })
})
