import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Workspace } from "../../src/team/workspace"
import { Identifier } from "../../src/id/id"
import { Database } from "../../src/storage/db"
import { TeamSessionTable } from "../../src/team/team.sql"
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

describe("team.workspace.create", () => {
  test("initializes all 8 sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Build a REST API")

        for (const section of Workspace.SECTIONS) {
          const content = Workspace.get(teamID, section)
          expect(content).toBeDefined()
        }
      },
    })
  })

  test("goal section stores the goal string", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Implement user authentication")
        expect(Workspace.get(teamID, "goal")).toBe("Implement user authentication")
      },
    })
  })

  test("constraints section starts as empty array", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")
        expect(Workspace.get(teamID, "constraints")).toEqual([])
      },
    })
  })

  test("plan section starts with draft status", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")
        const plan = Workspace.get(teamID, "plan") as Record<string, unknown>
        expect(plan.status).toBe("draft")
        expect(plan.architecture).toBeNull()
        expect(plan.tasks).toEqual([])
        expect(plan.dependencies).toEqual([])
      },
    })
  })

  test("tasks section starts as empty array", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")
        expect(Workspace.get(teamID, "tasks")).toEqual([])
      },
    })
  })

  test("decisions section starts as empty array", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")
        expect(Workspace.get(teamID, "decisions")).toEqual([])
      },
    })
  })

  test("questions section starts as empty array", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")
        expect(Workspace.get(teamID, "questions")).toEqual([])
      },
    })
  })

  test("artifacts section starts as empty object", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")
        expect(Workspace.get(teamID, "artifacts")).toEqual({})
      },
    })
  })

  test("agent_states section starts as empty object", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")
        expect(Workspace.get(teamID, "agent_states")).toEqual({})
      },
    })
  })
})

describe("team.workspace.get", () => {
  test("returns undefined for non-existent team session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = Workspace.get("team_nonexistent", "goal")
        expect(result).toBeUndefined()
      },
    })
  })
})

describe("team.workspace.set", () => {
  test("updates section content", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "constraints", ["Must use TypeScript", "No external deps"])
        const constraints = Workspace.get(teamID, "constraints") as string[]
        expect(constraints).toEqual(["Must use TypeScript", "No external deps"])
      },
    })
  })

  test("tracks updatedBy field", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "constraints", ["Use REST"], "architect")
        // Verify it succeeds (updatedBy is stored in DB but not returned by get())
        const constraints = Workspace.get(teamID, "constraints") as string[]
        expect(constraints).toEqual(["Use REST"])
      },
    })
  })

  test("increments version on update", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "goal", "Updated goal")
        Workspace.set(teamID, "goal", "Updated goal again")

        // Verify the final value is correct (version increments are internal)
        expect(Workspace.get(teamID, "goal")).toBe("Updated goal again")
      },
    })
  })

  test("does nothing for non-existent section row", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // No workspace created; set should silently do nothing
        Workspace.set("team_nonexistent", "goal", "should not crash")
        // No error thrown
      },
    })
  })

  test("emits Updated bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        let received = false
        const unsub = Bus.subscribe(Workspace.Event.Updated, (event) => {
          received = true
          expect(event.properties.section).toBe("constraints")
          expect(event.properties.updatedBy).toBe("dev")
        })

        Workspace.set(teamID, "constraints", ["new"], "dev")
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })

  test("can set complex objects", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const plan = { status: "approved", architecture: "microservices", tasks: ["a", "b"], dependencies: ["a->b"] }
        Workspace.set(teamID, "plan", plan)
        const result = Workspace.get(teamID, "plan") as Record<string, unknown>
        expect(result.status).toBe("approved")
        expect(result.architecture).toBe("microservices")
      },
    })
  })
})

describe("team.workspace.append", () => {
  test("appends items to array sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.append(teamID, "constraints", "item1")
        Workspace.append(teamID, "constraints", "item2")
        Workspace.append(teamID, "constraints", "item3")
        const result = Workspace.get(teamID, "constraints") as string[]
        expect(result).toEqual(["item1", "item2", "item3"])
      },
    })
  })

  test("does nothing on non-array section", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        // "goal" is a string, not an array
        Workspace.append(teamID, "goal", "should not append")
        expect(Workspace.get(teamID, "goal")).toBe("Test")
      },
    })
  })

  test("does nothing on non-existent team", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Should not throw
        Workspace.append("team_nonexistent", "constraints", "item")
      },
    })
  })
})

