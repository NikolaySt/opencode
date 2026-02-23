import { Workspace } from "./workspace"
import { Roster } from "./roster"
import { TeamMessage } from "./message"
import { Execute } from "./execute"
import { Roles } from "./roles"
import { Review } from "./review"
import { ReviewLoop } from "./review-loop"
import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { SessionPrompt } from "@/session/prompt"
import z from "zod"

import PROMPT_ORCHESTRATOR from "./prompt/orchestrator.txt"

export namespace Orchestrator {
  const log = Log.create({ service: "orchestrator" })

  export const Phase = z.enum(["understanding", "design", "implementation", "verification", "complete"])
  export type Phase = z.infer<typeof Phase>

  const PHASE_BUDGETS: Record<Phase, number> = {
    understanding: 10,
    design: 15,
    implementation: 30,
    verification: 15,
    complete: 0,
  }

  export const Event = {
    PhaseChanged: BusEvent.define("team.phase_changed", z.object({ teamSessionID: z.string(), phase: Phase })),
    Decision: BusEvent.define("team.decision", z.object({ teamSessionID: z.string(), decision: Workspace.Decision })),
    Escalated: BusEvent.define("team.escalated", z.object({ teamSessionID: z.string(), question: z.string() })),
  }

  // Structured action types from the orchestrator LLM
  const StaffAction = z.object({
    action: z.literal("staff"),
    roles: z.array(
      z.object({
        role: z.string(),
        expertise: z.string().array(),
        task: z.string(),
      }),
    ),
  })

  const AssignAction = z.object({
    action: z.literal("assign"),
    role: z.string(),
    task: z.string(),
  })

  const SpawnAction = z.object({
    action: z.literal("spawn"),
    role: z.string(),
    expertise: z.string().array(),
    reason: z.string(),
  })

  const RetireAction = z.object({
    action: z.literal("retire"),
    role: z.string(),
    reason: z.string(),
  })

  const RouteAction = z.object({
    action: z.literal("route"),
    from: z.string(),
    to: z.string(),
    question: z.string(),
  })

  const DecideAction = z.object({
    action: z.literal("decide"),
    description: z.string(),
    rationale: z.string(),
    alternatives: z.string().array(),
  })

  const EscalateAction = z.object({
    action: z.literal("escalate"),
    question: z.string(),
  })

  const AdvanceAction = z.object({
    action: z.literal("advance"),
    phase: Phase,
    summary: z.string(),
  })

  const ReviewAction = z.object({
    action: z.literal("review"),
    artifact: z.string(),
    author: z.string(),
    reviewer: z.string(),
  })

  const MediateAction = z.object({
    action: z.literal("mediate"),
    review_id: z.string(),
    decision: z.string(),
    rationale: z.string(),
  })

  const CompleteAction = z.object({
    action: z.literal("complete"),
    summary: z.string(),
  })

  const OrchestratorAction = z.discriminatedUnion("action", [
    StaffAction,
    AssignAction,
    SpawnAction,
    RetireAction,
    RouteAction,
    DecideAction,
    EscalateAction,
    AdvanceAction,
    ReviewAction,
    MediateAction,
    CompleteAction,
  ])
  type OrchestratorAction = z.infer<typeof OrchestratorAction>

  const PHASE_ORDER: Phase[] = ["understanding", "design", "implementation", "verification", "complete"]

  export function forceAdvance(current: Phase): Phase | undefined {
    const idx = PHASE_ORDER.indexOf(current)
    if (idx < 0 || idx >= PHASE_ORDER.length - 1) return undefined
    return PHASE_ORDER[idx + 1]
  }

