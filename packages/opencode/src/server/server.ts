import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { proxy } from "hono/proxy"
import { basicAuth } from "hono/basic-auth"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill/skill"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { Command } from "../command"
import { Global } from "../global"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { lazy } from "../util/lazy"
import { InstanceBootstrap } from "../project/bootstrap"
import { Storage } from "../storage/storage"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { MDNS } from "./mdns"
import { Plugin } from "../plugin"
import { startPluginServices, type PluginServicesHandle } from "../plugin/services"
import { startChannels, type ChannelHandle, type ChannelMessage, type ChannelResponse } from "../plugin/channel"
import { startCronScheduler, type CronHandle } from "../plugin/cron"

import { resolveRoute } from "../plugin/router"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace Server {
  const log = Log.create({ service: "server" })

  let _url: URL | undefined
  let _corsWhitelist: string[] = []

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  const app = new Hono()
  export const App: () => Hono = lazy(
    () =>
      // TODO: Break server.ts into smaller route files to fix type inference
      app
        .onError((err, c) => {
          log.error("failed", {
            error: err,
          })
          if (err instanceof NamedError) {
            let status: ContentfulStatusCode
            if (err instanceof Storage.NotFoundError) status = 404
            else if (err instanceof Provider.ModelNotFoundError) status = 400
            else if (err.name.startsWith("Worktree")) status = 400
            else status = 500
            return c.json(err.toObject(), { status })
          }
          if (err instanceof HTTPException) return err.getResponse()
          const message = err instanceof Error && err.stack ? err.stack : err.toString()
          return c.json(new NamedError.Unknown({ message }).toObject(), {
            status: 500,
          })
        })
        .use((c, next) => {
          // Allow CORS preflight requests to succeed without auth.
          // Browser clients sending Authorization headers will preflight with OPTIONS.
          if (c.req.method === "OPTIONS") return next()
          const password = Flag.OPENCODE_SERVER_PASSWORD
          if (!password) return next()
          const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
          return basicAuth({ username, password })(c, next)
        })
        .use(async (c, next) => {
          const skipLogging = c.req.path === "/log"
          if (!skipLogging) {
            log.info("request", {
              method: c.req.method,
              path: c.req.path,
            })
          }
          const timer = log.time("request", {
            method: c.req.method,
            path: c.req.path,
          })
          await next()
          if (!skipLogging) {
            timer.stop()
          }
        })
        .use(
          cors({
            origin(input) {
              if (!input) return

              if (input.startsWith("http://localhost:")) return input
              if (input.startsWith("http://127.0.0.1:")) return input
              if (
                input === "tauri://localhost" ||
                input === "http://tauri.localhost" ||
                input === "https://tauri.localhost"
              )
                return input

              // *.opencode.ai (https only, adjust if needed)
              if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
                return input
              }
              if (_corsWhitelist.includes(input)) {
                return input
              }

              return
            },
          }),
        )
        .route("/global", GlobalRoutes())
        .put(
          "/auth/:providerID",
          describeRoute({
            summary: "Set auth credentials",
            description: "Set authentication credentials",
            operationId: "auth.set",
            responses: {
              200: {
                description: "Successfully set authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          validator("json", Auth.Info),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const info = c.req.valid("json")
            await Auth.set(providerID, info)
            return c.json(true)
          },
        )
        .delete(
          "/auth/:providerID",
          describeRoute({
            summary: "Remove auth credentials",
            description: "Remove authentication credentials",
            operationId: "auth.remove",
            responses: {
              200: {
                description: "Successfully removed authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            await Auth.remove(providerID)
            return c.json(true)
          },
        )
        .use(async (c, next) => {
          if (c.req.path === "/log") return next()
          const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
          const directory = (() => {
            try {
              return decodeURIComponent(raw)
            } catch {
              return raw
            }
          })()
          return Instance.provide({
            directory,
            init: InstanceBootstrap,
            async fn() {
              return next()
            },
          })
        })
        .get(
          "/doc",
          openAPIRouteHandler(app, {
            documentation: {
              info: {
                title: "opencode",
                version: "0.0.3",
                description: "opencode api",
              },
              openapi: "3.1.1",
            },
          }),
        )
        .use(validator("query", z.object({ directory: z.string().optional() })))
        .route("/project", ProjectRoutes())
        .route("/pty", PtyRoutes())
        .route("/config", ConfigRoutes())
        .route("/experimental", ExperimentalRoutes())
        .route("/session", SessionRoutes())
        .route("/permission", PermissionRoutes())
        .route("/question", QuestionRoutes())
        .route("/provider", ProviderRoutes())
        .route("/", FileRoutes())
        .route("/mcp", McpRoutes())
        .route("/tui", TuiRoutes())
        .post(
          "/instance/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
            operationId: "instance.dispose",
            responses: {
              200: {
                description: "Instance disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.dispose()
            return c.json(true)
          },
        )
        .get(
          "/path",
          describeRoute({
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
            operationId: "path.get",
            responses: {
              200: {
                description: "Path",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          home: z.string(),
                          state: z.string(),
                          config: z.string(),
                          worktree: z.string(),
                          directory: z.string(),
                        })
                        .meta({
                          ref: "Path",
                        }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({
              home: Global.Path.home,
              state: Global.Path.state,
              config: Global.Path.config,
              worktree: Instance.worktree,
              directory: Instance.directory,
            })
          },
        )
        .get(
          "/vcs",
          describeRoute({
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
            operationId: "vcs.get",
            responses: {
              200: {
                description: "VCS info",
                content: {
                  "application/json": {
                    schema: resolver(Vcs.Info),
                  },
                },
              },
            },
          }),
          async (c) => {
            const branch = await Vcs.branch()
            return c.json({
              branch,
            })
          },
        )
        .get(
          "/command",
          describeRoute({
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
            operationId: "command.list",
            responses: {
              200: {
                description: "List of commands",
                content: {
                  "application/json": {
                    schema: resolver(Command.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const commands = await Command.list()
            return c.json(commands)
          },
        )
        .post(
          "/log",
          describeRoute({
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
            operationId: "app.log",
            responses: {
              200: {
                description: "Log entry written successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "json",
            z.object({
              service: z.string().meta({ description: "Service name for the log entry" }),
              level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
              message: z.string().meta({ description: "Log message" }),
              extra: z
                .record(z.string(), z.any())
                .optional()
                .meta({ description: "Additional metadata for the log entry" }),
            }),
          ),
          async (c) => {
            const { service, level, message, extra } = c.req.valid("json")
            const logger = Log.create({ service })

            switch (level) {
              case "debug":
                logger.debug(message, extra)
                break
              case "info":
                logger.info(message, extra)
                break
              case "error":
                logger.error(message, extra)
                break
              case "warn":
                logger.warn(message, extra)
                break
            }

            return c.json(true)
          },
        )
        .get(
          "/agent",
          describeRoute({
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
            operationId: "app.agents",
            responses: {
              200: {
                description: "List of agents",
                content: {
                  "application/json": {
                    schema: resolver(Agent.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const modes = await Agent.list()
            return c.json(modes)
          },
        )
        .get(
          "/skill",
          describeRoute({
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
            operationId: "app.skills",
            responses: {
              200: {
                description: "List of skills",
                content: {
                  "application/json": {
                    schema: resolver(Skill.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const skills = await Skill.all()
            return c.json(skills)
          },
        )
        .get(
          "/lsp",
          describeRoute({
            summary: "Get LSP status",
            description: "Get LSP server status",
            operationId: "lsp.status",
            responses: {
              200: {
                description: "LSP server status",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await LSP.status())
          },
        )
        .get(
          "/formatter",
          describeRoute({
            summary: "Get formatter status",
            description: "Get formatter status",
            operationId: "formatter.status",
            responses: {
              200: {
                description: "Formatter status",
                content: {
                  "application/json": {
                    schema: resolver(Format.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Format.status())
          },
        )
        .get(
          "/event",
          describeRoute({
            summary: "Subscribe to events",
            description: "Get events",
            operationId: "event.subscribe",
            responses: {
              200: {
                description: "Event stream",
                content: {
                  "text/event-stream": {
                    schema: resolver(BusEvent.payloads()),
                  },
                },
              },
            },
          }),
          async (c) => {
            log.info("event connected")
            return streamSSE(c, async (stream) => {
              stream.writeSSE({
                data: JSON.stringify({
                  type: "server.connected",
                  properties: {},
                }),
              })
              const unsub = Bus.subscribeAll(async (event) => {
                await stream.writeSSE({
                  data: JSON.stringify(event),
                })
                if (event.type === Bus.InstanceDisposed.type) {
                  stream.close()
                }
              })

              // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
              const heartbeat = setInterval(() => {
                stream.writeSSE({
                  data: JSON.stringify({
                    type: "server.heartbeat",
                    properties: {},
                  }),
                })
              }, 30000)

              await new Promise<void>((resolve) => {
                stream.onAbort(() => {
                  clearInterval(heartbeat)
                  unsub()
                  resolve()
                  log.info("event disconnected")
                })
              })
            })
          },
        )
        .post(
          "/rpc/:method",
          describeRoute({
            summary: "Call plugin RPC method",
            description: "Invoke a plugin-registered RPC method by its qualified name.",
            operationId: "rpc.call",
            responses: {
              200: {
                description: "RPC result",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          ok: z.boolean(),
                          result: z.unknown().optional(),
                          error: z.string().optional(),
                        })
                        .meta({ ref: "RpcCallResult" }),
                    ),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              method: z.string(),
            }),
          ),
          validator(
            "json",
            z.object({
              params: z.unknown().optional(),
              sessionID: z.string().optional(),
            }),
          ),
          async (c) => {
            const method = c.req.valid("param").method
            const body = c.req.valid("json")
            const registry = await Plugin.getRegistry().catch(() => null)
            if (!registry) {
              return c.json({ ok: false, error: "plugin system not initialized" })
            }
            const dispatcher = registry.rpcDispatcher()
            const config = await Config.get()
            const result = await dispatcher.call(method, body.params, {
              sessionID: body.sessionID,
              config,
            })
            return c.json(result)
          },
        )
        .get(
          "/rpc",
          describeRoute({
            summary: "List plugin RPC methods",
            description: "List all registered plugin RPC methods.",
            operationId: "rpc.list",
            responses: {
              200: {
                description: "List of RPC methods",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .array(
                          z.object({
                            name: z.string(),
                            pluginId: z.string(),
                            description: z.string().optional(),
                          }),
                        )
                        .meta({ ref: "RpcMethodList" }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            const registry = await Plugin.getRegistry().catch(() => null)
            if (!registry) return c.json([])
            const dispatcher = registry.rpcDispatcher()
            return c.json(dispatcher.list())
          },
        )
        .all("/plugins/*", async (c, next) => {
          // Route to plugin HTTP handlers registered via registerHttpRoute/registerHttpHandler
          const registry = await Plugin.getRegistry().catch(() => null)
          if (!registry) return next()

          // Check registered routes first (exact path match)
          for (const route of registry.httpRoutes) {
            if (c.req.path === route.path) {
              try {
                return await route.handler(c.req.raw)
              } catch (err) {
                log.error("plugin http route error", { path: route.path, plugin: route.pluginId, error: String(err) })
                return c.json({ error: "Plugin handler error" }, { status: 500 })
              }
            }
          }

          // Check generic plugin HTTP handlers
          for (const handler of registry.httpHandlers) {
            try {
              const response = await handler.handler(c.req.raw)
              if (response) return response
            } catch (err) {
              log.error("plugin http handler error", { plugin: handler.pluginId, error: String(err) })
              return c.json({ error: "Plugin handler error" }, { status: 500 })
            }
          }

          return next()
        })
        .all("/*", async (c) => {
          const path = c.req.path

          const response = await proxy(`https://app.opencode.ai${path}`, {
            ...c.req,
            headers: {
              ...c.req.raw.headers,
              host: "app.opencode.ai",
            },
          })
          response.headers.set(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
          )
          return response
        }) as unknown as Hono,
  )

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(App() as Hono, {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  /**
   * Session key → sessionID map for channel conversations.
   * Each unique channel+source combination gets its own session.
   */
  const channelSessions = new Map<string, string>()

  /**
   * Bridge function that delivers inbound channel messages to OpenCode sessions.
   * Uses the agent router (L4) to resolve which agent handles the message,
   * creates or reuses a session, and returns the assistant's response.
   */
  async function channelDeliver(msg: ChannelMessage): Promise<ChannelResponse> {
    // Wrap in Instance.provide() because channel adapters invoke deliver()
    // from their own lifecycle (outside HTTP middleware), and most session/
    // agent APIs require Instance context.
    return Instance.provide({
      directory: process.cwd(),
      init: InstanceBootstrap,
      async fn() {
        const registry = await Plugin.getRegistry()
        const defaultAgent = await Agent.defaultAgent()
        const route = resolveRoute(registry.routes, msg, defaultAgent)

        log.info("channel deliver", {
          channel: msg.channel,
          source: msg.source.id,
          agent: route.agent,
          matchedBy: route.matchedBy,
        })

        // Get or create a session for this channel+source combination
        let sessionID = channelSessions.get(route.sessionKey)
        if (!sessionID) {
          const title = `channel:${msg.channel}:${msg.source.name ?? msg.source.id}`
          const created = await Session.create({ title })
          sessionID = created.id
          channelSessions.set(route.sessionKey, sessionID)
        }

        const result = await SessionPrompt.prompt({
          sessionID,
          agent: route.agent,
          parts: [{ type: "text", text: msg.content }],
        })

        // Extract text from response parts
        const text = result.parts
          .filter((p) => p.type === "text")
          .map((p) => ("text" in p ? (p as any).text : ""))
          .join("\n")

        return {
          content: text || "(no response)",
          replyTo: msg.threadID,
        }
      },
    })
  }

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }) {
    _corsWhitelist = opts.cors ?? []

    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: App().fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    // Fire typed server.start hook and start plugin services, channels, and cron.
    // Wrapped in Instance.provide() because these detached promise chains run
    // outside the per-request middleware, so Instance context must be established
    // explicitly for Plugin.getRegistry() / Plugin.getHookRunner() to work.
    const pluginStartup = Instance.provide({
      directory: process.cwd(),
      init: InstanceBootstrap,
      fn: async () => {
        const [registry, runner, config] = await Promise.all([
          Plugin.getRegistry(),
          Plugin.getHookRunner(),
          Config.get(),
        ])

        runner.runServerStart({ port: server.port }).catch(() => {})

        const services = await startPluginServices({ registry, config }).catch((err) => {
          log.error("failed to start plugin services", { error: String(err) })
          return undefined
        })

        let channels: ChannelHandle | undefined
        if (registry.channels.length > 0) {
          try {
            const handle = startChannels({
              channels: registry.channels,
              config,
              deliver: channelDeliver,
            })
            await handle.ready
            channels = handle
          } catch (err) {
            log.error("failed to start channels", { error: String(err) })
          }
        }

        let cron: CronHandle | undefined
        if (registry.cronJobs.length > 0) {
          try {
            cron = startCronScheduler({
              jobs: registry.cronJobs,
              config,
              publish: (pluginId, topic, payload) => registry.bus.publish(pluginId, topic, payload),
            })
          } catch (err) {
            log.error("failed to start cron scheduler", { error: String(err) })
          }
        }

        return { services, channels, cron }
      },
    }).catch((err) => {
      log.error("failed to initialize plugin subsystems", { error: String(err) })
      return undefined as { services?: PluginServicesHandle; channels?: ChannelHandle; cron?: CronHandle } | undefined
    })

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      // Wait for plugin subsystems to finish starting, then stop them
      const result = await pluginStartup
      if (result) {
        if (result.cron) await result.cron.stop()
        if (result.channels) await result.channels.stop().catch(() => {})
        if (result.services) await result.services.stop().catch(() => {})
      }
      // Fire typed server.stop hook
      await Instance.provide({
        directory: process.cwd(),
        init: InstanceBootstrap,
        fn: async () => {
          await Plugin.getHookRunner()
            .then((runner) => runner.runServerStop({ port: server.port }))
            .catch(() => {})
        },
      }).catch(() => {})
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
