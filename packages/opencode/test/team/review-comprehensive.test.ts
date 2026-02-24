import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Review } from "../../src/team/review"
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

describe("team.review.create", () => {
  test("creates a review thread with initial state", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "Authentication module design",
          authorRole: "architect",
          reviewerRole: "security-reviewer",
        })

        expect(review.id).toMatch(/^rvw_/)
        expect(review.teamSessionID).toBe(teamID)
        expect(review.artifactRef).toBe("Authentication module design")
        expect(review.authorRole).toBe("architect")
        expect(review.reviewerRole).toBe("security-reviewer")
        expect(review.status).toBe("active")
        expect(review.round).toBe(0)
        expect(review.time.created).toBeGreaterThan(0)
        expect(review.time.updated).toBeGreaterThan(0)
      },
    })
  })

  test("emits Started bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        let received = false

        const unsub = Bus.subscribe(Review.Event.Started, (event) => {
          received = true
          expect(event.properties.info.authorRole).toBe("developer")
          expect(event.properties.info.status).toBe("active")
        })

        Review.create({
          teamSessionID: teamID,
          artifactRef: "code v1",
          authorRole: "developer",
          reviewerRole: "qa",
        })
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })
})

describe("team.review.get", () => {
  test("retrieves review by ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "design doc",
          authorRole: "arch",
          reviewerRole: "dev",
        })

        const fetched = Review.get(review.id)
        expect(fetched).toBeDefined()
        expect(fetched!.id).toBe(review.id)
        expect(fetched!.artifactRef).toBe("design doc")
      },
    })
  })

  test("returns undefined for non-existent ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Review.get("rvw_nonexistent")).toBeUndefined()
      },
    })
  })
})

describe("team.review.incrementRound", () => {
  test("increments round and sets needs_revision", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "dev",
          reviewerRole: "qa",
        })

        const r1 = Review.incrementRound(review.id)
        expect(r1!.round).toBe(1)
        expect(r1!.status).toBe("needs_revision")

        const r2 = Review.incrementRound(review.id)
        expect(r2!.round).toBe(2)
        expect(r2!.status).toBe("needs_revision")

        const r3 = Review.incrementRound(review.id)
        expect(r3!.round).toBe(3)
      },
    })
  })

  test("returns undefined for non-existent review", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Review.incrementRound("rvw_nonexistent")).toBeUndefined()
      },
    })
  })
})

describe("team.review.approve", () => {
  test("sets status to approved", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "dev",
          reviewerRole: "qa",
        })

        const approved = Review.approve(review.id)
        expect(approved!.status).toBe("approved")
      },
    })
  })

  test("emits Completed bus event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        let received = false

        const unsub = Bus.subscribe(Review.Event.Completed, (event) => {
          received = true
          expect(event.properties.info.status).toBe("approved")
        })

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "dev",
          reviewerRole: "qa",
        })
        Review.approve(review.id)
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(true)
      },
    })
  })

  test("returns undefined for non-existent review", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Review.approve("rvw_nonexistent")).toBeUndefined()
      },
    })
  })
})

describe("team.review.escalate", () => {
  test("sets status to escalated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "dev",
          reviewerRole: "qa",
        })

        const escalated = Review.escalate(review.id, "3 rounds exceeded")
        expect(escalated!.status).toBe("escalated")
      },
    })
  })

  test("emits Escalated bus event with reason", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)
        let receivedReason = ""

        const unsub = Bus.subscribe(Review.Event.Escalated, (event) => {
          receivedReason = event.properties.reason
        })

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "dev",
          reviewerRole: "qa",
        })
        Review.escalate(review.id, "Disagreement on approach")
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(receivedReason).toBe("Disagreement on approach")
      },
    })
  })
})

describe("team.review.listActive", () => {
  test("returns only active reviews", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        Review.create({ teamSessionID: teamID, artifactRef: "r1", authorRole: "dev", reviewerRole: "qa" })
        const r2 = Review.create({ teamSessionID: teamID, artifactRef: "r2", authorRole: "dev", reviewerRole: "arch" })
        Review.create({ teamSessionID: teamID, artifactRef: "r3", authorRole: "arch", reviewerRole: "sec" })
        Review.approve(r2.id)

        const active = Review.listActive(teamID)
        expect(active).toHaveLength(2)
      },
    })
  })

  test("excludes escalated and needs_revision reviews", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const r1 = Review.create({ teamSessionID: teamID, artifactRef: "r1", authorRole: "dev", reviewerRole: "qa" })
        const r2 = Review.create({ teamSessionID: teamID, artifactRef: "r2", authorRole: "dev", reviewerRole: "arch" })
        Review.create({ teamSessionID: teamID, artifactRef: "r3", authorRole: "arch", reviewerRole: "sec" })

        Review.escalate(r1.id, "reason")
        Review.incrementRound(r2.id) // sets to needs_revision

        const active = Review.listActive(teamID)
        expect(active).toHaveLength(1)
        expect(active[0].artifactRef).toBe("r3")
      },
    })
  })
})

describe("team.review.listAll", () => {
  test("returns all reviews regardless of status", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        Review.create({ teamSessionID: teamID, artifactRef: "r1", authorRole: "dev", reviewerRole: "qa" })
        const r2 = Review.create({ teamSessionID: teamID, artifactRef: "r2", authorRole: "dev", reviewerRole: "arch" })
        Review.approve(r2.id)
        const r3 = Review.create({
          teamSessionID: teamID,
          artifactRef: "r3",
          authorRole: "arch",
          reviewerRole: "sec",
        })
        Review.escalate(r3.id, "reason")

        const all = Review.listAll(teamID)
        expect(all).toHaveLength(3)
      },
    })
  })

  test("returns empty for non-existent team", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Review.listAll("team_nonexistent")).toEqual([])
      },
    })
  })
})

