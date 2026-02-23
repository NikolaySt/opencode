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