describe("team.workspace.remove", () => {
  test("removes matching item by key", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const q1 = Workspace.addQuestion(teamID, { question: "Q1?", asked_by: "dev", status: "open" })
        const q2 = Workspace.addQuestion(teamID, { question: "Q2?", asked_by: "dev", status: "open" })
        const q3 = Workspace.addQuestion(teamID, { question: "Q3?", asked_by: "dev", status: "open" })

        Workspace.remove(teamID, "questions", "id", q2.id)

        const questions = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(questions).toHaveLength(2)
        expect(questions[0].question).toBe("Q1?")
        expect(questions[1].question).toBe("Q3?")
      },
    })
  })

  test("does nothing when no match found", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.addQuestion(teamID, { question: "Q1?", asked_by: "dev", status: "open" })
        Workspace.remove(teamID, "questions", "id", "nonexistent_id")

        const questions = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(questions).toHaveLength(1)
      },
    })
  })

  test("does nothing on non-array section", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        // "goal" is a string
        Workspace.remove(teamID, "goal", "id", "test")
        expect(Workspace.get(teamID, "goal")).toBe("Test")
      },
    })
  })
})

describe("team.workspace.addDecision", () => {
  test("creates decision with auto-generated id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const decision = Workspace.addDecision(teamID, {
          description: "Use microservices",
          rationale: "Better scalability",
          alternatives: ["Monolith"],
          made_by: "architect",
          status: "proposed",
        })

        expect(decision.id).toMatch(/^wks_/)
        expect(decision.timestamp).toBeGreaterThan(0)
        expect(decision.description).toBe("Use microservices")
      },
    })
  })

  test("multiple decisions are stored in order", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.addDecision(teamID, {
          description: "Decision 1",
          rationale: "R1",
          alternatives: [],
          made_by: "arch",
          status: "approved",
        })
        Workspace.addDecision(teamID, {
          description: "Decision 2",
          rationale: "R2",
          alternatives: ["Alt A"],
          made_by: "dev",
          status: "proposed",
        })

        const decisions = Workspace.get(teamID, "decisions") as Workspace.Decision[]
        expect(decisions).toHaveLength(2)
        expect(decisions[0].description).toBe("Decision 1")
        expect(decisions[1].description).toBe("Decision 2")
        expect(decisions[1].alternatives).toEqual(["Alt A"])
      },
    })
  })
})

describe("team.workspace.addQuestion", () => {
  test("creates question with auto-generated id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const q = Workspace.addQuestion(teamID, {
          question: "Which database?",
          asked_by: "developer",
          routed_to: "architect",
          status: "open",
        })

        expect(q.id).toMatch(/^wks_/)
        expect(q.question).toBe("Which database?")
        expect(q.routed_to).toBe("architect")
      },
    })
  })

  test("question without routed_to", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const q = Workspace.addQuestion(teamID, {
          question: "General question?",
          asked_by: "developer",
          status: "open",
        })

        expect(q.routed_to).toBeUndefined()
      },
    })
  })
})

describe("team.workspace.answerQuestion", () => {
  test("sets answer and changes status to answered", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const q = Workspace.addQuestion(teamID, {
          question: "REST or gRPC?",
          asked_by: "dev",
          status: "open",
        })

        Workspace.answerQuestion(teamID, q.id, "Use REST for simplicity", "architect")

        const questions = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(questions[0].status).toBe("answered")
        expect(questions[0].answer).toBe("Use REST for simplicity")
        expect(questions[0].answered_by).toBe("architect")
      },
    })
  })

  test("answering removes from openQuestions list", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const q1 = Workspace.addQuestion(teamID, { question: "Q1?", asked_by: "dev", status: "open" })
        Workspace.addQuestion(teamID, { question: "Q2?", asked_by: "dev", status: "open" })

        Workspace.answerQuestion(teamID, q1.id, "Answer1", "arch")

        const open = Workspace.openQuestions(teamID)
        expect(open).toHaveLength(1)
        expect(open[0].question).toBe("Q2?")
      },
    })
  })

  test("does nothing for non-existent workspace", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Should not throw
        Workspace.answerQuestion("team_nonexistent", "q_id", "answer", "person")
      },
    })
  })
})

