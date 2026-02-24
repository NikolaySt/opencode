import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session"
import { Workspace } from "./workspace"
import { Roster } from "./roster"
import { TeamMessage } from "./message"
import { Log } from "@/util/log"
import type { SharingStrategy } from "./sharing/strategy"
import { resolve } from "./sharing/strategy"

export namespace Execute {
  const log = Log.create({ service: "team-execute" })

  /** Tools that represent actual work (file changes, command execution) */
  const ACTION_TOOLS = new Set(["bash", "edit", "write", "patch", "multiedit", "apply_patch"])

  export interface ToolCallInfo {
    tool: string
    title: string
    input: Record<string, any>
    output: string
  }

  export interface AgentContext {
    workspaceSummary: string
    relevantMessages: TeamMessage.Info[]
    decisions: Workspace.Decision[]
    openQuestions: Workspace.Question[]
  }

  export interface AgentResult {
    text: string
    proposals: string[]
    questions: Array<{ target: string; content: string }>
    concerns: string[]
    artifacts: string[]
    spawnRequests: Array<{ role: string; reason: string }>
    complete: boolean
    completeSummary?: string
    /** Agent signals it has more work — includes description of next step */
    continuing: boolean
    continueDescription?: string
    critiques: string[]
    approved: boolean
    toolCalls: ToolCallInfo[]
  }

  export interface SubStep {
    index: number
    description: string
    result: AgentResult
    timestamp: number
  }

  export interface MultiStepResult {
    steps: SubStep[]
    /** Merged result across all steps */
    merged: AgentResult
    stepsUsed: number
  }

  export function buildContext(agent: Roster.Info, teamSessionID: string): AgentContext {
    const summary = Workspace.summary(teamSessionID)
    const messages = TeamMessage.forRole(teamSessionID, agent.role, 15)
    const decisions = (Workspace.get(teamSessionID, "decisions") as Workspace.Decision[]) ?? []
    const questions = Workspace.openQuestions(teamSessionID)

    return {
      workspaceSummary: summary,
      relevantMessages: messages,
      decisions,
      openQuestions: questions.filter((q) => q.routed_to === agent.role),
    }
  }

  export function buildMessage(
    task: string,
    context: AgentContext,
    agent: Roster.Info,
    teamGoal: string,
    phase: string,
  ): string {
    const parts: string[] = []

    parts.push(`You are part of a team working on: ${teamGoal}`)
    parts.push(`Your role: ${agent.role}`)
    parts.push(`Current phase: ${phase}`)
    parts.push("")

    parts.push("## Workspace Summary")
    parts.push(context.workspaceSummary)
    parts.push("")

    parts.push("## Your Assignment")
    parts.push(task)
    parts.push("")

    if (context.decisions.length) {
      parts.push("## Previous Decisions")
      for (const d of context.decisions) {
        parts.push(`- [${d.status}] ${d.description} (by ${d.made_by}): ${d.rationale}`)
      }
      parts.push("")
    }

    if (context.openQuestions.length) {
      parts.push("## Questions Routed to You")
      for (const q of context.openQuestions) {
        parts.push(`- From ${q.asked_by}: ${q.question}`)
      }
      parts.push("")
    }

    if (context.relevantMessages.length) {
      parts.push("## Recent Team Communication")
      for (const m of context.relevantMessages.slice(-10)) {
        const to = m.toRole ? ` -> ${m.toRole}` : " -> team"
        parts.push(`[${m.type}] ${m.fromRole}${to}: ${m.content.slice(0, 200)}`)
      }
      parts.push("")
    }

    return parts.join("\n")
  }

  /**
   * Build agent message using a sharing strategy.
   * This replaces the default buildContext + buildMessage flow
   * with a strategy-driven context builder.
   */
  function buildStrategyMessage(
    task: string,
    agent: Roster.Info,
    teamSessionID: string,
    teamGoal: string,
    phase: string,
    strategy: SharingStrategy,
  ): string {
    const context = strategy.buildContext({ agent, teamSessionID, teamGoal, phase })
    return context + "\n## Your Assignment\n" + task + "\n"
  }

