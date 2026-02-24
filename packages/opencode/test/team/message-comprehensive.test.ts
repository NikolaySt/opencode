import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { TeamMessage } from "../../src/team/message"
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

describe("team.message.send", () => {
  test("creates a message with all fields", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const msg = TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "architect",
          toRole: "developer",
          type: "proposal",
          content: "Use microservices architecture",
          refs: ["ref1", "ref2"],
          mutations: [{ section: "plan", operation: "set", path: "architecture", value: "microservices" }],
        })

        expect(msg.id).toBeTruthy()
        expect(msg.teamSessionID).toBe(teamID)
        expect(msg.fromRole).toBe("architect")
        expect(msg.toRole).toBe("developer")
        expect(msg.type).toBe("proposal")
        expect(msg.content).toBe("Use microservices architecture")
        expect(msg.refs).toEqual(["ref1", "ref2"])
        expect(msg.mutations).toHaveLength(1)
        expect(msg.mutations![0].section).toBe("plan")
        expect(msg.timestamp).toBeGreaterThan(0)
      },
    })
  })

  test("creates a broadcast message (no toRole)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const msg = TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "orchestrator",
          type: "status",
          content: "Phase advancing to design",
        })

        expect(msg.toRole).toBeUndefined()
      },
    })
  })

  test("emits Sent bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        let received = false

        const unsub = Bus.subscribe(TeamMessage.Event.Sent, (event) => {
          received = true
          expect(event.properties.info.type).toBe("decision")
          expect(event.properties.info.fromRole).toBe("orchestrator")
        })

        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "orchestrator",
          type: "decision",
          content: "Approved JWT approach",
        })
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })
})

describe("team.message.send all 10 types", () => {
  const types: TeamMessage.Type[] = [
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
  ]

  for (const type of types) {
    test(`sends message of type: ${type}`, async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const teamID = createTeamSession(Instance.project.id)

          const msg = TeamMessage.send({
            teamSessionID: teamID,
            fromRole: "agent",
            type,
            content: `Content for ${type}`,
          })

          expect(msg.type).toBe(type)
          expect(msg.content).toBe(`Content for ${type}`)
        },
      })
    })
  }
})

describe("team.message.recent", () => {
  test("returns messages in chronological order", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({ teamSessionID: teamID, fromRole: "a", type: "status", content: "First" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "b", type: "status", content: "Second" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "c", type: "status", content: "Third" })

        const msgs = TeamMessage.recent(teamID)
        expect(msgs).toHaveLength(3)
        expect(msgs[0].content).toBe("First")
        expect(msgs[2].content).toBe("Third")
      },
    })
  })

  test("respects limit parameter", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        for (let i = 0; i < 10; i++) {
          TeamMessage.send({ teamSessionID: teamID, fromRole: "a", type: "status", content: `msg ${i}` })
        }

        const msgs = TeamMessage.recent(teamID, 3)
        expect(msgs).toHaveLength(3)
        // Should be the most recent 3, in chronological order
        expect(msgs[0].content).toBe("msg 7")
        expect(msgs[2].content).toBe("msg 9")
      },
    })
  })

  test("returns empty for non-existent team", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const msgs = TeamMessage.recent("team_nonexistent")
        expect(msgs).toEqual([])
      },
    })
  })

  test("defaults limit to 20", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        for (let i = 0; i < 25; i++) {
          TeamMessage.send({ teamSessionID: teamID, fromRole: "a", type: "status", content: `msg ${i}` })
        }

        const msgs = TeamMessage.recent(teamID)
        expect(msgs).toHaveLength(20)
      },
    })
  })
})

describe("team.message.forRole", () => {
  test("returns messages TO the role", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({ teamSessionID: teamID, fromRole: "arch", toRole: "dev", type: "handoff", content: "Task" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "arch", toRole: "qa", type: "handoff", content: "Other" })

        const devMsgs = TeamMessage.forRole(teamID, "dev")
        const contents = devMsgs.map((m) => m.content)
        expect(contents).toContain("Task")
        expect(contents).not.toContain("Other")
      },
    })
  })

  test("returns messages FROM the role", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "dev",
          toRole: "arch",
          type: "question",
          content: "How?",
        })

        const devMsgs = TeamMessage.forRole(teamID, "dev")
        const contents = devMsgs.map((m) => m.content)
        expect(contents).toContain("How?")
      },
    })
  })

  test("returns broadcast messages (to_role=null)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({ teamSessionID: teamID, fromRole: "orch", type: "status", content: "Broadcast" })

        const devMsgs = TeamMessage.forRole(teamID, "dev")
        const contents = devMsgs.map((m) => m.content)
        expect(contents).toContain("Broadcast")
      },
    })
  })

  test("excludes messages to other roles from unrelated senders", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "arch",
          toRole: "qa",
          type: "handoff",
          content: "QA task",
        })

        const devMsgs = TeamMessage.forRole(teamID, "dev")
        const contents = devMsgs.map((m) => m.content)
        expect(contents).not.toContain("QA task")
      },
    })
  })

  test("respects limit parameter", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        for (let i = 0; i < 10; i++) {
          TeamMessage.send({ teamSessionID: teamID, fromRole: "dev", type: "status", content: `msg ${i}` })
        }

        const msgs = TeamMessage.forRole(teamID, "dev", 3)
        expect(msgs).toHaveLength(3)
      },
    })
  })
})

