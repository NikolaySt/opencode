/**
 * Exclusive Plugin Slots
 *
 * Some plugin categories (like "memory") are exclusive - only one
 * plugin of that kind can be active at a time. This module resolves
 * which plugin wins based on config or first-loaded ordering.
 */

import type { PluginKind } from "./types"

/** Slot kinds that are exclusive (only one plugin per kind). Exported for tooling and CLI display. */
export const EXCLUSIVE_SLOTS: PluginKind[] = ["memory"]

export function resolveSlotDecision(params: { id: string; kind?: string; slot?: string; selectedId: string | null }): {
  enabled: boolean
  reason?: string
  selected?: boolean
} {
  if (params.kind !== "memory") return { enabled: true }

  // Explicit slot assignment from config
  if (params.slot && params.slot !== params.id) {
    return { enabled: false, reason: `memory slot assigned to ${params.slot}` }
  }

  // First-loaded wins if no explicit config
  if (!params.slot && params.selectedId && params.selectedId !== params.id) {
    return { enabled: false, reason: `another memory plugin already loaded (${params.selectedId})` }
  }

  return { enabled: true, selected: true }
}