  export async function run(
    agent: Roster.Info,
    task: string,
    teamSessionID: string,
    teamGoal: string,
    phase: string,
    strategyName?: "selective" | "hierarchical" | "broadcast",
  ): Promise<AgentResult> {
    if (!agent.sessionID) throw new Error(`Agent ${agent.role} has no session`)

    Roster.setStatus(agent.id, "working")

    const message = strategyName
      ? buildStrategyMessage(task, agent, teamSessionID, teamGoal, phase, await resolve(strategyName))
      : buildMessage(task, buildContext(agent, teamSessionID), agent, teamGoal, phase)

    log.info("running agent", {
      role: agent.role,
      task: task.slice(0, 100),
      strategy: strategyName ?? "default",
    })

    try {
      const result = await SessionPrompt.prompt({
        sessionID: agent.sessionID,
        parts: [{ type: "text" as const, text: message }],
        agent: "general",
        system: agent.prompt,
      })

      Roster.setStatus(agent.id, "idle")
      Roster.incrementSteps(agent.id)

      const text = extractAssistantText(result)
      const parsed = parseOutput(text)

      // Extract tool calls from the agent's session
      const toolCalls = await extractToolCalls(agent.sessionID)
      parsed.toolCalls = toolCalls

      if (toolCalls.length) {
        log.info("agent tool activity", {
          role: agent.role,
          tools: toolCalls.map((t) => t.tool),
          count: toolCalls.length,
        })
      }

      // Run propagation if using a sharing strategy
      if (strategyName) {
        const strategy = await resolve(strategyName)
        strategy.propagate({
          agent,
          teamSessionID,
          output: text,
          mutations: [],
        })
      }

      return parsed
    } catch (error) {
      log.error("agent error", { role: agent.role, error })
      Roster.setStatus(agent.id, "idle")
      return {
        text: `Error: ${error}`,
        proposals: [],
        questions: [],
        concerns: [],
        artifacts: [],
        spawnRequests: [],
        complete: false,
        continuing: false,
        critiques: [],
        approved: false,
        toolCalls: [],
      }
    }
  }