  function buildOrchestratorContext(teamSessionID: string, goal: string, phase: Phase): string {
    const summary = Workspace.summary(teamSessionID)
    const roster = Roster.list(teamSessionID)
    const messages = TeamMessage.recent(teamSessionID, 20)
    const questions = Workspace.openQuestions(teamSessionID)
    const activeReviews = Review.listActive(teamSessionID)
    const allReviews = Review.listAll(teamSessionID)

    const parts: string[] = []
    parts.push(`## User Goal\n${goal}`)
    parts.push(`## Current Phase: ${phase}`)
    parts.push("")

    parts.push("## Active Team")
    if (roster.length === 0) {
      parts.push("No agents spawned yet. You must staff the team first.")
    } else {
      for (const agent of roster) {
        parts.push(`- ${agent.role} (${agent.status}) -- expertise: ${agent.expertise.join(", ")}`)
      }
    }
    parts.push("")

    parts.push("## Workspace State")
    parts.push(summary)
    parts.push("")

    if (activeReviews.length) {
      parts.push("## Active Reviews")
      for (const r of activeReviews) {
        parts.push(`- Review ${r.id}: ${r.authorRole} -> ${r.reviewerRole} (round ${r.round}, ${r.status})`)
      }
      parts.push("")
    }

    const escalated = allReviews.filter((r) => r.status === "escalated")
    if (escalated.length) {
      parts.push("## Escalated Reviews (need mediation)")
      for (const r of escalated) {
        parts.push(`- Review ${r.id}: ${r.authorRole} vs ${r.reviewerRole} -- escalated after ${r.round} rounds`)
        parts.push(`  Use {"action":"mediate","review_id":"${r.id}","decision":"...","rationale":"..."} to resolve`)
      }
      parts.push("")
    }

    // Detect completed work that hasn't been reviewed yet
    const completions = messages.filter((m) => m.type === "status" && m.content.startsWith("[COMPLETE]"))
    const reviewedAuthors = new Set(allReviews.map((r) => r.authorRole))
    const unreviewed = completions.filter((m) => !reviewedAuthors.has(m.fromRole))
    if (unreviewed.length) {
      parts.push("## Completed Work Awaiting Review")
      for (const m of unreviewed) {
        parts.push(`- ${m.fromRole} reports: ${m.content.slice(0, 150)}`)
        parts.push(
          `  Consider triggering a review: {"action":"review","artifact":"...","author":"${m.fromRole}","reviewer":"..."}`,
        )
      }
      parts.push("")
    }

    if (questions.length) {
      parts.push("## Open Questions Needing Routing")
      for (const q of questions) {
        parts.push(`- From ${q.asked_by}: ${q.question}`)
      }
      parts.push("")
    }

    if (messages.length) {
      parts.push("## Recent Activity")
      for (const m of messages.slice(-15)) {
        const to = m.toRole ? ` -> ${m.toRole}` : " -> team"
        parts.push(`[${m.type}] ${m.fromRole}${to}: ${m.content.slice(0, 150)}`)
      }
      parts.push("")
    }

    return parts.join("\n")
  }

  export function parseAction(text: string): OrchestratorAction | undefined {
    // Extract JSON from the response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/)
    if (!jsonMatch) {
      log.warn("no JSON found in orchestrator response", { text: text.slice(0, 200) })
      return undefined
    }

    try {
      const parsed = JSON.parse(jsonMatch[1])
      return OrchestratorAction.parse(parsed)
    } catch (e) {
      log.warn("failed to parse orchestrator action", { error: e, text: jsonMatch[1].slice(0, 200) })
      return undefined
    }
  }

