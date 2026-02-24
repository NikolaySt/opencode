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
import { Todo } from "@/session/todo"
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

  export const AgentProgress = z.object({
    role: z.string(),
    task: z.string(),
    status: z.enum(["idle", "working", "waiting", "retired", "done"]),
    stepsUsed: z.number(),
    tokensConsumed: z.number(),
    subSteps: z
      .array(
        z.object({
          description: z.string(),
          done: z.boolean(),
        }),
      )
      .optional(),
  })
  export type AgentProgress = z.infer<typeof AgentProgress>

  export const TeamProgress = z.object({
    teamSessionID: z.string(),
    parentSessionID: z.string(),
    goal: z.string(),
    phase: Phase,
    phases: z.array(
      z.object({
        name: Phase,
        status: z.enum(["completed", "in_progress", "pending"]),
      }),
    ),
    agents: z.array(AgentProgress),
  })
  export type TeamProgress = z.infer<typeof TeamProgress>

  export const Event = {
    PhaseChanged: BusEvent.define("team.phase_changed", z.object({ teamSessionID: z.string(), phase: Phase })),
    Decision: BusEvent.define("team.decision", z.object({ teamSessionID: z.string(), decision: Workspace.Decision })),
    Escalated: BusEvent.define("team.escalated", z.object({ teamSessionID: z.string(), question: z.string() })),
    Progress: BusEvent.define("team.progress", TeamProgress),
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

  const ParallelAssignAction = z.object({
    action: z.literal("parallel_assign"),
    assignments: z.array(
      z.object({
        role: z.string(),
        task: z.string(),
      }),
    ),
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
    ParallelAssignAction,
  ])
  type OrchestratorAction = z.infer<typeof OrchestratorAction>

  const PHASE_ORDER: Phase[] = ["understanding", "design", "implementation", "verification", "complete"]

  /**
   * Track team progress as TODOs on the parent session so the sidebar
   * shows a live task list. Each phase becomes a TODO, and assigned
   * agent tasks become sub-items with sub-step detail.
   */
  interface TaskEntry {
    role: string
    task: string
    done: boolean
    /** Sub-steps tracked when using multi-step execution */
    subSteps?: Array<{ description: string; done: boolean }>
  }

  function syncTodos(
    parentSessionID: string | undefined,
    teamSessionID: string,
    goal: string,
    phase: Phase,
    tasks: TaskEntry[],
  ) {
    if (!parentSessionID) return

    const todos: Todo.Info[] = []

    // Phase progress
    const phases: TeamProgress["phases"] = []
    for (const p of PHASE_ORDER) {
      if (p === "complete") continue
      const idx = PHASE_ORDER.indexOf(p)
      const current = PHASE_ORDER.indexOf(phase)
      const status: "completed" | "in_progress" | "pending" =
        idx < current ? "completed" : idx === current ? "in_progress" : "pending"
      todos.push({ content: `Phase: ${p}`, status, priority: "high" })
      phases.push({ name: p, status })
    }

    // Build agent progress from roster + tasks
    const roster = Roster.list(teamSessionID)
    const agents: AgentProgress[] = []
    for (const t of tasks) {
      const agent = roster.find((a) => a.role === t.role)
      agents.push({
        role: t.role,
        task: t.task,
        status: t.done ? "done" : (agent?.status ?? "working"),
        stepsUsed: agent?.stepsUsed ?? 0,
        tokensConsumed: agent?.tokensConsumed ?? 0,
        subSteps: t.subSteps,
      })
      todos.push({
        content: `[${t.role}] ${t.task.slice(0, 80)}`,
        status: t.done ? "completed" : "in_progress",
        priority: "medium",
      })
      if (t.subSteps) {
        for (const s of t.subSteps) {
          todos.push({
            content: `  - ${s.description.slice(0, 60)}`,
            status: s.done ? "completed" : "in_progress",
            priority: "low",
          })
        }
      }
    }

    // Include roster members not currently in a task (idle agents)
    for (const agent of roster) {
      if (!tasks.some((t) => t.role === agent.role)) {
        agents.push({
          role: agent.role,
          task: "",
          status: agent.status === "retired" ? "retired" : "idle",
          stepsUsed: agent.stepsUsed,
          tokensConsumed: agent.tokensConsumed,
        })
      }
    }

    Todo.update({ sessionID: parentSessionID, todos })
    Bus.publish(Event.Progress, {
      teamSessionID,
      parentSessionID,
      goal,
      phase,
      phases,
      agents,
    })
  }

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

    // Surface file changes and tool activity from agents
    const toolMessages = messages.filter((m) => m.content.startsWith("[TOOLS]"))
    if (toolMessages.length) {
      parts.push("## Agent Tool Activity")
      for (const m of toolMessages.slice(-10)) {
        parts.push(`- ${m.fromRole}: ${m.content.slice(8).trim()}`)
      }
      parts.push("")
    }

    // Show modified files from workspace artifacts
    const artifacts = Workspace.get(teamSessionID, "artifacts") as Record<string, unknown> | undefined
    if (artifacts) {
      const modified = artifacts.modified_files as string[] | undefined
      if (modified?.length) {
        parts.push("## Modified Files")
        for (const f of modified) {
          parts.push(`- ${f}`)
        }
        parts.push("")
      }
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

  /**
   * Run multiple agent assignments concurrently using Promise.allSettled.
   * Each agent gets its own TaskEntry with sub-step tracking. Workspace
   * writes are safe because set/append/merge use Database.transaction.
   */
  async function runParallel(
    assignments: Array<{ role: string; task: string }>,
    input: {
      teamSessionID: string
      parentSessionID?: string
      goal: string
      sharingStrategy?: "selective" | "hierarchical" | "broadcast"
    },
    phase: Phase,
    agentTasks: TaskEntry[],
  ) {
    // Build (agent, entry) pairs, skipping missing agents
    const work: Array<{ agent: Roster.Info; entry: TaskEntry; task: string }> = []
    for (const a of assignments) {
      const agent = Roster.get(input.teamSessionID, a.role)
      if (!agent) {
        log.warn("agent not found for parallel assignment", { role: a.role })
        continue
      }
      const entry =
        agentTasks.find((t) => t.role === a.role && !t.done) ??
        (() => {
          const e: TaskEntry = { role: a.role, task: a.task, done: false }
          agentTasks.push(e)
          return e
        })()
      work.push({ agent, entry, task: a.task })
    }

    if (!work.length) return

    syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)

    log.info("running agents in parallel", {
      roles: work.map((w) => w.agent.role),
      count: work.length,
    })

    const results = await Promise.allSettled(
      work.map(async ({ agent, entry, task }) => {
        const multiResult = await Execute.runMultiStep(
          agent,
          task,
          input.teamSessionID,
          input.goal,
          phase,
          input.sharingStrategy,
          async (step) => {
            if (!entry.subSteps) entry.subSteps = []
            entry.subSteps.push({ description: step.description, done: false })
            for (let i = 0; i < entry.subSteps.length - 1; i++) entry.subSteps[i].done = true
            syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
          },
        )
        await processAgentResult(input.teamSessionID, agent, multiResult.merged)
        entry.done = true
        if (entry.subSteps) for (const s of entry.subSteps) s.done = true
        return { role: agent.role, result: multiResult }
      }),
    )

    // Log any failures
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        const role = work[i].agent.role
        log.error("parallel agent failed", { role, error: r.reason })
        TeamMessage.send({
          teamSessionID: input.teamSessionID,
          fromRole: "system",
          type: "status",
          content: `Agent ${role} failed during parallel execution: ${r.reason}`,
        })
      }
    }

    syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
  }

  export async function run(input: {
    teamSessionID: string
    orchestratorSessionID: string
    parentSessionID?: string
    goal: string
    phase: Phase
    sharingStrategy?: "selective" | "hierarchical" | "broadcast"
    onEscalate: (question: string) => Promise<string>
    onPhaseChange: (phase: Phase) => void
    onComplete: (summary: string) => void
    onActivity?: (activity: { time: number; type: string; role?: string; message: string }) => void
    abort?: AbortSignal
  }) {
    let phase = input.phase
    let totalSteps = 0
    let phaseSteps = 0
    const maxTotalSteps = 100
    const agentTasks: TaskEntry[] = []

    function activity(type: string, message: string, role?: string) {
      input.onActivity?.({ time: Date.now(), type, role, message })
    }

    log.info("starting orchestrator loop", { teamSessionID: input.teamSessionID, goal: input.goal })

    activity("advance", `Starting phase: ${phase}`)

    // Initial TODO state
    syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)

    while (phase !== "complete" && totalSteps < maxTotalSteps) {
      if (input.abort?.aborted) break

      // Enforce phase budget
      const budget = PHASE_BUDGETS[phase]
      if (budget > 0 && phaseSteps >= budget) {
        activity("advance", `Phase "${phase}" budget exhausted (${phaseSteps}/${budget}), auto-advancing`)
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
          activity("staff", `Staffing ${action.roles.length} agents: ${action.roles.map((r) => r.role).join(", ")}`)
          // Spawn all agents first (sequential — each creates a session)
          for (const spec of action.roles) {
            const template = Roles.get(spec.role)
            await Roster.spawn({
              teamSessionID: input.teamSessionID,
              parentSessionID: input.parentSessionID,
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
            agentTasks.push({ role: spec.role, task: spec.task, done: false })
            activity("spawn", `Spawned ${spec.role}`, spec.role)
          }
          syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)

          // Run initial tasks in parallel
          activity("parallel_assign", `Running ${action.roles.length} agents in parallel`)
          const assignments = action.roles.map((spec) => ({ role: spec.role, task: spec.task }))
          await runParallel(assignments, input, phase, agentTasks)
          for (const spec of action.roles) {
            activity("agent_done", `${spec.role} finished initial task`, spec.role)
          }
          break
        }

        case "assign": {
          const agent = Roster.get(input.teamSessionID, action.role)
          if (!agent) {
            log.warn("agent not found for assignment", { role: action.role })
            break
          }
          activity("assign", `${action.role}: ${action.task.slice(0, 80)}`, action.role)
          const assignEntry: TaskEntry = { role: action.role, task: action.task, done: false }
          agentTasks.push(assignEntry)
          syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
          const multiResult = await Execute.runMultiStep(
            agent,
            action.task,
            input.teamSessionID,
            input.goal,
            phase,
            input.sharingStrategy,
            async (step) => {
              if (!assignEntry.subSteps) assignEntry.subSteps = []
              assignEntry.subSteps.push({ description: step.description, done: false })
              for (let i = 0; i < assignEntry.subSteps.length - 1; i++) assignEntry.subSteps[i].done = true
              activity("agent_step", `${action.role}: ${step.description.slice(0, 60)}`, action.role)
              syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
            },
          )
          await processAgentResult(input.teamSessionID, agent, multiResult.merged)
          assignEntry.done = true
          if (assignEntry.subSteps) for (const s of assignEntry.subSteps) s.done = true
          activity("agent_done", `${action.role} completed task`, action.role)
          syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
          break
        }

        case "spawn": {
          activity("spawn", `Spawning ${action.role}: ${action.reason.slice(0, 60)}`, action.role)
          const template = Roles.get(action.role)
          await Roster.spawn({
            teamSessionID: input.teamSessionID,
            parentSessionID: input.parentSessionID,
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
          activity("retire", `Retiring ${action.role}: ${action.reason.slice(0, 60)}`, action.role)
          const agent = Roster.get(input.teamSessionID, action.role)
          if (agent) Roster.retire(agent.id)
          break
        }

        case "route": {
          activity("route", `${action.from} -> ${action.to}: ${action.question.slice(0, 60)}`)
          Workspace.addQuestion(input.teamSessionID, {
            question: action.question,
            asked_by: action.from,
            routed_to: action.to,
            status: "open",
          })
          // Immediately assign the target agent to answer
          const target = Roster.get(input.teamSessionID, action.to)
          if (target) {
            const routeTask = `Answer question from ${action.from}: ${action.question}`
            const routeEntry: TaskEntry = { role: action.to, task: routeTask.slice(0, 80), done: false }
            agentTasks.push(routeEntry)
            syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
            const multiResult = await Execute.runMultiStep(
              target,
              routeTask,
              input.teamSessionID,
              input.goal,
              phase,
              input.sharingStrategy,
              async (step) => {
                if (!routeEntry.subSteps) routeEntry.subSteps = []
                routeEntry.subSteps.push({ description: step.description, done: false })
                for (let i = 0; i < routeEntry.subSteps.length - 1; i++) routeEntry.subSteps[i].done = true
                syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
              },
            )
            await processAgentResult(input.teamSessionID, target, multiResult.merged)
            routeEntry.done = true
            if (routeEntry.subSteps) for (const s of routeEntry.subSteps) s.done = true
            activity("agent_done", `${action.to} answered question from ${action.from}`, action.to)
            syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
          }
          break
        }

        case "decide": {
          activity("decide", action.description.slice(0, 80))
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
          activity("escalate", `Asking user: ${action.question.slice(0, 80)}`)
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
          activity("advance", `Advancing to ${action.phase}: ${action.summary.slice(0, 60)}`)
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
          syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
          break
        }

        case "review": {
          activity("review", `${action.reviewer} reviewing ${action.author}'s work on ${action.artifact.slice(0, 40)}`)
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
          activity("mediate", `Mediating review: ${action.decision.slice(0, 60)}`)
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
          activity("complete", action.summary.slice(0, 100))
          phase = "complete"
          input.onComplete(action.summary)
          TeamMessage.send({
            teamSessionID: input.teamSessionID,
            fromRole: "orchestrator",
            type: "status",
            content: `Team session complete: ${action.summary}`,
          })
          // Mark all tasks and phases done
          for (const t of agentTasks) t.done = true
          syncTodos(input.parentSessionID, input.teamSessionID, input.goal, phase, agentTasks)
          break
        }

        case "parallel_assign": {
          activity(
            "parallel_assign",
            `Running ${action.assignments.length} agents in parallel: ${action.assignments.map((a) => a.role).join(", ")}`,
          )
          await runParallel(action.assignments, input, phase, agentTasks)
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

    // Surface tool calls as a status message so the orchestrator knows what actually happened
    if (result.toolCalls.length) {
      const summary = Execute.summarizeToolCalls(result.toolCalls)
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "status",
        content: `[TOOLS] ${summary}`,
      })

      // Record file modifications in workspace artifacts (atomic merge to prevent lost updates)
      const files = result.toolCalls
        .filter((c) => c.tool !== "bash")
        .map((c) => c.input.filePath ?? c.input.file ?? c.input.path)
        .filter(Boolean)
      if (files.length) {
        Workspace.merge(
          teamSessionID,
          "artifacts",
          (raw) => {
            const obj = (raw as Record<string, unknown>) ?? {}
            const modified = ((obj.modified_files as string[]) ?? []).concat(files.map((f: unknown) => String(f)))
            return { ...obj, modified_files: [...new Set(modified)] }
          },
          agent.role,
        )
      }

      // Record bash commands that were run (atomic merge to prevent lost updates)
      const commands = result.toolCalls
        .filter((c) => c.tool === "bash")
        .map((c) => ({
          command: String(c.input.command ?? c.input.cmd ?? "").slice(0, 120),
          output: c.output.slice(0, 200),
          title: c.title,
        }))
      if (commands.length) {
        Workspace.merge(
          teamSessionID,
          "artifacts",
          (raw) => {
            const obj = (raw as Record<string, unknown>) ?? {}
            const existing = (obj.commands_run as Array<{ command: string; output: string; title: string }>) ?? []
            return { ...obj, commands_run: [...existing, ...commands] }
          },
          agent.role,
        )
      }
    }

    if (result.complete) {
      const toolSuffix = result.toolCalls.length > 0 ? ` (${result.toolCalls.length} tool calls executed)` : ""
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "status",
        content: `[COMPLETE] ${result.completeSummary ?? "Task finished."}${toolSuffix}`,
      })
    }

    // If the merged result still has a continue signal but was force-stopped,
    // record that so the orchestrator knows it may need to re-assign
    if (result.continuing && !result.complete) {
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "status",
        content: `[INCOMPLETE] Agent wanted to continue but was stopped. Next step: ${result.continueDescription ?? "unknown"}`,
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