  export function extractAssistantText(result: unknown): string {
    if (!result) return ""
    if (typeof result === "string") return result
    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>
      if (typeof r.text === "string") return r.text
      if (typeof r.content === "string") return r.content
    }
    return String(result)
  }

  /**
   * Extract completed tool calls from an agent's session.
   * Only returns "action" tools (bash, edit, write, patch, etc.)
   * that represent actual work, not informational reads.
   */
  export async function extractToolCalls(sessionID: string): Promise<ToolCallInfo[]> {
    try {
      const msgs = await Session.messages({ sessionID })
      const calls: ToolCallInfo[] = []

      for (const msg of msgs) {
        for (const part of msg.parts) {
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (!ACTION_TOOLS.has(part.tool)) continue

          calls.push({
            tool: part.tool,
            title: part.state.title,
            input: part.state.input,
            output: part.state.output.slice(0, 500),
          })
        }
      }

      return calls
    } catch (error) {
      log.warn("failed to extract tool calls", { sessionID, error })
      return []
    }
  }

  /**
   * Summarize tool calls into a human-readable string for the orchestrator.
   */
  export function summarizeToolCalls(calls: ToolCallInfo[]): string {
    if (!calls.length) return ""

    const files = new Set<string>()
    const commands: string[] = []

    for (const call of calls) {
      if (call.tool === "bash") {
        const cmd = call.input.command ?? call.input.cmd ?? ""
        if (cmd) commands.push(typeof cmd === "string" ? cmd.slice(0, 80) : String(cmd))
      }
      if (call.tool === "edit" || call.tool === "write" || call.tool === "patch" || call.tool === "apply_patch") {
        const file = call.input.filePath ?? call.input.file ?? call.input.path ?? ""
        if (file) files.add(typeof file === "string" ? file : String(file))
      }
    }

    const parts: string[] = []
    if (files.size) parts.push(`Modified files: ${[...files].join(", ")}`)
    if (commands.length) parts.push(`Commands: ${commands.join("; ")}`)
    if (!parts.length) parts.push(`${calls.length} tool call(s)`)

    return parts.join(". ")
  }

  export function parseOutput(text: string): AgentResult {
    const proposals: string[] = []
    const questions: Array<{ target: string; content: string }> = []
    const concerns: string[] = []
    const artifacts: string[] = []
    const spawnRequests: Array<{ role: string; reason: string }> = []
    const critiques: string[] = []
    let complete = false
    let completeSummary: string | undefined
    let approved = false

    // All known tags used as terminators in lookaheads
    const tags = "PROPOSAL|DECISION|QUESTION|CONCERN|COMPLETE|CONTINUE|ARTIFACT|SPAWN|CRITIQUE|APPROVED"

    // Extract [PROPOSAL] blocks
    const proposalMatches = text.matchAll(
      new RegExp(`\\[PROPOSAL\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "gi"),
    )
    for (const m of proposalMatches) {
      proposals.push(m[1].trim())
    }

    // Extract [QUESTION: role] blocks
    const questionMatches = text.matchAll(
      new RegExp(`\\[QUESTION:\\s*(\\w[\\w-]*)\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "gi"),
    )
    for (const m of questionMatches) {
      questions.push({ target: m[1], content: m[2].trim() })
    }

    // Extract [CONCERN: ...] blocks
    const concernMatches = text.matchAll(
      new RegExp(`\\[CONCERN:\\s*([\\s\\S]*?)\\](?:\\s*([\\s\\S]*?))?(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "gi"),
    )
    for (const m of concernMatches) {
      concerns.push(m[1].trim() + (m[2]?.trim() ? "\n" + m[2].trim() : ""))
    }

    // Extract [ARTIFACT] blocks
    const artifactMatches = text.matchAll(
      new RegExp(`\\[ARTIFACT\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "gi"),
    )
    for (const m of artifactMatches) {
      artifacts.push(m[1].trim())
    }

    // Extract [SPAWN: role] blocks
    const spawnMatches = text.matchAll(
      new RegExp(`\\[SPAWN:\\s*(\\w[\\w-]*)\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "gi"),
    )
    for (const m of spawnMatches) {
      spawnRequests.push({ role: m[1], reason: m[2].trim() })
    }

    // Extract [CRITIQUE] blocks
    const critiqueMatches = text.matchAll(
      new RegExp(`\\[CRITIQUE\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "gi"),
    )
    for (const m of critiqueMatches) {
      critiques.push(m[1].trim())
    }

    // Check for [COMPLETE] — use same tag-set terminator as other patterns
    const completeMatch = text.match(
      new RegExp(`\\[COMPLETE\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "i"),
    )
    if (completeMatch) {
      complete = true
      completeSummary = completeMatch[1].trim() || undefined
    }

    // Check for [CONTINUE] — agent signals more work needed
    let continuing = false
    let continueDescription: string | undefined
    const continueMatch = text.match(
      new RegExp(`\\[CONTINUE\\]\\s*([\\s\\S]*?)(?=\\n\\[(?:${tags})(?:[:\\]])|\\n##|$)`, "i"),
    )
    if (continueMatch) {
      continuing = true
      continueDescription = continueMatch[1].trim() || undefined
    }

    // Check for [APPROVED] — case-insensitive
    if (/\[APPROVED\]/i.test(text)) {
      approved = true
      complete = true
    }

    return {
      text,
      proposals,
      questions,
      concerns,
      artifacts,
      spawnRequests,
      complete,
      completeSummary,
      continuing,
      continueDescription,
      critiques,
      approved,
      toolCalls: [],
    }
  }

  const MAX_SUBSTEPS = 10

  /**
   * Build a follow-up message for a continuation step.
   * Refreshes workspace context so the agent sees decisions/artifacts
   * from other agents that may have run concurrently.
   */
  export function buildContinueMessage(
    agent: Roster.Info,
    teamSessionID: string,
    teamGoal: string,
    phase: string,
    previousSummary: string,
    stepIndex: number,
    continueDescription?: string,
  ): string {
    const context = buildContext(agent, teamSessionID)
    const parts: string[] = []

    parts.push(`You are part of a team working on: ${teamGoal}`)
    parts.push(`Your role: ${agent.role}`)
    parts.push(`Current phase: ${phase}`)
    parts.push(`This is step ${stepIndex + 1} of your current assignment.`)
    parts.push("")

    parts.push("## Updated Workspace Summary")
    parts.push(context.workspaceSummary)
    parts.push("")

    parts.push("## Previous Step Summary")
    parts.push(previousSummary)
    parts.push("")

    if (continueDescription) {
      parts.push("## Your Next Step")
      parts.push(continueDescription)
      parts.push("")
    } else {
      parts.push("## Continue Your Assignment")
      parts.push("Continue working on the next step of your task.")
      parts.push("")
    }

    if (context.decisions.length) {
      parts.push("## Decisions (may have been updated)")
      for (const d of context.decisions) {
        parts.push(`- [${d.status}] ${d.description} (by ${d.made_by}): ${d.rationale}`)
      }
      parts.push("")
    }

    if (context.openQuestions.length) {
      parts.push("## Questions Routed to You")
      for (const q of context.openQuestions) {
        parts.push(`- From ${q.asked_by}: ${q.question}`)
      }
      parts.push("")
    }

    return parts.join("\n")
  }

  export function mergeResults(steps: SubStep[]): AgentResult {
    const merged: AgentResult = {
      text: steps.map((s) => s.result.text).join("\n\n---\n\n"),
      proposals: steps.flatMap((s) => s.result.proposals),
      questions: steps.flatMap((s) => s.result.questions),
      concerns: steps.flatMap((s) => s.result.concerns),
      artifacts: steps.flatMap((s) => s.result.artifacts),
      spawnRequests: steps.flatMap((s) => s.result.spawnRequests),
      critiques: steps.flatMap((s) => s.result.critiques),
      toolCalls: steps.flatMap((s) => s.result.toolCalls),
      complete: steps.at(-1)?.result.complete ?? false,
      completeSummary: steps.at(-1)?.result.completeSummary,
      continuing: false,
      approved: steps.some((s) => s.result.approved),
    }
    return merged
  }

  /**
   * Run an agent with multi-step iteration.
   *
   * The agent executes its task and can signal [CONTINUE] to request
   * additional steps. Between steps the workspace context is refreshed
   * so the agent sees decisions and artifacts from other agents.
   *
   * @param onStep Optional callback invoked after each step completes.
   *               Receives the step result and can be used to update
   *               TODO state or process intermediate results.
   */
  export async function runMultiStep(
    agent: Roster.Info,
    task: string,
    teamSessionID: string,
    teamGoal: string,
    phase: string,
    strategyName?: "selective" | "hierarchical" | "broadcast",
    onStep?: (step: SubStep) => Promise<void>,
  ): Promise<MultiStepResult> {
    const steps: SubStep[] = []

    // Step 0: initial run
    const first = await run(agent, task, teamSessionID, teamGoal, phase, strategyName)
    steps.push({
      index: 0,
      description: task.slice(0, 120),
      result: first,
      timestamp: Date.now(),
    })
    if (onStep) await onStep(steps[0])

    // If the agent doesn't signal continue, or already signalled complete, we're done
    let current = first
    while (current.continuing && !current.complete && steps.length < MAX_SUBSTEPS) {
      const stepIndex = steps.length
      const summary = current.completeSummary ?? current.text.slice(0, 500)

      log.info("agent continuing", {
        role: agent.role,
        step: stepIndex,
        next: current.continueDescription?.slice(0, 80),
      })

      // Record a status message so the orchestrator can see progress
      TeamMessage.send({
        teamSessionID,
        fromRole: agent.role,
        type: "status",
        content: `[STEP ${stepIndex}] ${current.continueDescription ?? "Continuing..."}`,
      })

      // Build continuation message with refreshed context
      const message = buildContinueMessage(
        agent,
        teamSessionID,
        teamGoal,
        phase,
        summary,
        stepIndex,
        current.continueDescription,
      )

      // Re-enter the agent's session with the continuation prompt
      if (!agent.sessionID) throw new Error(`Agent ${agent.role} has no session`)
      Roster.setStatus(agent.id, "working")

      try {
        const result = await SessionPrompt.prompt({
          sessionID: agent.sessionID,
          parts: [{ type: "text" as const, text: message }],
          agent: "general",
          system: agent.prompt,
        })

        Roster.setStatus(agent.id, "idle")
        Roster.incrementSteps(agent.id)

        const text = extractAssistantText(result)
        const parsed = parseOutput(text)
        parsed.toolCalls = await extractToolCalls(agent.sessionID)

        if (parsed.toolCalls.length) {
          log.info("agent tool activity (step)", {
            role: agent.role,
            step: stepIndex,
            tools: parsed.toolCalls.map((t) => t.tool),
            count: parsed.toolCalls.length,
          })
        }

        // Propagate if using a sharing strategy
        if (strategyName) {
          const strategy = await resolve(strategyName)
          strategy.propagate({
            agent,
            teamSessionID,
            output: text,
            mutations: [],
          })
        }

        const step: SubStep = {
          index: stepIndex,
          description: current.continueDescription ?? `Step ${stepIndex + 1}`,
          result: parsed,
          timestamp: Date.now(),
        }
        steps.push(step)
        if (onStep) await onStep(step)

        current = parsed
      } catch (error) {
        log.error("agent error (step)", { role: agent.role, step: stepIndex, error })
        Roster.setStatus(agent.id, "idle")
        break
      }
    }

    if (steps.length >= MAX_SUBSTEPS && current.continuing) {
      log.warn("agent hit max substeps", { role: agent.role, max: MAX_SUBSTEPS })
      TeamMessage.send({
        teamSessionID,
        fromRole: "system",
        type: "status",
        content: `Agent ${agent.role} reached max sub-steps (${MAX_SUBSTEPS}). Forcing completion.`,
      })
    }

    return {
      steps,
      merged: mergeResults(steps),
      stepsUsed: steps.length,
    }
  }
}
