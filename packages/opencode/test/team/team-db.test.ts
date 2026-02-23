import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Workspace } from "../../src/team/workspace"
import { TeamMessage } from "../../src/team/message"
import { Review } from "../../src/team/review"
import { Identifier } from "../../src/id/id"
import { Database } from "../../src/storage/db"
import { TeamSessionTable } from "../../src/team/team.sql"
import { Log } from "../../src/util/log"
import { Bus } from "../../src/bus"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

/** Helper to create a team_session row directly (avoids needing full Team.create with Session deps) */
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

describe("team.workspace (DB)", () => {
  test("create and get all sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Build authentication system")

        const goal = Workspace.get(teamID, "goal")
        expect(goal).toBe("Build authentication system")

        const constraints = Workspace.get(teamID, "constraints")
        expect(constraints).toEqual([])

        const plan = Workspace.get(teamID, "plan") as Record<string, unknown>
        expect(plan.status).toBe("draft")
      },
    })
  })

  test("set updates a section with version bump", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test goal")

        Workspace.set(teamID, "constraints", ["Must use TypeScript"], "architect")
        const constraints = Workspace.get(teamID, "constraints") as string[]
        expect(constraints).toEqual(["Must use TypeScript"])
      },
    })
  })

  test("append adds to array sections", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test goal")

        Workspace.append(teamID, "constraints", "Use REST API", "architect")
        Workspace.append(teamID, "constraints", "Support pagination", "architect")
        const constraints = Workspace.get(teamID, "constraints") as string[]
        expect(constraints).toEqual(["Use REST API", "Support pagination"])
      },
    })
  })

  test("addDecision appends with auto ID and timestamp", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test goal")

        const decision = Workspace.addDecision(teamID, {
          description: "Use JWT tokens",
          rationale: "Stateless auth",
          alternatives: ["Sessions"],
          made_by: "architect",
          status: "approved",
        })

        expect(decision.id).toBeTruthy()
        expect(decision.timestamp).toBeGreaterThan(0)

        const decisions = Workspace.get(teamID, "decisions") as Workspace.Decision[]
        expect(decisions).toHaveLength(1)
        expect(decisions[0].description).toBe("Use JWT tokens")
      },
    })
  })

  test("addQuestion and openQuestions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test goal")

        Workspace.addQuestion(teamID, {
          question: "REST or GraphQL?",
          asked_by: "developer",
          routed_to: "architect",
          status: "open",
        })
        Workspace.addQuestion(teamID, {
          question: "Which DB?",
          asked_by: "developer",
          status: "open",
        })

        const open = Workspace.openQuestions(teamID)
        expect(open).toHaveLength(2)
        expect(open[0].question).toBe("REST or GraphQL?")
      },
    })
  })

  test("answerQuestion changes status to answered", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test goal")

        const q = Workspace.addQuestion(teamID, {
          question: "What framework?",
          asked_by: "developer",
          status: "open",
        })

        Workspace.answerQuestion(teamID, q.id, "Use Express", "architect")

        const open = Workspace.openQuestions(teamID)
        expect(open).toHaveLength(0)

        const all = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(all[0].status).toBe("answered")
        expect(all[0].answer).toBe("Use Express")
      },
    })
  })

  test("summary produces formatted text", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Build auth system")

        Workspace.addDecision(teamID, {
          description: "Use JWT",
          rationale: "Stateless",
          alternatives: [],
          made_by: "architect",
          status: "approved",
        })

        const text = Workspace.summary(teamID)
        expect(text).toContain("Build auth system")
        expect(text).toContain("Use JWT")
      },
    })
  })

  test("remove deletes matching items from array section", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        Workspace.create(teamID, "Test goal")

        Workspace.addQuestion(teamID, { question: "Q1", asked_by: "dev", status: "open" })
        const q2 = Workspace.addQuestion(teamID, { question: "Q2", asked_by: "dev", status: "open" })

        Workspace.remove(teamID, "questions", "id", q2.id)

        const questions = Workspace.get(teamID, "questions") as Workspace.Question[]
        expect(questions).toHaveLength(1)
        expect(questions[0].question).toBe("Q1")
      },
    })
  })
})

