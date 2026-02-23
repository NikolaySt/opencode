/**
 * Team event hooks for the plugin system.
 *
 * Aggregates all team-related bus events into a single
 * module that plugins can subscribe to.
 */

import { Team } from "./index"
import { Orchestrator } from "./orchestrator"
import { Roster } from "./roster"
import { TeamMessage } from "./message"
import { Workspace } from "./workspace"
import { Review } from "./review"

/**
 * All team events available for plugin subscriptions.
 * Plugins can subscribe to these via Bus.subscribe().
 */
export const TeamEvents = {
  // Team session lifecycle
  "team.created": Team.Event.Created,
  "team.updated": Team.Event.Updated,
  "team.completed": Team.Event.Completed,

  // Orchestrator events
  "team.phase_changed": Orchestrator.Event.PhaseChanged,
  "team.decision": Orchestrator.Event.Decision,
  "team.escalated": Orchestrator.Event.Escalated,

  // Agent lifecycle
  "team.agent.spawned": Roster.Event.Spawned,
  "team.agent.retired": Roster.Event.Retired,
  "team.agent.updated": Roster.Event.Updated,

  // Communication
  "team.message": TeamMessage.Event.Sent,

  // Workspace
  "workspace.updated": Workspace.Event.Updated,

  // Review
  "team.review.started": Review.Event.Started,
  "team.review.completed": Review.Event.Completed,
  "team.review.escalated": Review.Event.Escalated,
} as const

export type TeamEventName = keyof typeof TeamEvents