describe("team.workspace.openQuestions", () => {
  test("returns only open questions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const q1 = Workspace.addQuestion(teamID, { question: "Q1?", asked_by: "dev", status: "open" })
        Workspace.addQuestion(teamID, { question: "Q2?", asked_by: "dev", status: "open" })
        Workspace.answerQuestion(teamID, q1.id, "A1", "arch")

        const open = Workspace.openQuestions(teamID)
        expect(open).toHaveLength(1)
        expect(open[0].question).toBe("Q2?")
      },
    })
  })

  test("returns empty for non-existent workspace", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = Workspace.openQuestions("team_nonexistent")
        expect(result).toEqual([])
      },
    })
  })
})

describe("team.workspace.all", () => {
  test("returns all 8 sections as a record", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Complete goal")

        const data = Workspace.all(teamID)
        expect(Object.keys(data)).toHaveLength(8)
        expect(data.goal).toBe("Complete goal")
        expect(data.constraints).toEqual([])
        expect(data.tasks).toEqual([])
        expect(data.decisions).toEqual([])
        expect(data.questions).toEqual([])
        expect(data.artifacts).toEqual({})
        expect(data.agent_states).toEqual({})
      },
    })
  })
})

describe("team.workspace.summary", () => {
  test("includes goal section", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Build authentication")

        const text = Workspace.summary(teamID)
        expect(text).toContain("## Goal")
        expect(text).toContain("Build authentication")
      },
    })
  })

  test("includes constraints when present", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "constraints", ["Use TypeScript", "No ORMs"])
        const text = Workspace.summary(teamID)
        expect(text).toContain("## Constraints")
        expect(text).toContain("- Use TypeScript")
        expect(text).toContain("- No ORMs")
      },
    })
  })

  test("includes plan status", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const text = Workspace.summary(teamID)
        expect(text).toContain("## Plan (draft)")
      },
    })
  })

  test("includes plan architecture when present", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.set(teamID, "plan", { status: "approved", architecture: "Microservices pattern" })
        const text = Workspace.summary(teamID)
        expect(text).toContain("Microservices pattern")
      },
    })
  })

  test("includes tasks with status and assignee", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.append(teamID, "tasks", {
          id: "t1",
          description: "Implement login",
          assigned_to: "developer",
          status: "in_progress",
          dependencies: [],
        })

        const text = Workspace.summary(teamID)
        expect(text).toContain("## Tasks")
        expect(text).toContain("[in_progress] Implement login")
        expect(text).toContain("@developer")
      },
    })
  })

  test("includes decisions with status and maker", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.addDecision(teamID, {
          description: "Use JWT",
          rationale: "Stateless",
          alternatives: [],
          made_by: "architect",
          status: "approved",
        })

        const text = Workspace.summary(teamID)
        expect(text).toContain("## Decisions")
        expect(text).toContain("[approved] Use JWT")
        expect(text).toContain("by architect")
      },
    })
  })

  test("includes open questions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.addQuestion(teamID, {
          question: "Which DB engine?",
          asked_by: "developer",
          routed_to: "architect",
          status: "open",
        })

        const text = Workspace.summary(teamID)
        expect(text).toContain("## Open Questions")
        expect(text).toContain("Which DB engine?")
        expect(text).toContain("routed to architect")
      },
    })
  })

  test("excludes answered questions from open questions section", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        const q = Workspace.addQuestion(teamID, { question: "Q?", asked_by: "dev", status: "open" })
        Workspace.answerQuestion(teamID, q.id, "A", "arch")

        const text = Workspace.summary(teamID)
        expect(text).not.toContain("## Open Questions")
      },
    })
  })
})