  export async function run(input: {
    teamSessionID: string
    orchestratorSessionID: string
    goal: string
    phase: Phase
    sharingStrategy?: "selective" | "hierarchical" | "broadcast"
    onEscalate: (question: string) => Promise<string>
    onPhaseChange: (phase: Phase) => void
    onComplete: (summary: string) => void
    abort?: AbortSignal
  }) {
    let phase = input.phase
    let totalSteps = 0
    let phaseSteps = 0
    const maxTotalSteps = 100

    log.info("starting orchestrator loop", { teamSessionID: input.teamSessionID, goal: input.goal })

    while (phase !== "complete" && totalSteps < maxTotalSteps) {
      if (input.abort?.aborted) break

      // Enforce phase budget
      const budget = PHASE_BUDGETS[phase]
      if (budget > 0 && phaseSteps >= budget) {
        log.warn("phase budget exceeded, forcing advance", { phase, phaseSteps, budget })
        const nextPhase = forceAdvance(phase)
        if (nextPhase) {
          TeamMessage.send({
            teamSessionID: input.teamSessionID,
            fromRole: "orchestrator",
            type: "status",
            content: `Phase "${phase}" budget exhausted (${phaseSteps}/${budget} steps). Auto-advancing to "${nextPhase}".`,
          })
          phase = nextPhase
          phaseSteps = 0
          input.onPhaseChange(phase)
          Bus.publish(Event.PhaseChanged, { teamSessionID: input.teamSessionID, phase })
          continue
        }
      }

      const context = buildOrchestratorContext(input.teamSessionID, input.goal, phase)

      // Ask orchestrator what to do next
      const result = await SessionPrompt.prompt({
        sessionID: input.orchestratorSessionID,
        parts: [{ type: "text" as const, text: context }],
        agent: "general",
        system: PROMPT_ORCHESTRATOR,
      })

      totalSteps++
      phaseSteps++

      const text = extractText(result)
      const action = parseAction(text)

      if (!action) {
        log.warn("orchestrator produced no valid action, retrying")
        TeamMessage.send({
          teamSessionID: input.teamSessionID,
          fromRole: "orchestrator",
          type: "status",
          content: "Failed to produce valid action. Retrying.",
        })
        continue
      }

      log.info("orchestrator action", { action: action.action, step: totalSteps })

      // Record the orchestrator's action as a team message
      const actionTarget =
        "role" in action
          ? (action as { role: string }).role
          : "to" in action
            ? (action as { to: string }).to
            : "author" in action
              ? (action as { author: string }).author
              : undefined
      const actionType =
        action.action === "assign"
          ? ("handoff" as const)
          : action.action === "escalate"
            ? ("escalation" as const)
            : action.action === "decide" || action.action === "mediate"
              ? ("decision" as const)
              : action.action === "route"
                ? ("question" as const)
                : ("status" as const)
      TeamMessage.send({
        teamSessionID: input.teamSessionID,
        fromRole: "orchestrator",
        toRole: actionTarget,
        type: actionType,
        content: JSON.stringify(action),
      })

      switch (action.action) {
        case "staff": {
          for (const spec of action.roles) {
            const template = Roles.get(spec.role)
            await Roster.spawn({
              teamSessionID: input.teamSessionID,
              role: spec.role,
              prompt: template?.prompt ?? "",
              expertise: spec.expertise,
              workspaceRead: template?.workspaceRead ?? ["goal", "constraints", "plan", "decisions"],
              workspaceWrite: template?.workspaceWrite ?? ["artifacts", "questions"],
              relationships: {
                reports_to: "orchestrator",
                collaborates_with: action.roles.filter((r) => r.role !== spec.role).map((r) => r.role),
                reviews: [],
                reviewed_by: [],
              },
            })
          }
          // After staffing, assign initial tasks
          for (const spec of action.roles) {
            const agent = Roster.get(input.teamSessionID, spec.role)
            if (!agent) continue
            const agentResult = await Execute.run(
              agent,
              spec.task,
              input.teamSessionID,
              input.goal,
              phase,
              input.sharingStrategy,
            )
            await processAgentResult(input.teamSessionID, agent, agentResult)
          }
          break
        }

        case "assign": {
          const agent = Roster.get(input.teamSessionID, action.role)
          if (!agent) {
            log.warn("agent not found for assignment", { role: action.role })
            break
          }
          const agentResult = await Execute.run(
            agent,
            action.task,
            input.teamSessionID,
            input.goal,
            phase,
            input.sharingStrategy,
          )
          await processAgentResult(input.teamSessionID, agent, agentResult)
          break
        }

        case "spawn": {
          const template = Roles.get(action.role)
          await Roster.spawn({
            teamSessionID: input.teamSessionID,
            role: action.role,
            prompt: template?.prompt ?? "",
            expertise: action.expertise,
            workspaceRead: template?.workspaceRead ?? ["goal", "constraints", "plan", "decisions"],
            workspaceWrite: template?.workspaceWrite ?? ["artifacts", "questions"],
            relationships: {
              reports_to: "orchestrator",
              collaborates_with: Roster.list(input.teamSessionID).map((a) => a.role),
              reviews: [],
              reviewed_by: [],
            },
          })
          break
        }

        case "retire": {
          const agent = Roster.get(input.teamSessionID, action.role)
          if (agent) Roster.retire(agent.id)
          break
        }

        case "route": {
          Workspace.addQuestion(input.teamSessionID, {
            question: action.question,
            asked_by: action.from,
            routed_to: action.to,
            status: "open",
          })
          // Immediately assign the target agent to answer
          const target = Roster.get(input.teamSessionID, action.to)
          if (target) {
            const agentResult = await Execute.run(
              target,
              `Answer this question from ${action.from}: ${action.question}`,
              input.teamSessionID,
              input.goal,
              phase,
              input.sharingStrategy,
            )
            await processAgentResult(input.teamSessionID, target, agentResult)
          }
          break
        }

        case "decide": {
          const decision = Workspace.addDecision(input.teamSessionID, {
            description: action.description,
            rationale: action.rationale,
            alternatives: action.alternatives,
            made_by: "orchestrator",
            status: "approved",
          })
          Bus.publish(Event.Decision, { teamSessionID: input.teamSessionID, decision })
          break
        }

        case "escalate": {
          Bus.publish(Event.Escalated, { teamSessionID: input.teamSessionID, question: action.question })
          const answer = await input.onEscalate(action.question)
          Workspace.addDecision(input.teamSessionID, {
            description: `User decision: ${action.question}`,
            rationale: answer,
            alternatives: [],
            made_by: "user",
            status: "approved",
          })
          break
        }

        case "advance": {
          phase = action.phase
          phaseSteps = 0
          input.onPhaseChange(phase)
          Bus.publish(Event.PhaseChanged, { teamSessionID: input.teamSessionID, phase })
          TeamMessage.send({
            teamSessionID: input.teamSessionID,
            fromRole: "orchestrator",
            type: "status",
            content: `Phase advanced to ${phase}: ${action.summary}`,
          })
          break
        }

        case "review": {
          const reviewResult = await ReviewLoop.run({
            teamSessionID: input.teamSessionID,
            artifact: action.artifact,
            authorRole: action.author,
            reviewerRole: action.reviewer,
            teamGoal: input.goal,
            phase,
          })
          if (reviewResult.escalated) {
            TeamMessage.send({
              teamSessionID: input.teamSessionID,
              fromRole: "orchestrator",
              type: "status",
              content: `Review between ${action.author} and ${action.reviewer} escalated. Orchestrator will mediate.`,
            })
          }
          break
        }

        case "mediate": {
          const thread = Review.get(action.review_id)
          if (thread) {
            Workspace.addDecision(input.teamSessionID, {
              description: `Orchestrator mediation on review ${action.review_id}: ${action.decision}`,
              rationale: action.rationale,
              alternatives: [],
              made_by: "orchestrator",
              status: "approved",
            })
            Review.approve(action.review_id)
            TeamMessage.send({
              teamSessionID: input.teamSessionID,
              fromRole: "orchestrator",
              type: "decision",
              content: `Mediated review ${action.review_id}: ${action.decision}. Rationale: ${action.rationale}`,
              refs: [action.review_id],
            })
          }
          break
        }

        case "complete": {
          phase = "complete"
          input.onComplete(action.summary)
          TeamMessage.send({
            teamSessionID: input.teamSessionID,
            fromRole: "orchestrator",
            type: "status",
            content: `Team session complete: ${action.summary}`,
          })
          break
        }
      }
    }

    if (totalSteps >= maxTotalSteps) {
      log.warn("orchestrator reached max steps", { teamSessionID: input.teamSessionID })
    }

    return phase
  }