describe("team.message (DB)", () => {
  test("send and recent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "architect",
          toRole: "developer",
          type: "handoff",
          content: "Implement the login endpoint.",
        })
        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "developer",
          type: "status",
          content: "Working on it.",
        })

        const messages = TeamMessage.recent(teamID, 10)
        expect(messages).toHaveLength(2)
        expect(messages[0].fromRole).toBe("architect")
        expect(messages[1].fromRole).toBe("developer")
      },
    })
  })

  test("forRole filters by role", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "architect",
          toRole: "developer",
          type: "handoff",
          content: "Task A",
        })
        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "architect",
          toRole: "qa",
          type: "handoff",
          content: "Task B",
        })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "developer", type: "status", content: "Done with A" })

        const devMessages = TeamMessage.forRole(teamID, "developer", 10)
        // developer should see: messages TO developer, FROM developer, and broadcast (to_role=null)
        expect(devMessages.length).toBeGreaterThanOrEqual(2)
        const contents = devMessages.map((m) => m.content)
        expect(contents).toContain("Task A")
        expect(contents).toContain("Done with A")
      },
    })
  })

  test("byType filters by message type", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({ teamSessionID: teamID, fromRole: "architect", type: "proposal", content: "Design A" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "developer", type: "status", content: "Working" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "architect", type: "proposal", content: "Design B" })

        const proposals = TeamMessage.byType(teamID, "proposal")
        expect(proposals).toHaveLength(2)
        expect(proposals[0].content).toBe("Design A")
      },
    })
  })

  test("send emits bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        let received = false

        const unsub = Bus.subscribe(TeamMessage.Event.Sent, (event) => {
          received = true
          expect(event.properties.info.fromRole).toBe("orchestrator")
        })

        TeamMessage.send({ teamSessionID: teamID, fromRole: "orchestrator", type: "status", content: "Starting" })
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })

  test("message with refs", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const ref = "rvw_test123"

        const msg = TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "qa",
          toRole: "developer",
          type: "critique",
          content: "Missing error handling.",
          refs: [ref],
        })

        expect(msg.refs).toContain(ref)

        const messages = TeamMessage.recent(teamID, 10)
        expect(messages[0].refs).toContain(ref)
      },
    })
  })
})

describe("team.review (DB)", () => {
  test("create and get", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "Design document v1",
          authorRole: "architect",
          reviewerRole: "security-reviewer",
        })

        expect(review.id).toMatch(/^rvw_/)
        expect(review.status).toBe("active")
        expect(review.round).toBe(0)

        const fetched = Review.get(review.id)
        expect(fetched).toBeDefined()
        expect(fetched!.authorRole).toBe("architect")
        expect(fetched!.reviewerRole).toBe("security-reviewer")
      },
    })
  })

  test("incrementRound updates round and sets needs_revision", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code v1",
          authorRole: "developer",
          reviewerRole: "qa",
        })

        const updated = Review.incrementRound(review.id)
        expect(updated!.round).toBe(1)
        expect(updated!.status).toBe("needs_revision")

        const updated2 = Review.incrementRound(review.id)
        expect(updated2!.round).toBe(2)
      },
    })
  })

  test("approve sets status and emits event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        let eventFired = false

        const unsub = Bus.subscribe(Review.Event.Completed, () => {
          eventFired = true
        })

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code v2",
          authorRole: "developer",
          reviewerRole: "architect",
        })

        const approved = Review.approve(review.id)
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(approved!.status).toBe("approved")
        expect(eventFired).toBe(true)
      },
    })
  })

  test("escalate sets status and emits event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        let eventFired = false

        const unsub = Bus.subscribe(Review.Event.Escalated, () => {
          eventFired = true
        })

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code v3",
          authorRole: "developer",
          reviewerRole: "qa",
        })

        const escalated = Review.escalate(review.id, "3 rounds exhausted")
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(escalated!.status).toBe("escalated")
        expect(eventFired).toBe(true)
      },
    })
  })

  test("listActive and listAll", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        Review.create({ teamSessionID: teamID, artifactRef: "r1", authorRole: "dev", reviewerRole: "qa" })
        const r2 = Review.create({ teamSessionID: teamID, artifactRef: "r2", authorRole: "dev", reviewerRole: "arch" })
        Review.approve(r2.id)

        const active = Review.listActive(teamID)
        expect(active).toHaveLength(1)

        const all = Review.listAll(teamID)
        expect(all).toHaveLength(2)
      },
    })
  })

  test("addCritique creates a linked team message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "developer",
          reviewerRole: "qa",
        })

        Review.addCritique({
          teamSessionID: teamID,
          reviewID: review.id,
          reviewerRole: "qa",
          authorRole: "developer",
          content: "Missing error handling in login endpoint.",
        })

        const history = Review.history(teamID, review.id)
        expect(history).toHaveLength(1)
        expect(history[0].type).toBe("critique")
        expect(history[0].refs).toContain(review.id)
      },
    })
  })

  test("addRevision creates a linked team message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "developer",
          reviewerRole: "qa",
        })

        Review.addRevision({
          teamSessionID: teamID,
          reviewID: review.id,
          authorRole: "developer",
          reviewerRole: "qa",
          content: "Added try/catch for all database operations.",
        })

        const history = Review.history(teamID, review.id)
        expect(history).toHaveLength(1)
        expect(history[0].type).toBe("artifact")
      },
    })
  })

  test("history returns critiques and revisions in order", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "developer",
          reviewerRole: "qa",
        })

        Review.addCritique({
          teamSessionID: teamID,
          reviewID: review.id,
          reviewerRole: "qa",
          authorRole: "developer",
          content: "Round 1 critique",
        })
        Review.addRevision({
          teamSessionID: teamID,
          reviewID: review.id,
          authorRole: "developer",
          reviewerRole: "qa",
          content: "Round 1 revision",
        })
        Review.addCritique({
          teamSessionID: teamID,
          reviewID: review.id,
          reviewerRole: "qa",
          authorRole: "developer",
          content: "Round 2 critique",
        })

        const history = Review.history(teamID, review.id)
        expect(history).toHaveLength(3)
        expect(history[0].content).toBe("Round 1 critique")
        expect(history[1].content).toBe("Round 1 revision")
        expect(history[2].content).toBe("Round 2 critique")
      },
    })
  })
})
