/**
 * Plugin system types.
 *
 * Re-exports manifest types and defines internal-only types used
 * by the plugin registry, discovery, and hook systems.
 */

export type {
  PluginManifest,
  PluginConfigUiHint,
  PluginKind,
  PluginOrigin,
  PluginDiagnostic,
  ToolDefinition,
  ToolContext,
  Hooks,
  PluginInput,
  ProviderContext,
} from "@opencode-ai/plugin"

export type { Plugin as PluginInstance } from "@opencode-ai/plugin"
