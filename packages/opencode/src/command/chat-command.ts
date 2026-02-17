/**
 * Chat Command Registry
 *
 * Manages /commands in chat that bypass the LLM agent.
 * Plugin commands are processed before agent invocation.
 *
 * Features:
 * - Reserved command names (can't override builtins)
 * - Validation (must start with letter, alphanumeric)
 * - Arg sanitization (max 4096 chars, strip control chars)
 * - Registry locking during execution
 */

import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import type { PluginChatCommandDefinition, PluginChatCommandContext, PluginChatCommandResult } from "../plugin/registry"

const log = Log.create({ service: "chat-command" })

type RegisteredCommand = PluginChatCommandDefinition & {
  pluginId: string
}

const commands: Map<string, RegisteredCommand> = new Map()
let locked = false

const MAX_ARGS_LENGTH = 4096

/**
 * Reserved command names that plugins cannot override.
 */
const RESERVED = new Set([
  "help",
  "clear",
  "compact",
  "export",
  "share",
  "model",
  "agent",
  "undo",
  "redo",
  "plan",
  "build",
  "config",
  "status",
])

export function validateCommandName(name: string): string | null {
  const trimmed = name.trim().toLowerCase()
  if (!trimmed) return "Command name cannot be empty"
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores"
  }
  if (RESERVED.has(trimmed)) return `Command name "${trimmed}" is reserved by a built-in command`
  return null
}

export function register(pluginId: string, command: PluginChatCommandDefinition): { ok: boolean; error?: string } {
  if (locked) return { ok: false, error: "Cannot register commands while processing is in progress" }
  if (typeof command.handler !== "function") return { ok: false, error: "Command handler must be a function" }

  const error = validateCommandName(command.name)
  if (error) return { ok: false, error }

  const key = `/${command.name.toLowerCase()}`
  if (commands.has(key)) {
    const existing = commands.get(key)!
    return { ok: false, error: `Command "${command.name}" already registered by plugin "${existing.pluginId}"` }
  }

  // Validate aliases don't collide
  for (const alias of command.aliases ?? []) {
    const aliasError = validateCommandName(alias)
    if (aliasError) return { ok: false, error: `alias "${alias}": ${aliasError}` }
    const aliasKey = `/${alias.toLowerCase()}`
    if (commands.has(aliasKey)) {
      const existing = commands.get(aliasKey)!
      return { ok: false, error: `Alias "${alias}" conflicts with command registered by plugin "${existing.pluginId}"` }
    }
  }

  const registered = { ...command, pluginId }
  commands.set(key, registered)

  // Register aliases pointing to the same command entry
  for (const alias of command.aliases ?? []) {
    commands.set(`/${alias.toLowerCase()}`, registered)
  }

  log.info("registered", { command: key, pluginId })
  return { ok: true }
}

export function clear() {
  commands.clear()
}

function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) return undefined
  if (args.length > MAX_ARGS_LENGTH) args = args.slice(0, MAX_ARGS_LENGTH)
  return args.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
}

export function match(input: string): { command: RegisteredCommand; args?: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null

  const spaceIndex = trimmed.indexOf(" ")
  const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
  const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim()

  const key = name.toLowerCase()
  const command = commands.get(key)
  if (!command) return null
  if (args && !command.acceptsArgs) return null

  return { command, args: args || undefined }
}

export async function execute(
  command: RegisteredCommand,
  ctx: { sessionID: string; args?: string; commandBody: string },
): Promise<PluginChatCommandResult> {
  if (command.requireAuth && !Flag.OPENCODE_SERVER_PASSWORD) {
    log.warn("auth required", { command: command.name })
    return { text: `Command /${command.name} requires server authentication (OPENCODE_SERVER_PASSWORD must be set).` }
  }
  locked = true
  try {
    const result = await command.handler({
      sessionID: ctx.sessionID,
      args: sanitizeArgs(ctx.args),
      commandBody: ctx.commandBody,
    })
    log.info("executed", { command: command.name, pluginId: command.pluginId })
    return result
  } catch (err) {
    log.error("failed", { command: command.name, error: String(err) })
    return { text: "Command failed. Please try again later." }
  } finally {
    locked = false
  }
}

export function list(): Array<{ name: string; description: string; pluginId: string; aliases?: string[] }> {
  const seen = new Set<RegisteredCommand>()
  const result: Array<{ name: string; description: string; pluginId: string; aliases?: string[] }> = []
  for (const cmd of commands.values()) {
    if (seen.has(cmd)) continue
    seen.add(cmd)
    result.push({
      name: cmd.name,
      description: cmd.description,
      pluginId: cmd.pluginId,
      aliases: cmd.aliases,
    })
  }
  return result
}
