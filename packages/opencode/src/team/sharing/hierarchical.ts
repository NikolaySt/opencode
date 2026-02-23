import type { SharingStrategy, PropagationResult } from "./strategy"
import { Workspace } from "../workspace"

/**
 * Hierarchical sharing: agents only see what the orchestrator
 * explicitly includes in their assignment. All output goes back
 * through the orchestrator — no lateral visibility between agents.
 *
 * This gives the orchestrator maximum control over information flow,
 * but adds latency since all context must be manually curated.
 */
export const hierarchical: SharingStrategy = {
  name: "hierarchical",

  buildContext(input) {
    const parts: string[] = []

    parts.push(`You are part of a team working on: ${input.teamGoal}`)
    parts.push(`Your role: ${input.agent.role}`)
    parts.push(`Current phase: ${input.phase}`)
    parts.push("")

    // In hierarchical mode, the agent gets a minimal summary.
    // The orchestrator enriches the context per-assignment via the task description.
    parts.push("## Workspace Overview")
    parts.push(Workspace.summary(input.teamSessionID))
    parts.push("")

    // Only include sections the orchestrator gave access to
    // (workspaceRead still controls visibility, but no messages or reviews)
    for (const section of input.agent.workspaceRead) {
      const content = Workspace.get(input.teamSessionID, section as Workspace.Section)
      if (!content || (Array.isArray(content) && content.length === 0)) continue
      if (typeof content === "object" && Object.keys(content as object).length === 0) continue
      parts.push(`## ${section}`)
      parts.push(typeof content === "string" ? content : JSON.stringify(content, null, 2))
      parts.push("")
    }

    // No messages, no reviews — orchestrator controls all communication
    parts.push("## Communication")
    parts.push("All communication goes through the orchestrator. Use [QUESTION: orchestrator] for any questions.")
    parts.push("")

    return parts.join("\n")
  },

  propagate(input) {
    const updated: string[] = []

    // Apply workspace mutations
    for (const mut of input.mutations) {
      const section = mut.section as Workspace.Section
      if (!input.agent.workspaceWrite.includes(section)) continue

      if (mut.operation === "set") {
        Workspace.set(input.teamSessionID, section, mut.value, input.agent.role)
      } else if (mut.operation === "append") {
        Workspace.append(input.teamSessionID, section, mut.value, input.agent.role)
      }
      updated.push(section)
    }

    // In hierarchical mode, only the orchestrator is notified
    return { updated, notify: ["orchestrator"] }
  },

  summarize(teamSessionID) {
    return Workspace.summary(teamSessionID)
  },
}
