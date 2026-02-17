import { z } from "zod"

export const PluginConfigUiHint = z.object({
  label: z.string().optional(),
  help: z.string().optional(),
  advanced: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  placeholder: z.string().optional(),
})

export type PluginConfigUiHint = z.infer<typeof PluginConfigUiHint>

export const PluginKind = z.enum(["memory", "auth", "provider"])
export type PluginKind = z.infer<typeof PluginKind>

export const PluginManifest = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  kind: PluginKind.optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  uiHints: z.record(z.string(), PluginConfigUiHint).optional(),
})

export type PluginManifest = z.infer<typeof PluginManifest>

export type PluginOrigin = "config" | "workspace" | "global" | "bundled"

export type PluginDiagnostic = {
  level: "warn" | "error"
  message: string
  pluginId?: string
  source?: string
}
