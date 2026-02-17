import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Config } from "../../config/config"
import { discover } from "../../plugin/discovery"
import { Global } from "../../global"
import { Plugin } from "../../plugin"

export const PluginsCommand = cmd({
  command: "plugins",
  describe: "manage plugins",
  builder: (yargs) => yargs.command(PluginsListCommand).command(PluginsInfoCommand).demandCommand(),
  async handler() {},
})

export const PluginsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list discovered plugins and their status",
  builder: (yargs) =>
    yargs.option("full", {
      describe: "show full registry details (loads all plugins)",
      type: "boolean",
      default: false,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Plugins")

        if (args.full) {
          const registry = await Plugin.getRegistry()
          if (registry.plugins.length === 0) {
            prompts.log.warn("No new-style plugins registered")
            prompts.outro("Done")
            return
          }
          for (const record of registry.plugins) {
            const icon = record.status === "loaded" ? "+" : record.status === "disabled" ? "o" : "x"
            const version = record.version ? ` v${record.version}` : ""
            const status = record.error ? `${record.status}: ${record.error}` : record.status

            prompts.log.info(
              `${icon} ${record.name}${version} ${UI.Style.TEXT_DIM}${status} (${record.origin})\n    ${UI.Style.TEXT_DIM}${record.source}`,
            )
            if (record.toolNames.length > 0) prompts.log.info(`    tools: ${record.toolNames.join(", ")}`)
            if (record.hookCount > 0) prompts.log.info(`    hooks: ${record.hookCount}`)
            if (record.chatCommands.length > 0) prompts.log.info(`    commands: /${record.chatCommands.join(", /")}`)
            if (record.cliCommands.length > 0) prompts.log.info(`    cli: ${record.cliCommands.join(", ")}`)
            if (record.services.length > 0) prompts.log.info(`    services: ${record.services.join(", ")}`)
            if (record.httpHandlers > 0) prompts.log.info(`    http handlers: ${record.httpHandlers}`)
          }

          if (registry.diagnostics.length > 0) {
            prompts.log.warn("Diagnostics:")
            for (const diag of registry.diagnostics) {
              const icon = diag.level === "error" ? "x" : "!"
              prompts.log.info(`  ${icon} ${diag.message}${diag.pluginId ? ` (${diag.pluginId})` : ""}`)
            }
          }

          prompts.outro(`${registry.plugins.length} plugin(s) registered`)
          return
        }

        const config = await Config.get()
        const configDirs = await Config.directories()
        const pluginsConfig = config.plugins

        const result = discover({
          workspaceDir: Instance.worktree,
          extraPaths: pluginsConfig?.load?.paths,
          configDirectories: configDirs,
        })

        if (result.candidates.length === 0 && result.diagnostics.length === 0) {
          prompts.log.warn("No plugins found")
          prompts.log.info("Plugins can be added to:")
          prompts.log.info(`  ${Instance.worktree}/.opencode/extensions/`)
          prompts.log.info(`  ${Global.Path.config}/extensions/`)
          prompts.outro("Done")
          return
        }

        const entries = pluginsConfig?.entries ?? {}

        for (const candidate of result.candidates) {
          const entry = entries[candidate.idHint]
          const enabled = entry?.enabled !== false
          const icon = enabled ? "+" : "o"
          const status = enabled ? "discovered" : "disabled"

          const name = candidate.packageName ?? candidate.idHint
          const version = candidate.packageVersion ? ` v${candidate.packageVersion}` : ""
          const origin = `${candidate.origin}`

          prompts.log.info(
            `${icon} ${name}${version} ${UI.Style.TEXT_DIM}${status} (${origin})\n    ${UI.Style.TEXT_DIM}${candidate.source}`,
          )
        }

        if (result.diagnostics.length > 0) {
          prompts.log.warn("Diagnostics:")
          for (const diag of result.diagnostics) {
            const icon = diag.level === "error" ? "x" : "!"
            prompts.log.info(`  ${icon} ${diag.message}${diag.pluginId ? ` (${diag.pluginId})` : ""}`)
          }
        }

        prompts.outro(`${result.candidates.length} plugin(s) discovered`)
      },
    })
  },
})

export const PluginsInfoCommand = cmd({
  command: "info <name>",
  describe: "show details about a discovered plugin",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "plugin id or name",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Plugin Info")

        // Try to get from full registry first
        const registry = await Plugin.getRegistry().catch(() => null)
        if (registry) {
          const record = registry.plugins.find((p) => p.id === args.name || p.name === args.name)
          if (record) {
            prompts.log.info(`ID:          ${record.id}`)
            prompts.log.info(`Name:        ${record.name}`)
            if (record.version) prompts.log.info(`Version:     ${record.version}`)
            if (record.description) prompts.log.info(`Description: ${record.description}`)
            prompts.log.info(`Origin:      ${record.origin}`)
            prompts.log.info(`Source:      ${record.source}`)
            prompts.log.info(`Status:      ${record.status}`)
            prompts.log.info(`Enabled:     ${record.enabled ? "yes" : "no"}`)
            if (record.error) prompts.log.info(`Error:       ${record.error}`)
            if (record.toolNames.length > 0) prompts.log.info(`Tools:       ${record.toolNames.join(", ")}`)
            if (record.hookCount > 0) prompts.log.info(`Hooks:       ${record.hookCount}`)
            if (record.chatCommands.length > 0) prompts.log.info(`Commands:    /${record.chatCommands.join(", /")}`)
            if (record.cliCommands.length > 0) prompts.log.info(`CLI:         ${record.cliCommands.join(", ")}`)
            if (record.services.length > 0) prompts.log.info(`Services:    ${record.services.join(", ")}`)
            if (record.httpHandlers > 0) prompts.log.info(`HTTP:        ${record.httpHandlers} handler(s)`)
            prompts.outro("Done")
            return
          }
        }

        // Fall back to discovery
        const config = await Config.get()
        const configDirs = await Config.directories()
        const pluginsConfig = config.plugins

        const result = discover({
          workspaceDir: Instance.worktree,
          extraPaths: pluginsConfig?.load?.paths,
          configDirectories: configDirs,
        })

        const candidate = result.candidates.find((c) => c.idHint === args.name || c.packageName === args.name)

        if (!candidate) {
          prompts.log.error(`Plugin not found: ${args.name}`)
          prompts.outro("Done")
          return
        }

        const entry = pluginsConfig?.entries?.[candidate.idHint]

        prompts.log.info(`ID:          ${candidate.idHint}`)
        if (candidate.packageName) prompts.log.info(`Package:     ${candidate.packageName}`)
        if (candidate.packageVersion) prompts.log.info(`Version:     ${candidate.packageVersion}`)
        if (candidate.packageDescription) prompts.log.info(`Description: ${candidate.packageDescription}`)
        prompts.log.info(`Origin:      ${candidate.origin}`)
        prompts.log.info(`Source:      ${candidate.source}`)
        prompts.log.info(`Root:        ${candidate.rootDir}`)
        prompts.log.info(`Enabled:     ${entry?.enabled !== false ? "yes" : "no"}`)
        if (entry?.config) {
          prompts.log.info(`Config:      ${JSON.stringify(entry.config, null, 2)}`)
        }

        prompts.outro("Done")
      },
    })
  },
})
