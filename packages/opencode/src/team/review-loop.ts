import { Review } from "./review"
import { Execute } from "./execute"
import { Roster } from "./roster"
import { Workspace } from "./workspace"
import { TeamMessage } from "./message"
import { Log } from "@/util/log"

import PROMPT_REVIEWER from "./prompt/reviewer-instructions.txt"
import PROMPT_REVISION from "./prompt/revision-instructions.txt"

export namespace ReviewLoop {
  const log = Log.create({ service: "review-loop" })

  const MAX_ROUNDS = 3

  export interface Result {
    review: Review.Info
    approved: boolean
    escalated: boolean
    rounds: number
    finalArtifact: string
  }

  /**
   * Run the review loop: reviewer critiques, author revises, up to MAX_ROUNDS.
   * Returns the final state of the review.
   */
  export async function run(input: {
    teamSessionID: string
    artifact: string
    authorRole: string
    reviewerRole: string
    teamGoal: string
    phase: string
  }): Promise<Result> {
    const author = Roster.get(input.teamSessionID, input.authorRole)
    const reviewer = Roster.get(input.teamSessionID, input.reviewerRole)

    if (!author || !reviewer) {
      log.error("missing agent for review", {
        author: input.authorRole,
        reviewer: input.reviewerRole,
        authorFound: !!author,
        reviewerFound: !!reviewer,
      })
      return {
        review: Review.create({
          teamSessionID: input.teamSessionID,
          artifactRef: input.artifact.slice(0, 100),
          authorRole: input.authorRole,
          reviewerRole: input.reviewerRole,
        }),
        approved: false,
        escalated: true,
        rounds: 0,
        finalArtifact: input.artifact,
      }
    }

    const review = Review.create({
      teamSessionID: input.teamSessionID,
      artifactRef: input.artifact.slice(0, 200),
      authorRole: input.authorRole,
      reviewerRole: input.reviewerRole,
    })

    let artifact = input.artifact
    let round = 0

    while (round < MAX_ROUNDS) {
      // Refresh review state from DB to get accurate round number
      const current = Review.get(review.id) ?? review
      log.info("review round", { reviewID: review.id, round: round + 1, dbRound: current.round })

      // Step 1: Reviewer critiques the artifact
      const critiqueResult = await runReviewer({
        reviewer,
        artifact,
        review: current,
        teamSessionID: input.teamSessionID,
        teamGoal: input.teamGoal,
        phase: input.phase,
      })

      // Check if approved
      if (critiqueResult.approved) {
        Review.approve(review.id)
        Workspace.addDecision(input.teamSessionID, {
          description: `${reviewer.role} approved ${author.role}'s work`,
          rationale: critiqueResult.text.slice(0, 300),
          alternatives: [],
          made_by: reviewer.role,
          status: "approved",
        })
        log.info("review approved", { reviewID: review.id, round: round + 1 })
        return {
          review: Review.get(review.id) ?? review,
          approved: true,
          escalated: false,
          rounds: round + 1,
          finalArtifact: artifact,
        }
      }

      // Record the critique and increment round in DB
      Review.addCritique({
        teamSessionID: input.teamSessionID,
        reviewID: review.id,
        reviewerRole: reviewer.role,
        authorRole: author.role,
        content: critiqueResult.text,
      })
      Review.incrementRound(review.id)

      // Step 2: Author revises based on critique
      const updatedReview = Review.get(review.id) ?? current
      const revisionResult = await runRevision({
        author,
        artifact,
        critique: critiqueResult.text,
        review: updatedReview,
        teamSessionID: input.teamSessionID,
        teamGoal: input.teamGoal,
        phase: input.phase,
      })

      // Record the revision
      Review.addRevision({
        teamSessionID: input.teamSessionID,
        reviewID: review.id,
        authorRole: author.role,
        reviewerRole: reviewer.role,
        content: revisionResult.text,
      })

      // Update artifact for next round
      artifact = extractRevised(revisionResult.text, artifact)

      round++
    }

    // Max rounds exceeded -- escalate
    log.warn("review exceeded max rounds, escalating", { reviewID: review.id })
    Review.escalate(review.id, `Review did not converge after ${MAX_ROUNDS} rounds`)

    TeamMessage.send({
      teamSessionID: input.teamSessionID,
      fromRole: "system",
      type: "escalation",
      content: `Review thread ${review.id} between ${author.role} and ${reviewer.role} did not converge after ${MAX_ROUNDS} rounds. Escalating to orchestrator.`,
      refs: [review.id],
    })

    return {
      review: Review.get(review.id) ?? review,
      approved: false,
      escalated: true,
      rounds: MAX_ROUNDS,
      finalArtifact: artifact,
    }
  }

  async function runReviewer(input: {
    reviewer: Roster.Info
    artifact: string
    review: Review.Info
    teamSessionID: string
    teamGoal: string
    phase: string
  }): Promise<Execute.AgentResult> {
    const reviewContext = [
      `You are reviewing work by ${input.review.authorRole}.`,
      `This is review round ${input.review.round + 1}.`,
      "",
      "## Artifact to Review",
      input.artifact,
      "",
      PROMPT_REVIEWER,
    ].join("\n")

    return Execute.run(input.reviewer, reviewContext, input.teamSessionID, input.teamGoal, input.phase)
  }

  async function runRevision(input: {
    author: Roster.Info
    artifact: string
    critique: string
    review: Review.Info
    teamSessionID: string
    teamGoal: string
    phase: string
  }): Promise<Execute.AgentResult> {
    const revisionContext = [
      `Your work has been reviewed by ${input.review.reviewerRole}. You must address their feedback.`,
      `This is revision round ${input.review.round + 1}.`,
      "",
      "## Your Original Artifact",
      input.artifact,
      "",
      "## Reviewer's Critique",
      input.critique,
      "",
      PROMPT_REVISION,
    ].join("\n")

    return Execute.run(input.author, revisionContext, input.teamSessionID, input.teamGoal, input.phase)
  }

  /** Extract the revised artifact from the author's revision output */
  export function extractRevised(revisionText: string, fallback: string): string {
    // Look for [ARTIFACT] block in the revision — terminates on any known tag or end of string
    const tags = "PROPOSAL|DECISION|QUESTION|CONCERN|COMPLETE|ARTIFACT|SPAWN|CRITIQUE|APPROVED"
    const match = revisionText.match(
      new RegExp(`\\[ARTIFACT\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "i"),
    )
    if (match) return match[1].trim()

    // If no explicit [ARTIFACT] tag, return the full text (the revision itself IS the artifact)
    // But strip out the revision summary header if present
    const stripped = revisionText.replace(/^## Revision Summary[\s\S]*?(?=\n##|\n[^-\n])/i, "").trim()
    return stripped || fallback
  }
}
