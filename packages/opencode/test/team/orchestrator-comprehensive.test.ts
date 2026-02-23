import { describe, expect, test } from "bun:test"
import { Orchestrator } from "../../src/team/orchestrator"

describe("team.orchestrator.Phase", () => {
  test("has all 5 expected phases", () => {
    const phases = Orchestrator.Phase.options
    expect(phases).toHaveLength(5)
    expect(phases).toContain("understanding")
    expect(phases).toContain("design")
    expect(phases).toContain("implementation")
    expect(phases).toContain("verification")
    expect(phases).toContain("complete")
  })

  test("validates valid phase", () => {
    expect(Orchestrator.Phase.parse("understanding")).toBe("understanding")
    expect(Orchestrator.Phase.parse("design")).toBe("design")
    expect(Orchestrator.Phase.parse("implementation")).toBe("implementation")
    expect(Orchestrator.Phase.parse("verification")).toBe("verification")
    expect(Orchestrator.Phase.parse("complete")).toBe("complete")
  })

  test("rejects invalid phase", () => {
    expect(() => Orchestrator.Phase.parse("invalid")).toThrow()
    expect(() => Orchestrator.Phase.parse("")).toThrow()
  })
})

describe("team.orchestrator.Event", () => {
  test("PhaseChanged event has correct type and validates payload", () => {
    expect(Orchestrator.Event.PhaseChanged.type).toBe("team.phase_changed")
    const parsed = Orchestrator.Event.PhaseChanged.properties.parse({
      teamSessionID: "team_1",
      phase: "design",
    })
    expect(parsed.phase).toBe("design")
  })

  test("Decision event has correct type and validates payload", () => {
    expect(Orchestrator.Event.Decision.type).toBe("team.decision")
    const parsed = Orchestrator.Event.Decision.properties.parse({
      teamSessionID: "team_1",
      decision: {
        id: "wks_1",
        description: "Use REST",
        rationale: "Simple",
        alternatives: [],
        made_by: "arch",
        status: "approved",
        timestamp: Date.now(),
      },
    })
    expect(parsed.decision.description).toBe("Use REST")
  })

  test("Escalated event has correct type and validates payload", () => {
    expect(Orchestrator.Event.Escalated.type).toBe("team.escalated")
    const parsed = Orchestrator.Event.Escalated.properties.parse({
      teamSessionID: "team_1",
      question: "Need user input",
    })
    expect(parsed.question).toBe("Need user input")
  })
})

describe("team.orchestrator.forceAdvance", () => {
  test("advances understanding to design", () => {
    expect(Orchestrator.forceAdvance("understanding")).toBe("design")
  })

  test("advances design to implementation", () => {
    expect(Orchestrator.forceAdvance("design")).toBe("implementation")
  })

  test("advances implementation to verification", () => {
    expect(Orchestrator.forceAdvance("implementation")).toBe("verification")
  })

  test("advances verification to complete", () => {
    expect(Orchestrator.forceAdvance("verification")).toBe("complete")
  })

  test("returns undefined for complete (no next phase)", () => {
    expect(Orchestrator.forceAdvance("complete")).toBeUndefined()
  })
})