  async function processAgentResult(teamSessionID: string, agent: Roster.Info, result: Execute.AgentResult) {
    // Record agent's output as team messages
    for (const proposal of result.proposals) {
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "proposal",
        content: proposal,
      })
      Workspace.set(
        teamSessionID,
        "plan",
        {
          status: "in_review",
          architecture: proposal,
        },
        agent.role,
      )
    }

    for (const q of result.questions) {
      Workspace.addQuestion(teamSessionID, {
        question: q.content,
        asked_by: agent.role,
        routed_to: q.target,
        status: "open",
      })
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        toRole: q.target,
        type: "question",
        content: q.content,
      })
    }

    for (const concern of result.concerns) {
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "status",
        content: `[CONCERN] ${concern}`,
      })
    }

    for (const artifact of result.artifacts) {
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "artifact",
        content: artifact,
      })
    }

    // Process explicit spawn requests
    for (const spawn of result.spawnRequests) {
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "spawn_request",
        content: `Requesting ${spawn.role}: ${spawn.reason}`,
      })
    }

    for (const critique of result.critiques) {
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "critique",
        content: critique,
      })
    }

    if (result.complete) {
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "status",
        content: `[COMPLETE] ${result.completeSummary ?? "Task finished."}`,
      })
    }

    // Implicit signal detection: scan concerns and full text for role signals
    const activeRoles = Roster.list(teamSessionID).map((a) => a.role)
    const signalText = [...result.concerns, ...result.questions.map((q) => q.content), result.text].join("\n")
    const matches = Roles.match(signalText, activeRoles)

    for (const m of matches.slice(0, 2)) {
      // Only surface strong signals (2+ hits) as suggestions
      if (m.score >= 2) {
        TeamMessage.send({
          teamSessionID,
          fromRole: "system",
          type: "spawn_request",
          content: `Implicit signal detected: ${m.role} (signals: ${m.signals.join(", ")}). Consider spawning via {"action":"spawn","role":"${m.role}","expertise":${JSON.stringify(m.signals)},"reason":"Detected in ${agent.role}'s output"}`,
        })
        log.info("implicit spawn signal", { from: agent.role, suggested: m.role, signals: m.signals })
      }
    }
  }

  export function extractText(result: unknown): string {
    if (!result) return ""
    if (typeof result === "string") return result
    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>
      if (typeof r.text === "string") return r.text
      if (typeof r.content === "string") return r.content
      // MessageV2.WithParts structure
      if (Array.isArray(r.parts)) {
        return r.parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")
      }
    }
    return String(result)
  }
}
