import path from "path"
import { existsSync, readdirSync, statSync, type Dirent } from "fs"
import { Config } from "../config/config"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import type { PluginOrigin, PluginDiagnostic } from "./types"

const log = Log.create({ service: "plugin.discovery" })

const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"])
const INDEX_CANDIDATES = ["index.ts", "index.js", "index.mjs", "index.cjs"]

export type PluginCandidate = {
  idHint: string
  source: string
  rootDir: string
  origin: PluginOrigin
  workspaceDir?: string
  packageName?: string
  packageVersion?: string
  packageDescription?: string
}

export type PluginDiscoveryResult = {
  candidates: PluginCandidate[]
  diagnostics: PluginDiagnostic[]
}

function isExtensionFile(filePath: string): boolean {
  const ext = path.extname(filePath)
  if (!EXTENSION_EXTS.has(ext)) return false
  return !filePath.endsWith(".d.ts")
}

function readPackageManifest(dir: string): Record<string, unknown> | null {
  const manifestPath = path.join(dir, "package.json")
  if (!existsSync(manifestPath)) return null
  try {
    const raw = require(manifestPath)
    return raw as Record<string, unknown>
  } catch {
    return null
  }
}

function resolvePackageExtensions(manifest: Record<string, unknown>): string[] {
  const meta = manifest.opencode as Record<string, unknown> | undefined
  const raw = meta?.extensions
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
}

function deriveIdHint(params: { filePath: string; packageName?: string; hasMultipleExtensions: boolean }): string {
  const base = path.basename(params.filePath, path.extname(params.filePath))
  const raw = params.packageName?.trim()
  if (!raw) return base
  const unscoped = raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw
  if (!params.hasMultipleExtensions) return unscoped
  return `${unscoped}/${base}`
}

function addCandidate(params: {
  candidates: PluginCandidate[]
  seen: Set<string>
  idHint: string
  source: string
  rootDir: string
  origin: PluginOrigin
  workspaceDir?: string
  manifest?: Record<string, unknown> | null
}) {
  const resolved = path.resolve(params.source)
  if (params.seen.has(resolved)) return
  params.seen.add(resolved)
  const manifest = params.manifest ?? null
  params.candidates.push({
    idHint: params.idHint,
    source: resolved,
    rootDir: path.resolve(params.rootDir),
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    packageName: (manifest?.name as string)?.trim() || undefined,
    packageVersion: (manifest?.version as string)?.trim() || undefined,
    packageDescription: (manifest?.description as string)?.trim() || undefined,
  })
}

function discoverInDirectory(params: {
  dir: string
  origin: PluginOrigin
  workspaceDir?: string
  candidates: PluginCandidate[]
  diagnostics: PluginDiagnostic[]
  seen: Set<string>
}) {
  if (!existsSync(params.dir)) return

  let entries: Dirent[] = []
  try {
    entries = readdirSync(params.dir, { withFileTypes: true })
  } catch (err) {
    params.diagnostics.push({
      level: "warn",
      message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
      source: params.dir,
    })
    return
  }

  for (const entry of entries) {
    const full = path.join(params.dir, entry.name)

    if (entry.isFile()) {
      if (!isExtensionFile(full)) continue
      addCandidate({
        candidates: params.candidates,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: full,
        rootDir: path.dirname(full),
        origin: params.origin,
        workspaceDir: params.workspaceDir,
      })
      continue
    }

    if (!entry.isDirectory()) continue

    const manifest = readPackageManifest(full)
    const extensions = manifest ? resolvePackageExtensions(manifest) : []

    if (extensions.length > 0) {
      for (const ext of extensions) {
        const resolved = path.resolve(full, ext)
        addCandidate({
          candidates: params.candidates,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            packageName: manifest?.name as string | undefined,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          rootDir: full,
          origin: params.origin,
          workspaceDir: params.workspaceDir,
          manifest,
        })
      }
      continue
    }

    const indexFile = INDEX_CANDIDATES.map((c) => path.join(full, c)).find((c) => existsSync(c))
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        seen: params.seen,
        idHint: entry.name,
        source: indexFile,
        rootDir: full,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        manifest,
      })
    }
  }
}

