import type { SharingStrategy, PropagationResult } from "./strategy"
import { Roster } from "../roster"
import { Workspace } from "../workspace"
import { TeamMessage } from "../message"
import { Review } from "../review"

/**
 * Broadcast sharing: every agent sees the full workspace and
 * all recent messages. All agents are notified of all changes.
 *
 * This is the simplest strategy — maximum visibility, but highest
 * token cost. Best for small teams working on tightly coupled tasks.
 */
export const broadcast: SharingStrategy = {
  name: "broadcast",

  buildContext(input) {
    const parts: string[] = []

    parts.push(`You are part of a team working on: ${input.teamGoal}`)
    parts.push(`Your role: ${input.agent.role}`)
    parts.push(`Current phase: ${input.phase}`)
    parts.push("")

    // Full workspace — every section
    for (const section of Workspace.SECTIONS) {
      const content = Workspace.get(input.teamSessionID, section)
      if (!content || (Array.isArray(content) && content.length === 0)) continue
      if (typeof content === "object" && Object.keys(content as object).length === 0) continue
      parts.push(`## ${section}`)
      parts.push(typeof content === "string" ? content : JSON.stringify(content, null, 2))
      parts.push("")
    }

    // All recent messages (not just this agent's)
    const messages = TeamMessage.recent(input.teamSessionID, 20)
    if (messages.length) {
      parts.push("## All Recent Team Messages")
      for (const m of messages) {
        const to = m.toRole ? ` -> ${m.toRole}` : " -> team"
        parts.push(`[${m.type}] ${m.fromRole}${to}: ${m.content.slice(0, 200)}`)
      }
      parts.push("")
    }

    // All active reviews
    const reviews = Review.listActive(input.teamSessionID)
    if (reviews.length) {
      parts.push("## Active Reviews")
      for (const r of reviews) {
        parts.push(`- Review ${r.id}: ${r.authorRole} -> ${r.reviewerRole} (round ${r.round}, ${r.status})`)
      }
      parts.push("")
    }

    // Team roster
    const roster = Roster.list(input.teamSessionID)
    if (roster.length) {
      parts.push("## Team Roster")
      for (const a of roster) {
        parts.push(`- ${a.role} (${a.status}) -- expertise: ${a.expertise.join(", ")}`)
      }
      parts.push("")
    }

    return parts.join("\n")
  },

  propagate(input) {
    const updated: string[] = []

    // Apply workspace mutations (no write permission check in broadcast)
    for (const mut of input.mutations) {
      const section = mut.section as Workspace.Section
      if (mut.operation === "set") {
        Workspace.set(input.teamSessionID, section, mut.value, input.agent.role)
      } else if (mut.operation === "append") {
        Workspace.append(input.teamSessionID, section, mut.value, input.agent.role)
      }
      updated.push(section)
    }

    // Notify everyone
    const roster = Roster.list(input.teamSessionID)
    const notify = roster.filter((a) => a.role !== input.agent.role).map((a) => a.role)
    return { updated, notify }
  },

  summarize(teamSessionID) {
    // In broadcast mode, the summary is the full workspace (no need for a separate summary)
    return Workspace.summary(teamSessionID)
  },
}
