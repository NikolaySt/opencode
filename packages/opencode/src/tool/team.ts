import z from "zod"
import { Tool } from "./tool"
import { Team } from "../team"
import { Question } from "../question"
import DESCRIPTION from "./team.txt"

const parameters = z.object({
  goal: z.string().describe("The task or goal for the team to work on"),
  sharing_strategy: z
    .enum(["selective", "hierarchical", "broadcast"])
    .optional()
    .describe(
      "Context sharing strategy. selective (default): agents see their own slice + summary. hierarchical: orchestrator controls all info flow. broadcast: everyone sees everything.",
    ),
})

export const TeamTool = Tool.define("team", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const activities: Team.Activity[] = []
    const maxActivities = 50

    let currentPhase = "understanding"

    function pushMetadata() {
      ctx.metadata({
        title: activities.at(-1)?.message ?? `Team: ${params.goal.slice(0, 60)}`,
        metadata: {
          goal: params.goal,
          phase: currentPhase,
          sharingStrategy: params.sharing_strategy ?? "selective",
          activities: activities.slice(-maxActivities),
        },
      })
    }

    ctx.metadata({
      title: `Team: ${params.goal.slice(0, 60)}`,
      metadata: {
        goal: params.goal,
        phase: currentPhase,
        sharingStrategy: params.sharing_strategy ?? "selective",
        activities: [],
      },
    })

    const result = await Team.start({
      goal: params.goal,
      sharingStrategy: params.sharing_strategy,
      parentSessionID: ctx.sessionID,
      abort: ctx.abort,
      onEscalate: async (question) => {
        const answers = await Question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              question,
              header: "Team needs input",
              options: [],
            },
          ],
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })
        return answers[0]?.[0] ?? "No answer provided"
      },
      onStatus: (message) => {
        // Extract phase from "Phase: X" messages
        const match = message.match(/^Phase:\s*(\w+)/)
        if (match) currentPhase = match[1]
        pushMetadata()
      },
      onActivity: (entry) => {
        activities.push(entry)
        // Track phase from advance activities (e.g., "Advancing to design: ...")
        if (entry.type === "advance") {
          const match = entry.message.match(/(?:Advancing to|Starting phase:)\s*(\w+)/)
          if (match) currentPhase = match[1]
        }
        pushMetadata()
      },
    })

    const status = Team.status(result.teamSession.id)
    const parts: string[] = []

    parts.push(`## Team Session Complete`)
    parts.push("")
    parts.push(`**Goal**: ${params.goal}`)
    parts.push(`**Final phase**: ${result.teamSession.phase}`)
    parts.push(`**Status**: ${result.teamSession.status}`)
    parts.push(`**Strategy**: ${result.teamSession.sharingStrategy}`)
    parts.push("")

    if (result.summary) {
      parts.push(`## Summary`)
      parts.push(result.summary)
      parts.push("")
    }

    if (status) {
      if (status.roster.length) {
        parts.push(`## Team Roster`)
        for (const agent of status.roster) {
          parts.push(`- **${agent.role}** (${agent.status}) — expertise: ${agent.expertise.join(", ")}`)
        }
        parts.push("")
      }

      // Show files modified by team agents
      if (status.modifiedFiles.length) {
        parts.push(`## Files Modified`)
        for (const file of status.modifiedFiles) {
          parts.push(`- ${file}`)
        }
        parts.push("")
      }

      // Show commands that were run
      if (status.commandsRun.length) {
        parts.push(`## Commands Run`)
        for (const cmd of status.commandsRun) {
          parts.push(`- \`${cmd.command}\` — ${cmd.title}`)
        }
        parts.push("")
      }

      if (status.recentActivity.length) {
        parts.push(`## Recent Activity`)
        for (const msg of status.recentActivity) {
          const to = msg.to ? ` → ${msg.to}` : ""
          parts.push(`- [${msg.type}] ${msg.from}${to}: ${msg.content}`)
        }
        parts.push("")
      }
    }

    return {
      title: `Team: ${params.goal.slice(0, 50)}`,
      output: parts.join("\n"),
      metadata: {
        teamSessionID: result.teamSession.id,
        phase: result.teamSession.phase,
        status: result.teamSession.status,
        sharingStrategy: result.teamSession.sharingStrategy,
      },
    }
  },
})