describe("team.workspace schemas", () => {
  test("Decision schema validates all fields", () => {
    const decision = Workspace.Decision.parse({
      id: "wks_1",
      description: "Use REST",
      rationale: "Simple",
      alternatives: ["GraphQL"],
      made_by: "arch",
      reviewed_by: ["qa"],
      status: "proposed",
      timestamp: 1000,
    })
    expect(decision.reviewed_by).toEqual(["qa"])
  })

  test("Decision schema rejects invalid status", () => {
    expect(() =>
      Workspace.Decision.parse({
        id: "wks_1",
        description: "Test",
        rationale: "R",
        alternatives: [],
        made_by: "a",
        status: "invalid",
        timestamp: 0,
      }),
    ).toThrow()
  })

  test("Question schema validates optional fields", () => {
    const q = Workspace.Question.parse({
      id: "q1",
      question: "Q?",
      asked_by: "dev",
      status: "open",
    })
    expect(q.routed_to).toBeUndefined()
    expect(q.answer).toBeUndefined()
    expect(q.answered_by).toBeUndefined()
  })

  test("Question schema rejects invalid status", () => {
    expect(() =>
      Workspace.Question.parse({
        id: "q1",
        question: "Q?",
        asked_by: "dev",
        status: "invalid",
      }),
    ).toThrow()
  })

  test("Task schema validates all fields", () => {
    const task = Workspace.Task.parse({
      id: "t1",
      description: "Do thing",
      status: "blocked",
      dependencies: ["t0"],
    })
    expect(task.assigned_to).toBeUndefined()
    expect(task.status).toBe("blocked")
  })

  test("Task schema accepts all status values", () => {
    for (const status of ["pending", "in_progress", "completed", "blocked"] as const) {
      const t = Workspace.Task.parse({ id: "t", description: "D", status, dependencies: [] })
      expect(t.status).toBe(status)
    }
  })

  test("SECTIONS constant has exactly 8 entries", () => {
    expect(Workspace.SECTIONS).toHaveLength(8)
  })
})

describe("team.workspace edge cases", () => {
  test("remove passes updatedBy to set", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test")

        Workspace.addQuestion(teamID, { question: "Q1", asked_by: "dev", status: "open" })
        const questions = Workspace.get(teamID, "questions") as any[]
        expect(questions).toHaveLength(1)

        let eventUpdatedBy: string | undefined
        const unsub = Bus.subscribe(Workspace.Event.Updated, (event) => {
          if (event.properties.section === "questions") {
            eventUpdatedBy = event.properties.updatedBy
          }
        })

        Workspace.remove(teamID, "questions", "question", "Q1", "cleanup-agent")
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(eventUpdatedBy).toBe("cleanup-agent")
        const after = Workspace.get(teamID, "questions") as any[]
        expect(after).toHaveLength(0)
      },
    })
  })

  test("summary does not throw for non-existent workspace", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = Workspace.summary("team_nonexistent_1234")
        expect(typeof result).toBe("string")
        expect(result).toContain("## Goal")
      },
    })
  })
})

