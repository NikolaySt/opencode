import { describe, expect, test } from "bun:test"

/**
 * ReviewLoop tests.
 *
 * The ReviewLoop.run() function calls Execute.run() which calls SessionPrompt.prompt()
 * (an actual LLM call), so we cannot unit test the full loop without mocking.
 * Since the project philosophy is "avoid mocks", we test the pure helper function
 * extractRevised() instead, plus the ReviewLoop.Result interface contract.
 *
 * The extractRevised function is private, but we can test its behavior through
 * the patterns it's designed to handle.
 */

// We test extractRevised both directly (it's exported) and through parseOutput
import { Execute } from "../../src/team/execute"
import { ReviewLoop } from "../../src/team/review-loop"

describe("team.review-loop.extractRevised patterns (via parseOutput)", () => {
  test("[ARTIFACT] block is extracted from revision output", () => {
    const text = [
      "## Revision Summary",
      "Fixed the error handling as requested.",
      "",
      "[ARTIFACT]",
      "function login(user, pass) {",
      "  try {",
      "    return auth.verify(user, pass)",
      "  } catch (e) {",
      "    throw new AuthError(e.message)",
      "  }",
      "}",
    ].join("\n")

    const result = Execute.parseOutput(text)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toContain("function login")
    expect(result.artifacts[0]).toContain("AuthError")
  })

  test("[ARTIFACT] followed by [COMPLETE] is properly terminated", () => {
    const text = ["[ARTIFACT]", "const revised = 'code'", "", "[COMPLETE]", "Revision done."].join("\n")

    const result = Execute.parseOutput(text)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toBe("const revised = 'code'")
    expect(result.complete).toBe(true)
  })

  test("multiple revisions produce multiple artifacts", () => {
    const text = [
      "[ARTIFACT]",
      "// File: auth.ts",
      "export function login() {}",
      "",
      "[ARTIFACT]",
      "// File: auth.test.ts",
      "test('login works', () => {})",
    ].join("\n")

    const result = Execute.parseOutput(text)
    expect(result.artifacts).toHaveLength(2)
    expect(result.artifacts[0]).toContain("auth.ts")
    expect(result.artifacts[1]).toContain("auth.test.ts")
  })
})

describe("team.review-loop.extractRevised (direct)", () => {
  test("extracts [ARTIFACT] block from revision text", () => {
    const text = ["## Revision Summary", "I fixed the issues.", "", "[ARTIFACT]", "const revised = true"].join("\n")
    expect(ReviewLoop.extractRevised(text, "fallback")).toBe("const revised = true")
  })

  test("[ARTIFACT] terminated by another tag", () => {
    const text = "[ARTIFACT]\nrevised code here\n\n[COMPLETE]\nDone."
    expect(ReviewLoop.extractRevised(text, "fallback")).toBe("revised code here")
  })

  test("[ARTIFACT] terminated by [PROPOSAL]", () => {
    const text = "[ARTIFACT]\nmy artifact\n\n[PROPOSAL]\nSomething else."
    expect(ReviewLoop.extractRevised(text, "fallback")).toBe("my artifact")
  })

  test("[ARTIFACT] terminated by [CRITIQUE]", () => {
    const text = "[ARTIFACT]\ncode block\n\n[CRITIQUE]\nSome concern."
    expect(ReviewLoop.extractRevised(text, "fallback")).toBe("code block")
  })

  test("[ARTIFACT] terminated by markdown heading", () => {
    const text = "[ARTIFACT]\nrevised text\n\n## Notes\nSome notes."
    expect(ReviewLoop.extractRevised(text, "fallback")).toBe("revised text")
  })

  test("fallback path: returns full text when no [ARTIFACT] tag", () => {
    const text = "This is just the revised code without tags."
    expect(ReviewLoop.extractRevised(text, "original")).toBe("This is just the revised code without tags.")
  })

  test("fallback path: strips ## Revision Summary header", () => {
    const text = "## Revision Summary\n- Fixed bug\n- Added test\n\nconst x = 42"
    const result = ReviewLoop.extractRevised(text, "original")
    expect(result).toContain("const x = 42")
    expect(result).not.toStartWith("## Revision Summary")
  })

  test("returns fallback when revision text is empty", () => {
    expect(ReviewLoop.extractRevised("", "original artifact")).toBe("original artifact")
  })

  test("returns fallback when revision text is only whitespace", () => {
    expect(ReviewLoop.extractRevised("   \n  \n  ", "original")).toBe("original")
  })

  test("handles multiline artifact content", () => {
    const text = ["[ARTIFACT]", "function foo() {", "  const a = 1", "  const b = 2", "  return a + b", "}"].join("\n")
    const result = ReviewLoop.extractRevised(text, "fallback")
    expect(result).toContain("function foo()")
    expect(result).toContain("return a + b")
  })
})

describe("team.review-loop.Result review field validation", () => {
  test("review field validates via Review.Info schema", () => {
    // Validate that the Review.Info Zod schema accepts the shape used in Result
    const { Review } = require("../../src/team/review") as typeof import("../../src/team/review")
    const info = Review.Info.parse({
      id: "rvw_1",
      teamSessionID: "team_1",
      artifactRef: "code",
      authorRole: "developer",
      reviewerRole: "qa",
      status: "approved",
      round: 2,
      time: { created: 0, updated: 0 },
    })
    expect(info.id).toBe("rvw_1")
    expect(info.status).toBe("approved")
    expect(info.round).toBe(2)
  })

  test("Review.Info rejects invalid status in Result context", () => {
    const { Review } = require("../../src/team/review") as typeof import("../../src/team/review")
    expect(() =>
      Review.Info.parse({
        id: "rvw_1",
        teamSessionID: "team_1",
        artifactRef: "code",
        authorRole: "developer",
        reviewerRole: "qa",
        status: "invalid_status",
        round: 0,
        time: { created: 0, updated: 0 },
      }),
    ).toThrow()
  })
})