function discoverFromPath(params: {
  rawPath: string
  origin: PluginOrigin
  workspaceDir?: string
  candidates: PluginCandidate[]
  diagnostics: PluginDiagnostic[]
  seen: Set<string>
}) {
  const resolved = path.resolve(params.rawPath)
  if (!existsSync(resolved)) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    })
    return
  }

  try {
    const stat = statSync(resolved)
    if (stat.isFile()) {
      if (!isExtensionFile(resolved)) {
        params.diagnostics.push({
          level: "error",
          message: `plugin path is not a supported file: ${resolved}`,
          source: resolved,
        })
        return
      }
      addCandidate({
        candidates: params.candidates,
        seen: params.seen,
        idHint: path.basename(resolved, path.extname(resolved)),
        source: resolved,
        rootDir: path.dirname(resolved),
        origin: params.origin,
        workspaceDir: params.workspaceDir,
      })
      return
    }

    if (stat.isDirectory()) {
      const manifest = readPackageManifest(resolved)
      const extensions = manifest ? resolvePackageExtensions(manifest) : []

      if (extensions.length > 0) {
        for (const ext of extensions) {
          const source = path.resolve(resolved, ext)
          addCandidate({
            candidates: params.candidates,
            seen: params.seen,
            idHint: deriveIdHint({
              filePath: source,
              packageName: manifest?.name as string | undefined,
              hasMultipleExtensions: extensions.length > 1,
            }),
            source,
            rootDir: resolved,
            origin: params.origin,
            workspaceDir: params.workspaceDir,
            manifest,
          })
        }
        return
      }

      const indexFile = INDEX_CANDIDATES.map((c) => path.join(resolved, c)).find((c) => existsSync(c))

      if (indexFile && isExtensionFile(indexFile)) {
        addCandidate({
          candidates: params.candidates,
          seen: params.seen,
          idHint: path.basename(resolved),
          source: indexFile,
          rootDir: resolved,
          origin: params.origin,
          workspaceDir: params.workspaceDir,
          manifest,
        })
        return
      }

      discoverInDirectory({
        dir: resolved,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
      })
    }
  } catch (err) {
    params.diagnostics.push({
      level: "error",
      message: `failed to stat plugin path: ${resolved} (${String(err)})`,
      source: resolved,
    })
  }
}

/**
 * Discover plugins from all 4 tiers:
 * 1. config - explicit paths from plugins.load.paths
 * 2. workspace - .opencode/extensions/ and .opencode/plugins/ in project
 * 3. global - ~/.config/opencode/extensions/ and ~/.config/opencode/plugins/
 * 4. bundled - built-in (future)
 */
export function discover(params: {
  workspaceDir?: string
  extraPaths?: string[]
  configDirectories?: string[]
}): PluginDiscoveryResult {
  const candidates: PluginCandidate[] = []
  const diagnostics: PluginDiagnostic[] = []
  const seen = new Set<string>()

  // 1. Config-specified extra paths (highest priority)
  for (const extra of params.extraPaths ?? []) {
    if (typeof extra !== "string") continue
    const trimmed = extra.trim()
    if (!trimmed) continue
    discoverFromPath({
      rawPath: trimmed,
      origin: "config",
      workspaceDir: params.workspaceDir,
      candidates,
      diagnostics,
      seen,
    })
  }

  // 2. Workspace - scan .opencode/extensions/ and .opencode/plugins/ in config directories
  const dirs = params.configDirectories ?? []
  for (const dir of dirs) {
    for (const sub of ["extensions", "plugins"]) {
      const extDir = path.join(dir, sub)
      discoverInDirectory({
        dir: extDir,
        origin: "workspace",
        workspaceDir: params.workspaceDir,
        candidates,
        diagnostics,
        seen,
      })
    }
  }

  // 3. Global - scan ~/.config/opencode/extensions/ and ~/.config/opencode/plugins/
  for (const sub of ["extensions", "plugins"]) {
    const globalDir = path.join(Global.Path.config, sub)
    discoverInDirectory({
      dir: globalDir,
      origin: "global",
      candidates,
      diagnostics,
      seen,
    })
  }

  // 4. Bundled - none for now (future use)

  log.info("discovery complete", {
    candidates: candidates.length,
    diagnostics: diagnostics.length,
  })

  return { candidates, diagnostics }
}