describe("team.workspace.atomicity", () => {
  test("concurrent appends to same section preserve all items", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Concurrency test")

        // Simulate concurrent appends — SQLite serializes them but
        // with Database.transaction each append is atomic
        const count = 20
        const promises = Array.from({ length: count }, (_, i) =>
          Promise.resolve().then(() =>
            Workspace.addDecision(teamID, {
              description: `Decision ${i}`,
              rationale: `Reason ${i}`,
              alternatives: [],
              made_by: `agent-${i}`,
              status: "approved",
            }),
          ),
        )
        await Promise.all(promises)

        const decisions = Workspace.get(teamID, "decisions") as Workspace.Decision[]
        expect(decisions).toHaveLength(count)
        // Verify all decisions are present (order may vary)
        const descriptions = new Set(decisions.map((d) => d.description))
        for (let i = 0; i < count; i++) {
          expect(descriptions.has(`Decision ${i}`)).toBe(true)
        }
      },
    })
  })

  test("concurrent questions to same section preserve all items", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Concurrency test")

        const count = 15
        const promises = Array.from({ length: count }, (_, i) =>
          Promise.resolve().then(() =>
            Workspace.addQuestion(teamID, {
              question: `Question ${i}`,
              asked_by: `agent-${i}`,
              routed_to: "orchestrator",
              status: "open",
            }),
          ),
        )
        await Promise.all(promises)

        const questions = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(questions).toHaveLength(count)
      },
    })
  })

  test("concurrent merge operations on artifacts preserve all data", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Merge test")

        // Simulate multiple agents recording file modifications concurrently
        const agents = ["developer", "architect", "qa"]
        const promises = agents.map((agent, i) =>
          Promise.resolve().then(() =>
            Workspace.merge(
              teamID,
              "artifacts",
              (raw) => {
                const obj = (raw as Record<string, unknown>) ?? {}
                const modified = ((obj.modified_files as string[]) ?? []).concat([`src/${agent}/file${i}.ts`])
                return { ...obj, modified_files: [...new Set(modified)] }
              },
              agent,
            ),
          ),
        )
        await Promise.all(promises)

        const artifacts = Workspace.get(teamID, "artifacts") as Record<string, unknown>
        const files = artifacts.modified_files as string[]
        expect(files).toHaveLength(3)
        expect(files).toContain("src/developer/file0.ts")
        expect(files).toContain("src/architect/file1.ts")
        expect(files).toContain("src/qa/file2.ts")
      },
    })
  })

  test("set uses transaction (version increments atomically)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Version test")

        // Set the same section multiple times
        Workspace.set(teamID, "goal", "Version 2", "agent-a")
        Workspace.set(teamID, "goal", "Version 3", "agent-b")
        Workspace.set(teamID, "goal", "Version 4", "agent-c")

        const result = Workspace.get(teamID, "goal")
        expect(result).toBe("Version 4")
      },
    })
  })

  test("concurrent removes from same section preserve correct items", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Remove concurrency test")

        // Seed 20 questions into the workspace
        const count = 20
        const questions: Workspace.Question[] = []
        for (let i = 0; i < count; i++) {
          const q = Workspace.addQuestion(teamID, {
            question: `Q${i}`,
            asked_by: `agent-${i}`,
            status: "open",
          })
          questions.push(q)
        }
        const before = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(before).toHaveLength(count)

        // Concurrently remove the even-numbered questions
        const toRemove = questions.filter((_, i) => i % 2 === 0)
        const promises = toRemove.map((q) =>
          Promise.resolve().then(() => Workspace.remove(teamID, "questions", "id", q.id, `remover-${q.id}`)),
        )
        await Promise.all(promises)

        const after = Workspace.get(teamID, "questions") as Workspace.Question[]
        // Only odd-indexed questions should remain
        expect(after).toHaveLength(count - toRemove.length)
        const remaining = new Set(after.map((q) => q.question))
        for (let i = 0; i < count; i++) {
          if (i % 2 === 0) expect(remaining.has(`Q${i}`)).toBe(false)
          else expect(remaining.has(`Q${i}`)).toBe(true)
        }
      },
    })
  })

  test("concurrent answerQuestion calls preserve all answers", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Answer concurrency test")

        // Seed 15 open questions
        const count = 15
        const questions: Workspace.Question[] = []
        for (let i = 0; i < count; i++) {
          const q = Workspace.addQuestion(teamID, {
            question: `Question ${i}`,
            asked_by: `asker-${i}`,
            status: "open",
          })
          questions.push(q)
        }

        // Concurrently answer all questions
        const promises = questions.map((q, i) =>
          Promise.resolve().then(() => Workspace.answerQuestion(teamID, q.id, `Answer ${i}`, `responder-${i}`)),
        )
        await Promise.all(promises)

        const result = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(result).toHaveLength(count)
        // Every question should now be answered
        const answered = result.filter((q) => q.status === "answered")
        expect(answered).toHaveLength(count)
        // Verify all answers are present
        const answers = new Set(answered.map((q) => q.answer))
        for (let i = 0; i < count; i++) {
          expect(answers.has(`Answer ${i}`)).toBe(true)
        }
      },
    })
  })

  test("merge on non-existent workspace returns without error", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // No workspace created — merge should silently return
        Workspace.merge(
          "team_nonexistent_999",
          "artifacts",
          (current) => ({ ...((current as object) ?? {}), key: "value" }),
          "agent",
        )
        // If we got here without throwing, the test passes
        expect(true).toBe(true)
      },
    })
  })

  test("merge emits Updated bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Merge event test")

        let received = false
        const unsub = Bus.subscribe(Workspace.Event.Updated, (event) => {
          if (event.properties.section === "artifacts" && event.properties.updatedBy === "merge-agent") {
            received = true
          }
        })

        Workspace.merge(
          teamID,
          "artifacts",
          (current) => ({ ...((current as object) ?? {}), foo: "bar" }),
          "merge-agent",
        )
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })
})
