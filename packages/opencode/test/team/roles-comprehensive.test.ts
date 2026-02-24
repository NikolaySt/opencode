import { describe, expect, test, afterAll } from "bun:test"
import { Roles } from "../../src/team/roles"

describe("team.roles.get", () => {
  test("returns architect template", () => {
    const t = Roles.get("architect")
    expect(t).toBeDefined()
    expect(t!.role).toBe("architect")
    expect(t!.prompt.length).toBeGreaterThan(0)
    expect(t!.expertise).toContain("system design")
    expect(t!.workspaceRead).toContain("goal")
    expect(t!.workspaceWrite).toContain("plan")
  })

  test("returns developer template", () => {
    const t = Roles.get("developer")
    expect(t).toBeDefined()
    expect(t!.expertise).toContain("implementation")
    expect(t!.workspaceWrite).toContain("artifacts")
    expect(t!.workspaceWrite).toContain("tasks")
  })

  test("returns qa template with signals", () => {
    const t = Roles.get("qa")
    expect(t).toBeDefined()
    expect(t!.signals.length).toBeGreaterThan(0)
    expect(t!.signals).toContain("test")
    expect(t!.signals).toContain("coverage")
    expect(t!.signals).toContain("edge case")
  })

  test("returns security-reviewer template with signals", () => {
    const t = Roles.get("security-reviewer")
    expect(t).toBeDefined()
    expect(t!.signals).toContain("vulnerability")
    expect(t!.signals).toContain("injection")
    expect(t!.signals).toContain("xss")
    expect(t!.signals).toContain("csrf")
    expect(t!.signals).toContain("authentication")
    expect(t!.signals).toContain("authorization")
    expect(t!.signals).toContain("encryption")
    expect(t!.signals).toContain("password")
    expect(t!.signals).toContain("token")
    expect(t!.signals).toContain("credential")
  })

  test("returns performance-specialist template with signals", () => {
    const t = Roles.get("performance-specialist")
    expect(t).toBeDefined()
    expect(t!.signals).toContain("performance")
    expect(t!.signals).toContain("latency")
    expect(t!.signals).toContain("bottleneck")
    expect(t!.signals).toContain("cache")
    expect(t!.signals).toContain("scalability")
  })

  test("returns database-specialist template with signals", () => {
    const t = Roles.get("database-specialist")
    expect(t).toBeDefined()
    expect(t!.signals).toContain("database")
    expect(t!.signals).toContain("migration")
    expect(t!.signals).toContain("schema")
    expect(t!.signals).toContain("index")
    expect(t!.signals).toContain("sql")
  })

  test("returns devops template with signals", () => {
    const t = Roles.get("devops")
    expect(t).toBeDefined()
    expect(t!.signals).toContain("deploy")
    expect(t!.signals).toContain("docker")
    expect(t!.signals).toContain("kubernetes")
    expect(t!.signals).toContain("monitoring")
  })

  test("returns ux-reviewer template with signals", () => {
    const t = Roles.get("ux-reviewer")
    expect(t).toBeDefined()
    expect(t!.signals).toContain("accessibility")
    expect(t!.signals).toContain("wcag")
    expect(t!.signals).toContain("usability")
  })

  test("returns documentation-writer template with signals", () => {
    const t = Roles.get("documentation-writer")
    expect(t).toBeDefined()
    expect(t!.signals).toContain("documentation")
    expect(t!.signals).toContain("readme")
    expect(t!.signals).toContain("api docs")
  })

  test("returns undefined for unknown role", () => {
    expect(Roles.get("unknown-role")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(Roles.get("")).toBeUndefined()
  })
})

describe("team.roles.list", () => {
  test("returns all 9+ built-in templates", () => {
    const all = Roles.list()
    expect(all.length).toBeGreaterThanOrEqual(9)
    const names = all.map((t) => t.role)
    expect(names).toContain("architect")
    expect(names).toContain("developer")
    expect(names).toContain("qa")
    expect(names).toContain("security-reviewer")
    expect(names).toContain("performance-specialist")
    expect(names).toContain("database-specialist")
    expect(names).toContain("devops")
    expect(names).toContain("ux-reviewer")
    expect(names).toContain("documentation-writer")
  })

  test("all templates have non-empty prompts", () => {
    for (const t of Roles.list()) {
      expect(t.prompt.length).toBeGreaterThan(50)
    }
  })

  test("all templates have description", () => {
    for (const t of Roles.list()) {
      expect(t.description.length).toBeGreaterThan(5)
    }
  })

  test("all templates have non-empty workspaceRead", () => {
    for (const t of Roles.list()) {
      expect(t.workspaceRead.length).toBeGreaterThan(0)
      expect(t.workspaceRead).toContain("goal")
    }
  })

  test("all templates have expertise array", () => {
    for (const t of Roles.list()) {
      expect(t.expertise.length).toBeGreaterThan(0)
    }
  })

  test("architect and developer have no signals (they are core roles)", () => {
    const arch = Roles.get("architect")!
    const dev = Roles.get("developer")!
    expect(arch.signals).toEqual([])
    expect(dev.signals).toEqual([])
  })

  test("all specialist roles have signals", () => {
    const specialists = [
      "qa",
      "security-reviewer",
      "performance-specialist",
      "database-specialist",
      "devops",
      "ux-reviewer",
      "documentation-writer",
    ]
    for (const name of specialists) {
      const t = Roles.get(name)!
      expect(t.signals.length).toBeGreaterThan(0)
    }
  })
})

describe("team.roles.register", () => {
  test("adds a new custom role", () => {
    Roles.register({
      role: "test-custom-role",
      prompt: "You are a custom role for testing.",
      description: "Custom testing role",
      expertise: ["custom"],
      workspaceRead: ["goal"],
      workspaceWrite: [],
      signals: ["custom-signal"],
    })

    const t = Roles.get("test-custom-role")
    expect(t).toBeDefined()
    expect(t!.role).toBe("test-custom-role")
    expect(t!.signals).toEqual(["custom-signal"])
  })

  test("overwrites existing role", () => {
    Roles.register({
      role: "test-overwrite",
      prompt: "Original",
      description: "Original desc",
      expertise: [],
      workspaceRead: [],
      workspaceWrite: [],
      signals: [],
    })

    Roles.register({
      role: "test-overwrite",
      prompt: "Updated",
      description: "Updated desc",
      expertise: ["new"],
      workspaceRead: ["goal"],
      workspaceWrite: [],
      signals: ["new-signal"],
    })

    const t = Roles.get("test-overwrite")
    expect(t!.prompt).toBe("Updated")
    expect(t!.expertise).toEqual(["new"])
  })
})

describe("team.roles.match", () => {
  test("matches security-reviewer for security text", () => {
    const matches = Roles.match("There is a SQL injection vulnerability. The authentication uses raw queries.", [])
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].role).toBe("security-reviewer")
    expect(matches[0].score).toBeGreaterThanOrEqual(2)
    expect(matches[0].signals).toContain("injection")
    expect(matches[0].signals).toContain("authentication")
  })

  test("matches performance-specialist for performance text", () => {
    const matches = Roles.match(
      "The API is slow with high latency. We need to optimize the bottleneck and add caching.",
      [],
    )
    const perf = matches.find((m) => m.role === "performance-specialist")
    expect(perf).toBeDefined()
    expect(perf!.score).toBeGreaterThanOrEqual(3)
  })

  test("matches database-specialist for DB text", () => {
    const matches = Roles.match("We need a database migration for the new schema with proper indexing.", [])
    const db = matches.find((m) => m.role === "database-specialist")
    expect(db).toBeDefined()
    expect(db!.signals).toContain("database")
    expect(db!.signals).toContain("migration")
    expect(db!.signals).toContain("schema")
  })

  test("matches devops for deployment text", () => {
    const matches = Roles.match("Need to set up Docker deployment with Kubernetes and monitoring.", [])
    const devops = matches.find((m) => m.role === "devops")
    expect(devops).toBeDefined()
    expect(devops!.score).toBeGreaterThanOrEqual(3)
  })

  test("matches ux-reviewer for accessibility text", () => {
    const matches = Roles.match("The UI needs WCAG accessibility improvements and better usability.", [])
    const ux = matches.find((m) => m.role === "ux-reviewer")
    expect(ux).toBeDefined()
  })

  test("matches documentation-writer for docs text", () => {
    const matches = Roles.match("We need to write API docs and a README tutorial.", [])
    const docs = matches.find((m) => m.role === "documentation-writer")
    expect(docs).toBeDefined()
  })

  test("matches qa for testing text", () => {
    const matches = Roles.match("Need test coverage for edge cases and regression testing.", [])
    const qa = matches.find((m) => m.role === "qa")
    expect(qa).toBeDefined()
    expect(qa!.signals).toContain("test")
  })

  test("excludes already active roles", () => {
    const matches = Roles.match("There is a security vulnerability in token handling.", ["security-reviewer"])
    expect(matches.find((m) => m.role === "security-reviewer")).toBeUndefined()
  })

  test("excludes multiple active roles", () => {
    const matches = Roles.match("Security vulnerability, performance bottleneck, database migration needed.", [
      "security-reviewer",
      "performance-specialist",
    ])
    expect(matches.find((m) => m.role === "security-reviewer")).toBeUndefined()
    expect(matches.find((m) => m.role === "performance-specialist")).toBeUndefined()
    expect(matches.find((m) => m.role === "database-specialist")).toBeDefined()
  })

  test("returns empty for text with no signals", () => {
    const matches = Roles.match("The function returns the correct result.", [])
    expect(matches).toHaveLength(0)
  })

  test("architect and developer never match (no signals)", () => {
    const matches = Roles.match("Design the architecture and implement the solution.", [])
    expect(matches.find((m) => m.role === "architect")).toBeUndefined()
    expect(matches.find((m) => m.role === "developer")).toBeUndefined()
  })

  test("sorts by score descending", () => {
    const matches = Roles.match(
      "Database migration schema query index SQL table foreign key normalization. Also some performance issues.",
      [],
    )
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score)
    }
  })

  test("case-insensitive matching", () => {
    const matches = Roles.match("SECURITY VULNERABILITY INJECTION XSS", [])
    const sec = matches.find((m) => m.role === "security-reviewer")
    expect(sec).toBeDefined()
    expect(sec!.score).toBeGreaterThanOrEqual(3)
  })

  test("returns matched signal names", () => {
    const matches = Roles.match("Check the database schema and migration plan.", [])
    const db = matches.find((m) => m.role === "database-specialist")
    expect(db).toBeDefined()
    expect(db!.signals).toContain("database")
    expect(db!.signals).toContain("schema")
    expect(db!.signals).toContain("migration")
  })

  test("handles empty text", () => {
    const matches = Roles.match("", [])
    expect(matches).toHaveLength(0)
  })

  test("can match multiple roles simultaneously", () => {
    const matches = Roles.match("Security vulnerability with slow database queries causing performance bottleneck.", [])
    expect(matches.length).toBeGreaterThanOrEqual(2)
    const roles = matches.map((m) => m.role)
    expect(roles).toContain("security-reviewer")
    // Should also match performance and/or database specialists
  })
})

describe("team.roles.register visibility", () => {
  test("registered role appears in list()", () => {
    Roles.register({
      role: "test-role-list",
      prompt: "You are a test role",
      description: "For testing list visibility",
      expertise: ["testing"],
      workspaceRead: ["goal"],
      workspaceWrite: ["artifacts"],
      signals: ["test-signal-unique"],
    })

    const all = Roles.list()
    const found = all.find((r) => r.role === "test-role-list")
    expect(found).toBeDefined()
    expect(found!.description).toBe("For testing list visibility")
  })

  test("registered role with signals is matchable via match()", () => {
    Roles.register({
      role: "test-role-match",
      prompt: "matcher",
      description: "For testing match",
      expertise: ["matching"],
      workspaceRead: [],
      workspaceWrite: [],
      signals: ["unique-signal-alpha", "unique-signal-beta"],
    })

    const matches = Roles.match("We need unique-signal-alpha and unique-signal-beta capabilities.", [])
    const found = matches.find((m) => m.role === "test-role-match")
    expect(found).toBeDefined()
    expect(found!.score).toBeGreaterThanOrEqual(2)
  })
})
