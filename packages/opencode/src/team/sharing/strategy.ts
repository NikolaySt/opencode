import { Roster } from "../roster"
import { Workspace } from "../workspace"
import { TeamMessage } from "../message"

/**
 * SharingStrategy defines how context is built for agents and how
 * their outputs are propagated to the workspace and other agents.
 *
 * Three implementations are provided:
 * - Selective: agent sees own workspace slice + summary + relevant messages (default)
 * - Hierarchical: agent sees only what the orchestrator included in its assignment
 * - Broadcast: agent sees the full workspace (truncated if needed)
 */
export interface SharingStrategy {
  readonly name: "selective" | "hierarchical" | "broadcast"

  /**
   * Build the context string that will be injected into an agent's prompt.
   * Controls what the agent can "see" about the team's shared state.
   */
  buildContext(input: { agent: Roster.Info; teamSessionID: string; teamGoal: string; phase: string }): string

  /**
   * After an agent produces output, propagate relevant updates to
   * the workspace and determine which agents should be notified.
   */
  propagate(input: {
    agent: Roster.Info
    teamSessionID: string
    output: string
    mutations: TeamMessage.Mutation[]
  }): PropagationResult

  /**
   * Generate a summary of the workspace state, potentially using
   * different levels of detail depending on the strategy.
   */
  summarize(teamSessionID: string): string
}

export interface PropagationResult {
  /** Workspace sections that were updated */
  updated: string[]
  /** Roles that should be notified of the changes */
  notify: string[]
}

/** Resolve a strategy name to its implementation */
export async function resolve(name: "selective" | "hierarchical" | "broadcast"): Promise<SharingStrategy> {
  switch (name) {
    case "selective": {
      const mod = await import("./selective")
      return mod.selective
    }
    case "hierarchical": {
      const mod = await import("./hierarchical")
      return mod.hierarchical
    }
    case "broadcast": {
      const mod = await import("./broadcast")
      return mod.broadcast
    }
  }
}
