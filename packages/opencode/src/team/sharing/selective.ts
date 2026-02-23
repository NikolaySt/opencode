import type { SharingStrategy, PropagationResult } from "./strategy"
import { Roster } from "../roster"
import { Workspace } from "../workspace"
import { TeamMessage } from "../message"
import { Review } from "../review"

/**
 * Selective sharing: each agent sees their own workspace slice
 * (based on workspaceRead permissions), a summary of the full
 * workspace, and messages addressed to them or from collaborators.
 *
 * This is the default strategy — balances context quality with token cost.
 */
export const selective: SharingStrategy = {
  name: "selective",

  buildContext(input) {
    const parts: string[] = []

    parts.push(`You are part of a team working on: ${input.teamGoal}`)
    parts.push(`Your role: ${input.agent.role}`)
    parts.push(`Current phase: ${input.phase}`)
    parts.push("")

    // Workspace summary (everyone gets this)
    parts.push("## Workspace Summary")
    parts.push(Workspace.summary(input.teamSessionID))
    parts.push("")

    // Detailed sections the agent has read access to
    for (const section of input.agent.workspaceRead) {
      const content = Workspace.get(input.teamSessionID, section as Workspace.Section)
      if (!content || (Array.isArray(content) && content.length === 0)) continue
      if (typeof content === "object" && Object.keys(content as object).length === 0) continue
      parts.push(`## ${section} (detail)`)
      parts.push(typeof content === "string" ? content : JSON.stringify(content, null, 2))
      parts.push("")
    }

    // Messages relevant to this agent
    const messages = TeamMessage.forRole(input.teamSessionID, input.agent.role, 10)
    if (messages.length) {
      parts.push("## Recent Messages for You")
      for (const m of messages) {
        const to = m.toRole ? ` -> ${m.toRole}` : " -> team"
        parts.push(`[${m.type}] ${m.fromRole}${to}: ${m.content.slice(0, 200)}`)
      }
      parts.push("")
    }

    // Active reviews involving this agent
    const reviews = Review.listActive(input.teamSessionID)
    const relevant = reviews.filter((r) => r.authorRole === input.agent.role || r.reviewerRole === input.agent.role)
    if (relevant.length) {
      parts.push("## Your Active Reviews")
      for (const r of relevant) {
        const yourRole = r.authorRole === input.agent.role ? "author" : "reviewer"
        parts.push(`- Review ${r.id}: you are ${yourRole}, round ${r.round}, status ${r.status}`)
      }
      parts.push("")
    }

    // Decisions (everyone should know the decisions)
    const decisions = Workspace.get(input.teamSessionID, "decisions") as Workspace.Decision[] | undefined
    if (decisions?.length) {
      parts.push("## Team Decisions")
      for (const d of decisions) {
        parts.push(`- [${d.status}] ${d.description} (by ${d.made_by}): ${d.rationale}`)
      }
      parts.push("")
    }

    return parts.join("\n")
  },

  propagate(input) {
    const updated: string[] = []
    const notify: string[] = []

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

    // Notify collaborators
    for (const role of input.agent.relationships.collaborates_with) {
      notify.push(role)
    }

    // Notify reviewer if this agent is reviewed by someone
    for (const role of input.agent.relationships.reviewed_by) {
      notify.push(role)
    }

    return { updated, notify: [...new Set(notify)] }
  },

  summarize(teamSessionID) {
    return Workspace.summary(teamSessionID)
  },
}
