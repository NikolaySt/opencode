/**
 * File System Watcher
 *
 * Watches MEMORY.md, memory.md, the memory/ directory, and configured
 * extra paths for changes. Also watches the worktree root for new file
 * creation (e.g., MEMORY.md being created after plugin start).
 *
 * Sets a dirty flag that triggers lazy re-sync on next search.
 *
 * Instance-scoped: each call to create() returns an independent watcher
 * so multiple projects don't share global state.
 */

import path from "path"
import { existsSync, watch, type FSWatcher } from "fs"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.watcher" })

export type Watcher = ReturnType<typeof create>

export function create() {
  let dirty = false
  let watchers: FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  function isDirty(): boolean {
    return dirty
  }

  function clearDirty() {
    dirty = false
  }

  function start(worktree: string, debounceMs: number, extra?: string[]) {
    stop()

    const targets = [
      path.join(worktree, "MEMORY.md"),
      path.join(worktree, "memory.md"),
      path.join(worktree, "memory"),
      ...(extra ?? []).map((p) => (path.isAbsolute(p) ? p : path.resolve(worktree, p))),
    ]

    for (const target of targets) {
      if (!existsSync(target)) continue
      try {
        const watcher = watch(target, { recursive: true }, () => {
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            dirty = true
            log.info("memory files changed", { target })
          }, debounceMs)
        })
        watcher.on("error", (err) => log.warn("watcher error", { target, error: String(err) }))
        watchers.push(watcher)
        log.info("watching", { target })
      } catch (err) {
        log.warn("failed to watch", { target, error: String(err) })
      }
    }

    // Watch the worktree root for new file creation (e.g., MEMORY.md
    // being created after the plugin starts). We filter events to only
    // trigger on memory-related filenames.
    try {
      const rootWatcher = watch(worktree, (eventType, filename) => {
        if (!filename) return
        const lower = filename.toLowerCase()
        if (lower === "memory.md" || lower === "memory") {
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            dirty = true
            log.info("new memory file detected", { filename })
          }, debounceMs)
        }
      })
      rootWatcher.on("error", (err) => log.warn("root watcher error", { worktree, error: String(err) }))
      watchers.push(rootWatcher)
      log.info("watching worktree root for new memory files", { worktree })
    } catch (err) {
      log.warn("failed to watch worktree root", { error: String(err) })
    }
  }

  function stop() {
    for (const w of watchers) {
      w.close()
    }
    watchers = []
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
    dirty = false
  }

  return { isDirty, clearDirty, start, stop }
}