describe("team.message.byType", () => {
  test("filters by message type", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({ teamSessionID: teamID, fromRole: "arch", type: "proposal", content: "P1" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "dev", type: "status", content: "Working" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "arch", type: "proposal", content: "P2" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "qa", type: "critique", content: "C1" })

        const proposals = TeamMessage.byType(teamID, "proposal")
        expect(proposals).toHaveLength(2)
        expect(proposals[0].content).toBe("P1")
        expect(proposals[1].content).toBe("P2")
      },
    })
  })

  test("returns empty when no messages of that type exist", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({ teamSessionID: teamID, fromRole: "arch", type: "proposal", content: "P1" })

        const escalations = TeamMessage.byType(teamID, "escalation")
        expect(escalations).toEqual([])
      },
    })
  })

  test("returns messages in chronological order", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        TeamMessage.send({ teamSessionID: teamID, fromRole: "a", type: "critique", content: "C1" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "b", type: "critique", content: "C2" })
        TeamMessage.send({ teamSessionID: teamID, fromRole: "c", type: "critique", content: "C3" })

        const critiques = TeamMessage.byType(teamID, "critique")
        expect(critiques[0].content).toBe("C1")
        expect(critiques[2].content).toBe("C3")
      },
    })
  })
})

describe("team.message schemas", () => {
  test("Type enum has all 10 types", () => {
    const types = TeamMessage.Type.options
    expect(types).toHaveLength(10)
    expect(types).toContain("proposal")
    expect(types).toContain("critique")
    expect(types).toContain("question")
    expect(types).toContain("answer")
    expect(types).toContain("decision")
    expect(types).toContain("handoff")
    expect(types).toContain("status")
    expect(types).toContain("artifact")
    expect(types).toContain("spawn_request")
    expect(types).toContain("escalation")
  })

  test("Type rejects invalid values", () => {
    expect(() => TeamMessage.Type.parse("invalid")).toThrow()
  })

  test("Mutation schema validates", () => {
    const mut = TeamMessage.Mutation.parse({
      section: "plan",
      operation: "set",
      path: "architecture",
      value: "monolith",
    })
    expect(mut.operation).toBe("set")
  })

  test("Mutation operation enum covers all values", () => {
    for (const op of ["set", "append", "update", "remove"] as const) {
      const mut = TeamMessage.Mutation.parse({ section: "s", operation: op, path: "p", value: null })
      expect(mut.operation).toBe(op)
    }
  })

  test("Info schema validates full message", () => {
    const info = TeamMessage.Info.parse({
      id: "msg_1",
      teamSessionID: "team_1",
      fromRole: "arch",
      toRole: "dev",
      type: "handoff",
      content: "Do thing",
      refs: ["r1"],
      mutations: [{ section: "tasks", operation: "append", path: "", value: {} }],
      timestamp: 1000,
    })
    expect(info.refs).toEqual(["r1"])
  })
})

describe("team.message with mutations", () => {
  test("stores and retrieves workspace mutations", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const msg = TeamMessage.send({
          teamSessionID: teamID,
          fromRole: "dev",
          type: "artifact",
          content: "New code",
          mutations: [
            { section: "artifacts", operation: "set", path: "login.ts", value: "code here" },
            { section: "tasks", operation: "append", path: "", value: { id: "t1", status: "completed" } },
          ],
        })

        expect(msg.mutations).toHaveLength(2)

        const recent = TeamMessage.recent(teamID)
        expect(recent[0].mutations).toHaveLength(2)
        expect(recent[0].mutations![0].section).toBe("artifacts")
        expect(recent[0].mutations![1].operation).toBe("append")
      },
    })
  })
})

describe("team.message.forRole default limit", () => {
  test("returns at most 20 messages by default", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        for (let i = 0; i < 25; i++) {
          TeamMessage.send({ teamSessionID: teamID, fromRole: "dev", type: "status", content: `msg ${i}` })
        }

        const msgs = TeamMessage.forRole(teamID, "dev")
        expect(msgs).toHaveLength(20)
      },
    })
  })
})
