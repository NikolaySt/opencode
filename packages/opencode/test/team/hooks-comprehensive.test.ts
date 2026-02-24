import { describe, expect, test } from "bun:test"
import { TeamEvents, type TeamEventName } from "../../src/team/hooks"
import { Team } from "../../src/team/index"
import { Orchestrator } from "../../src/team/orchestrator"
import { Roster } from "../../src/team/roster"
import { TeamMessage } from "../../src/team/message"
import { Workspace } from "../../src/team/workspace"
import { Review } from "../../src/team/review"

describe("team.hooks.TeamEvents", () => {
  test("exports all 15 expected events", () => {
    const keys = Object.keys(TeamEvents)
    expect(keys).toHaveLength(15)
  })

  test("all events have type and properties fields", () => {
    expect(TeamEvents["team.created"]).toBe(Team.Event.Created)
    expect(TeamEvents["team.updated"]).toBe(Team.Event.Updated)
    expect(TeamEvents["team.completed"]).toBe(Team.Event.Completed)
    expect(TeamEvents["team.phase_changed"]).toBe(Orchestrator.Event.PhaseChanged)
    expect(TeamEvents["team.decision"]).toBe(Orchestrator.Event.Decision)
    expect(TeamEvents["team.escalated"]).toBe(Orchestrator.Event.Escalated)
    expect(TeamEvents["team.progress"]).toBe(Orchestrator.Event.Progress)
    expect(TeamEvents["team.agent.spawned"]).toBe(Roster.Event.Spawned)
    expect(TeamEvents["team.agent.retired"]).toBe(Roster.Event.Retired)
    expect(TeamEvents["team.agent.updated"]).toBe(Roster.Event.Updated)
    expect(TeamEvents["team.message"]).toBe(TeamMessage.Event.Sent)
    expect(TeamEvents["workspace.updated"]).toBe(Workspace.Event.Updated)
    expect(TeamEvents["team.review.started"]).toBe(Review.Event.Started)
    expect(TeamEvents["team.review.completed"]).toBe(Review.Event.Completed)
    expect(TeamEvents["team.review.escalated"]).toBe(Review.Event.Escalated)
  })
})

describe("team.hooks.TeamEventName type", () => {
  test("all 15 keys are valid TeamEventName values", () => {
    const keys = Object.keys(TeamEvents) as TeamEventName[]
    const expected: TeamEventName[] = [
      "team.created",
      "team.updated",
      "team.completed",
      "team.phase_changed",
      "team.decision",
      "team.escalated",
      "team.progress",
      "team.agent.spawned",
      "team.agent.retired",
      "team.agent.updated",
      "team.message",
      "workspace.updated",
      "team.review.started",
      "team.review.completed",
      "team.review.escalated",
    ]
    expect(keys).toHaveLength(15)
    for (const name of expected) {
      expect(keys).toContain(name)
    }
  })
})
