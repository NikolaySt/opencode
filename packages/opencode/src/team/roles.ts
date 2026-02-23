import PROMPT_ARCHITECT from "./prompt/architect.txt"
import PROMPT_DEVELOPER from "./prompt/developer.txt"
import PROMPT_QA from "./prompt/qa.txt"
import PROMPT_SECURITY from "./prompt/security-reviewer.txt"
import PROMPT_PERFORMANCE from "./prompt/performance-specialist.txt"
import PROMPT_DATABASE from "./prompt/database-specialist.txt"
import PROMPT_DEVOPS from "./prompt/devops.txt"
import PROMPT_UX from "./prompt/ux-reviewer.txt"
import PROMPT_DOCS from "./prompt/documentation-writer.txt"

export namespace Roles {
  export interface Template {
    role: string
    prompt: string
    description: string
    expertise: string[]
    workspaceRead: string[]
    workspaceWrite: string[]
    signals: string[]
  }

  const templates: Record<string, Template> = {
    architect: {
      role: "architect",
      prompt: PROMPT_ARCHITECT,
      description: "System design, pattern selection, technical decisions",
      expertise: ["system design", "architecture", "patterns", "interfaces"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts", "questions"],
      workspaceWrite: ["plan", "decisions", "questions"],
      signals: [],
    },
    developer: {
      role: "developer",
      prompt: PROMPT_DEVELOPER,
      description: "Implementation, code quality, testing",
      expertise: ["implementation", "code quality", "testing", "debugging"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts", "questions", "tasks"],
      workspaceWrite: ["artifacts", "questions", "tasks"],
      signals: [],
    },
    qa: {
      role: "qa",
      prompt: PROMPT_QA,
      description: "Testing, verification, quality assurance",
      expertise: ["testing", "verification", "edge cases", "quality"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts", "tasks"],
      workspaceWrite: ["artifacts", "questions"],
      signals: ["test", "coverage", "edge case", "regression"],
    },
    "security-reviewer": {
      role: "security-reviewer",
      prompt: PROMPT_SECURITY,
      description: "Security review, vulnerability assessment, auth patterns",
      expertise: ["security", "auth", "OWASP", "encryption", "input validation"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts"],
      workspaceWrite: ["questions"],
      signals: [
        "security",
        "vulnerability",
        "injection",
        "xss",
        "csrf",
        "auth",
        "authentication",
        "authorization",
        "encryption",
        "password",
        "token",
        "credential",
      ],
    },
    "performance-specialist": {
      role: "performance-specialist",
      prompt: PROMPT_PERFORMANCE,
      description: "Performance analysis, optimization, scalability",
      expertise: ["performance", "optimization", "profiling", "scalability", "caching"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts"],
      workspaceWrite: ["questions"],
      signals: [
        "performance",
        "slow",
        "latency",
        "throughput",
        "bottleneck",
        "optimization",
        "cache",
        "memory",
        "cpu",
        "scalability",
      ],
    },
    "database-specialist": {
      role: "database-specialist",
      prompt: PROMPT_DATABASE,
      description: "Schema design, migrations, query optimization",
      expertise: ["database", "schema", "migration", "query optimization", "indexing"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts"],
      workspaceWrite: ["artifacts", "questions"],
      signals: ["database", "migration", "schema", "query", "index", "sql", "table", "foreign key", "normalization"],
    },
    devops: {
      role: "devops",
      prompt: PROMPT_DEVOPS,
      description: "Deployment, CI/CD, infrastructure, monitoring",
      expertise: ["deployment", "CI/CD", "infrastructure", "monitoring", "docker"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts"],
      workspaceWrite: ["artifacts", "questions"],
      signals: [
        "deploy",
        "deployment",
        "ci/cd",
        "pipeline",
        "infrastructure",
        "docker",
        "kubernetes",
        "monitoring",
        "logging",
      ],
    },
    "ux-reviewer": {
      role: "ux-reviewer",
      prompt: PROMPT_UX,
      description: "Usability, accessibility, user experience review",
      expertise: ["usability", "accessibility", "WCAG", "user experience", "UI design"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts"],
      workspaceWrite: ["questions"],
      signals: ["ui", "ux", "user experience", "accessibility", "wcag", "usability", "responsive", "screen reader"],
    },
    "documentation-writer": {
      role: "documentation-writer",
      prompt: PROMPT_DOCS,
      description: "Technical writing, API docs, user guides",
      expertise: ["documentation", "technical writing", "API docs", "tutorials"],
      workspaceRead: ["goal", "constraints", "plan", "decisions", "artifacts", "questions"],
      workspaceWrite: ["artifacts"],
      signals: ["documentation", "readme", "docs", "api docs", "changelog", "tutorial", "guide"],
    },
  }

  export function get(role: string): Template | undefined {
    return templates[role]
  }

  export function list(): Template[] {
    return Object.values(templates)
  }

  export function register(template: Template) {
    templates[template.role] = template
  }

  /**
   * Match agent output text against role signals.
   * Returns roles sorted by match strength (number of signal hits),
   * excluding any roles already active on the team.
   */
  export function match(
    text: string,
    activeRoles: string[],
  ): Array<{ role: string; score: number; signals: string[] }> {
    const lower = text.toLowerCase()
    const results: Array<{ role: string; score: number; signals: string[] }> = []

    for (const template of Object.values(templates)) {
      if (activeRoles.includes(template.role)) continue
      if (template.signals.length === 0) continue

      const hits = template.signals.filter((s) => lower.includes(s.toLowerCase()))
      if (hits.length > 0) {
        results.push({ role: template.role, score: hits.length, signals: hits })
      }
    }

    return results.sort((a, b) => b.score - a.score)
  }
}