describe("team.review.addCritique", () => {
  test("creates a critique team message linked to review", async () => {
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
          content: "Missing error handling in the login function.",
        })

        const msgs = TeamMessage.recent(teamID)
        const critique = msgs.find((m) => m.type === "critique")
        expect(critique).toBeDefined()
        expect(critique!.fromRole).toBe("qa")
        expect(critique!.toRole).toBe("developer")
        expect(critique!.refs).toContain(review.id)
      },
    })
  })
})

describe("team.review.addRevision", () => {
  test("creates an artifact team message linked to review", async () => {
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
          content: "Added try/catch blocks for all DB operations.",
        })

        const msgs = TeamMessage.recent(teamID)
        const revision = msgs.find((m) => m.type === "artifact")
        expect(revision).toBeDefined()
        expect(revision!.fromRole).toBe("developer")
        expect(revision!.toRole).toBe("qa")
        expect(revision!.refs).toContain(review.id)
      },
    })
  })
})

describe("team.review.history", () => {
  test("returns all messages linked to a review", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "dev",
          reviewerRole: "qa",
        })

        // Also send some unrelated messages
        TeamMessage.send({ teamSessionID: teamID, fromRole: "orch", type: "status", content: "Unrelated" })

        Review.addCritique({
          teamSessionID: teamID,
          reviewID: review.id,
          reviewerRole: "qa",
          authorRole: "dev",
          content: "Critique 1",
        })
        Review.addRevision({
          teamSessionID: teamID,
          reviewID: review.id,
          authorRole: "dev",
          reviewerRole: "qa",
          content: "Revision 1",
        })
        Review.addCritique({
          teamSessionID: teamID,
          reviewID: review.id,
          reviewerRole: "qa",
          authorRole: "dev",
          content: "Critique 2",
        })

        const history = Review.history(teamID, review.id)
        expect(history).toHaveLength(3)
        expect(history[0].content).toBe("Critique 1")
        expect(history[1].content).toBe("Revision 1")
        expect(history[2].content).toBe("Critique 2")
      },
    })
  })

  test("returns empty when no messages linked to review", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review = Review.create({
          teamSessionID: teamID,
          artifactRef: "code",
          authorRole: "dev",
          reviewerRole: "qa",
        })

        // Send unrelated messages without refs
        TeamMessage.send({ teamSessionID: teamID, fromRole: "orch", type: "status", content: "Hi" })

        const history = Review.history(teamID, review.id)
        expect(history).toEqual([])
      },
    })
  })

  test("only returns messages for the specific review", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const teamID = createTeamSession(Instance.project.id)

        const review1 = Review.create({
          teamSessionID: teamID,
          artifactRef: "code1",
          authorRole: "dev",
          reviewerRole: "qa",
        })
        const review2 = Review.create({
          teamSessionID: teamID,
          artifactRef: "code2",
          authorRole: "arch",
          reviewerRole: "sec",
        })

        Review.addCritique({
          teamSessionID: teamID,
          reviewID: review1.id,
          reviewerRole: "qa",
          authorRole: "dev",
          content: "Review 1 critique",
        })
        Review.addCritique({
          teamSessionID: teamID,
          reviewID: review2.id,
          reviewerRole: "sec",
          authorRole: "arch",
          content: "Review 2 critique",
        })

        const history1 = Review.history(teamID, review1.id)
        expect(history1).toHaveLength(1)
        expect(history1[0].content).toBe("Review 1 critique")

        const history2 = Review.history(teamID, review2.id)
        expect(history2).toHaveLength(1)
        expect(history2[0].content).toBe("Review 2 critique")
      },
    })
  })
})

describe("team.review schemas", () => {
  test("Status enum has all values", () => {
    for (const status of ["active", "approved", "needs_revision", "escalated"] as const) {
      expect(Review.Status.parse(status)).toBe(status)
    }
  })

  test("Status rejects invalid values", () => {
    expect(() => Review.Status.parse("invalid")).toThrow()
  })

  test("Info schema validates", () => {
    const info = Review.Info.parse({
      id: "rvw_1",
      teamSessionID: "team_1",
      artifactRef: "code v1",
      authorRole: "dev",
      reviewerRole: "qa",
      status: "active",
      round: 2,
      time: { created: 1000, updated: 2000 },
    })
    expect(info.round).toBe(2)
    expect(info.artifactRef).toBe("code v1")
  })
})

describe("team.review.escalate edge cases", () => {
  test("returns undefined for non-existent review", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = Review.escalate("rvw_nonexistent", "reason")
        expect(result).toBeUndefined()
      },
    })
  })

  test("does not emit Escalated event for non-existent review", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let received = false
        const unsub = Bus.subscribe(Review.Event.Escalated, () => {
          received = true
        })

        Review.escalate("rvw_nonexistent", "reason")
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(false)
      },
    })
  })

  test("approve returns undefined for non-existent review without emitting Completed event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let received = false
        const unsub = Bus.subscribe(Review.Event.Completed, () => {
          received = true
        })

        const result = Review.approve("rvw_nonexistent")
        expect(result).toBeUndefined()
        await new Promise((r) => setTimeout(r, 50))

        unsub()
        expect(received).toBe(false)
      },
    })
  })
})
