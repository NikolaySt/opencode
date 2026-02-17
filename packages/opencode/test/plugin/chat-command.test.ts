import { describe, expect, test, beforeEach } from "bun:test"
import * as ChatCommand from "../../src/command/chat-command"

describe("plugin.chat-command", () => {
  beforeEach(() => {
    ChatCommand.clear()
  })

  describe("validateCommandName", () => {
    test("accepts valid names", () => {
      expect(ChatCommand.validateCommandName("greet")).toBeNull()
      expect(ChatCommand.validateCommandName("my-cmd")).toBeNull()
      expect(ChatCommand.validateCommandName("cmd_2")).toBeNull()
    })

    test("rejects empty name", () => {
      expect(ChatCommand.validateCommandName("")).not.toBeNull()
      expect(ChatCommand.validateCommandName("  ")).not.toBeNull()
    })

    test("rejects names not starting with letter", () => {
      expect(ChatCommand.validateCommandName("123")).not.toBeNull()
      expect(ChatCommand.validateCommandName("-cmd")).not.toBeNull()
    })

    test("rejects reserved names", () => {
      expect(ChatCommand.validateCommandName("help")).toContain("reserved")
      expect(ChatCommand.validateCommandName("clear")).toContain("reserved")
      expect(ChatCommand.validateCommandName("model")).toContain("reserved")
    })
  })

  describe("register", () => {
    test("registers a valid command", () => {
      const result = ChatCommand.register("test-plugin", {
        name: "greet",
        description: "greet the user",
        handler: async () => ({ text: "hello" }),
      })
      expect(result.ok).toBe(true)
    })

    test("rejects duplicate registration", () => {
      ChatCommand.register("p1", {
        name: "greet",
        description: "greet",
        handler: async () => ({ text: "hi" }),
      })
      const result = ChatCommand.register("p2", {
        name: "greet",
        description: "greet again",
        handler: async () => ({ text: "hi" }),
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain("already registered")
    })

    test("rejects reserved command names", () => {
      const result = ChatCommand.register("plugin", {
        name: "help",
        description: "override help",
        handler: async () => ({ text: "nope" }),
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain("reserved")
    })

    test("rejects missing handler", () => {
      const result = ChatCommand.register("plugin", {
        name: "test",
        description: "test",
        handler: null as any,
      })
      expect(result.ok).toBe(false)
    })
  })

  describe("match", () => {
    test("matches registered command", () => {
      ChatCommand.register("p", {
        name: "hello",
        description: "say hello",
        handler: async () => ({ text: "hi" }),
      })
      const result = ChatCommand.match("/hello")
      expect(result).not.toBeNull()
      expect(result!.command.name).toBe("hello")
    })

    test("matches with args", () => {
      ChatCommand.register("p", {
        name: "echo",
        description: "echo",
        acceptsArgs: true,
        handler: async () => ({ text: "" }),
      })
      const result = ChatCommand.match("/echo hello world")
      expect(result).not.toBeNull()
      expect(result!.args).toBe("hello world")
    })

    test("returns null for unregistered command", () => {
      const result = ChatCommand.match("/nonexistent")
      expect(result).toBeNull()
    })

    test("returns null for non-command input", () => {
      expect(ChatCommand.match("hello")).toBeNull()
      expect(ChatCommand.match("")).toBeNull()
    })

    test("rejects args on command that does not accept them", () => {
      ChatCommand.register("p", {
        name: "noargs",
        description: "no args",
        acceptsArgs: false,
        handler: async () => ({ text: "" }),
      })
      const result = ChatCommand.match("/noargs some args")
      expect(result).toBeNull()
    })

    test("is case insensitive", () => {
      ChatCommand.register("p", {
        name: "greet",
        description: "greet",
        handler: async () => ({ text: "hi" }),
      })
      expect(ChatCommand.match("/GREET")).not.toBeNull()
      expect(ChatCommand.match("/Greet")).not.toBeNull()
    })
  })

  describe("execute", () => {
    test("executes handler and returns result", async () => {
      ChatCommand.register("p", {
        name: "ping",
        description: "ping",
        handler: async () => ({ text: "pong" }),
      })
      const matched = ChatCommand.match("/ping")!
      const result = await ChatCommand.execute(matched.command, {
        sessionID: "sess-1",
        commandBody: "/ping",
      })
      expect(result.text).toBe("pong")
    })

    test("handles errors gracefully", async () => {
      ChatCommand.register("p", {
        name: "fail",
        description: "fails",
        handler: async () => {
          throw new Error("oops")
        },
      })
      const matched = ChatCommand.match("/fail")!
      const result = await ChatCommand.execute(matched.command, {
        sessionID: "sess-1",
        commandBody: "/fail",
      })
      expect(result.text).toContain("failed")
    })
  })

  describe("list", () => {
    test("lists registered commands", () => {
      ChatCommand.register("p1", {
        name: "alpha",
        description: "alpha cmd",
        handler: async () => ({ text: "" }),
      })
      ChatCommand.register("p2", {
        name: "beta",
        description: "beta cmd",
        handler: async () => ({ text: "" }),
      })
      const all = ChatCommand.list()
      expect(all.length).toBe(2)
      expect(all.map((c) => c.name).sort()).toEqual(["alpha", "beta"])
    })

    test("clear removes all commands", () => {
      ChatCommand.register("p", {
        name: "temp",
        description: "temp",
        handler: async () => ({ text: "" }),
      })
      expect(ChatCommand.list().length).toBe(1)
      ChatCommand.clear()
      expect(ChatCommand.list().length).toBe(0)
    })
  })
})