describe("team.orchestrator.parseAction", () => {
  test("parses staff action from raw JSON", () => {
    const json = JSON.stringify({
      action: "staff",
      roles: [{ role: "developer", expertise: ["typescript"], task: "Build API" }],
    })
    const result = Orchestrator.parseAction(json)
    expect(result).toBeDefined()
    expect(result!.action).toBe("staff")
  })

  test("parses assign action", () => {
    const result = Orchestrator.parseAction(JSON.stringify({ action: "assign", role: "developer", task: "Build it" }))
    expect(result).toBeDefined()
    expect(result!.action).toBe("assign")
  })

  test("parses spawn action", () => {
    const result = Orchestrator.parseAction(
      JSON.stringify({ action: "spawn", role: "security-reviewer", expertise: ["OWASP"], reason: "Need security" }),
    )
    expect(result).toBeDefined()
    expect(result!.action).toBe("spawn")
  })

  test("parses retire action", () => {
    const result = Orchestrator.parseAction(JSON.stringify({ action: "retire", role: "developer", reason: "Done" }))
    expect(result).toBeDefined()
    expect(result!.action).toBe("retire")
  })

  test("parses route action", () => {
    const result = Orchestrator.parseAction(
      JSON.stringify({ action: "route", from: "dev", to: "architect", question: "Pattern?" }),
    )
    expect(result).toBeDefined()
    expect(result!.action).toBe("route")
  })

  test("parses decide action", () => {
    const result = Orchestrator.parseAction(
      JSON.stringify({ action: "decide", description: "Use REST", rationale: "Simple", alternatives: ["GraphQL"] }),
    )
    expect(result).toBeDefined()
    expect(result!.action).toBe("decide")
  })

  test("parses escalate action", () => {
    const result = Orchestrator.parseAction(JSON.stringify({ action: "escalate", question: "Need user input" }))
    expect(result).toBeDefined()
    expect(result!.action).toBe("escalate")
  })

  test("parses advance action", () => {
    const result = Orchestrator.parseAction(
      JSON.stringify({ action: "advance", phase: "design", summary: "Understanding complete" }),
    )
    expect(result).toBeDefined()
    expect(result!.action).toBe("advance")
  })

  test("parses review action", () => {
    const result = Orchestrator.parseAction(
      JSON.stringify({ action: "review", artifact: "code v1", author: "developer", reviewer: "qa" }),
    )
    expect(result).toBeDefined()
    expect(result!.action).toBe("review")
  })

  test("parses mediate action", () => {
    const result = Orchestrator.parseAction(
      JSON.stringify({
        action: "mediate",
        review_id: "rvw_123",
        decision: "Accept revision",
        rationale: "Good enough",
      }),
    )
    expect(result).toBeDefined()
    expect(result!.action).toBe("mediate")
  })

  test("parses complete action", () => {
    const result = Orchestrator.parseAction(JSON.stringify({ action: "complete", summary: "All done" }))
    expect(result).toBeDefined()
    expect(result!.action).toBe("complete")
  })

  test("extracts JSON from markdown code block", () => {
    const text = "Here is my decision:\n```json\n" + JSON.stringify({ action: "escalate", question: "Help?" }) + "\n```"
    const result = Orchestrator.parseAction(text)
    expect(result).toBeDefined()
    expect(result!.action).toBe("escalate")
  })

  test("extracts JSON from bare code block", () => {
    const text = "```\n" + JSON.stringify({ action: "complete", summary: "Done" }) + "\n```"
    const result = Orchestrator.parseAction(text)
    expect(result).toBeDefined()
    expect(result!.action).toBe("complete")
  })

  test("returns undefined for text with no JSON", () => {
    expect(Orchestrator.parseAction("I think we should continue working.")).toBeUndefined()
  })

  test("returns undefined for invalid JSON", () => {
    expect(Orchestrator.parseAction("{not valid json}")).toBeUndefined()
  })

  test("returns undefined for JSON with unknown action", () => {
    expect(Orchestrator.parseAction(JSON.stringify({ action: "fly", target: "moon" }))).toBeUndefined()
  })

  test("returns undefined for JSON missing required fields", () => {
    // assign needs role and task
    expect(Orchestrator.parseAction(JSON.stringify({ action: "assign", role: "dev" }))).toBeUndefined()
  })
})

describe("team.orchestrator.extractText", () => {
  test("returns empty string for null", () => {
    expect(Orchestrator.extractText(null)).toBe("")
  })

  test("returns empty string for undefined", () => {
    expect(Orchestrator.extractText(undefined)).toBe("")
  })

  test("returns string as-is", () => {
    expect(Orchestrator.extractText("hello")).toBe("hello")
  })

  test("extracts text from object with text field", () => {
    expect(Orchestrator.extractText({ text: "hello" })).toBe("hello")
  })

  test("extracts text from object with content field", () => {
    expect(Orchestrator.extractText({ content: "world" })).toBe("world")
  })

  test("prefers text field over content field", () => {
    expect(Orchestrator.extractText({ text: "from-text", content: "from-content" })).toBe("from-text")
  })

  test("extracts text from MessageV2.WithParts structure", () => {
    const result = Orchestrator.extractText({
      parts: [
        { type: "text", text: "line1" },
        { type: "tool_use", id: "1" },
        { type: "text", text: "line2" },
      ],
    })
    expect(result).toBe("line1\nline2")
  })

  test("filters non-text parts", () => {
    const result = Orchestrator.extractText({
      parts: [
        { type: "image", url: "img.png" },
        { type: "text", text: "only-text" },
      ],
    })
    expect(result).toBe("only-text")
  })

  test("falls back to String() for unknown types", () => {
    expect(Orchestrator.extractText(42)).toBe("42")
    expect(Orchestrator.extractText(true)).toBe("true")
  })

  test("handles empty parts array", () => {
    expect(Orchestrator.extractText({ parts: [] })).toBe("")
  })

  test("handles object with no recognized fields", () => {
    expect(Orchestrator.extractText({ foo: "bar" })).toBe("[object Object]")
  })
})
