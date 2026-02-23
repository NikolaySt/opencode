# Role and Prompt Flow Analysis

> Complete mapping of every role, persona, and prompt injection point in OpenCode's
> thinking flow. This document traces how the agent's identity and instructions are
> layered, switched, and overridden at each stage of processing.

**Date**: 2026-02-20

---

## Table of Contents

1. [The 7-Layer Identity Stack](#the-7-layer-identity-stack)
2. [Layer 1: Base Identity (Provider-Specific)](#layer-1-base-identity)
3. [Layer 2: Agent-Specific Persona Override](#layer-2-agent-specific-persona)
4. [Layer 3: Mode-Specific Directives (Inner Speech)](#layer-3-mode-specific-directives)
5. [Layer 4: Contextual Injections](#layer-4-contextual-injections)
6. [Layer 5: Instruction Files](#layer-5-instruction-files)
7. [Layer 6: Sub-Agent Identity Switching](#layer-6-sub-agent-identity)
8. [Layer 7: Auxiliary LLM Calls](#layer-7-auxiliary-llm-calls)
9. [Complete Prompt Template Inventory](#complete-prompt-template-inventory)
10. [System-Reminder Injection Points](#system-reminder-injection-points)
11. [All Persona Identity Declarations](#all-persona-identity-declarations)
12. [End-to-End Flow for a Single Turn](#end-to-end-flow)
13. [Key Finding: Static Costume Changes, Not Collaboration](#key-finding)

---

## The 7-Layer Identity Stack

OpenCode's agent identity is not monolithic -- it is a **stack of overlapping directives** where later layers constrain, augment, or completely replace earlier ones:

```
Layer 7: Auxiliary LLM Calls    (completely separate identities)
Layer 6: Sub-Agent Switching    (full identity replacement)
Layer 5: Instruction Files      (static knowledge injection)
Layer 4: Contextual Injections  (RAG memory, plugin context)
Layer 3: Mode Directives        (plan/build/max-steps inner speech)
Layer 2: Agent Persona Override  (explore/compaction/title replaces base)
Layer 1: Base Identity          (provider-specific: anthropic/gemini/beast/etc.)
```

---

## Layer 1: Base Identity

Selected at `src/session/system.ts:19-27` based on model family:

| Model Family | Prompt File                       | Identity                                        | Key Characteristics                                      |
| ------------ | --------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| Claude       | `session/prompt/anthropic.txt`    | "OpenCode, the best coding agent on the planet" | Professional, objective, TodoWrite-heavy                 |
| GPT-5        | `session/prompt/codex_header.txt` | "OpenCode, the best coding agent on the planet" | `apply_patch` preference, anti-generic design            |
| GPT/o1/o3    | `session/prompt/beast.txt`        | "opencode, an agent"                            | Aggressive, mandates internet research, 10-step workflow |
| Gemini       | `session/prompt/gemini.txt`       | "opencode, an interactive CLI agent"            | 5-step engineering workflow, "No Chitchat"               |
| Trinity      | `session/prompt/trinity.txt`      | "opencode, an interactive CLI tool"             | Sequential: one tool per message                         |
| Fallback     | `session/prompt/qwen.txt`         | "opencode, an interactive CLI tool"             | Extreme brevity, no TodoWrite                            |

These are **mutually exclusive** -- only one is active per session.

### Provider Prompt Routing Code

```typescript
// src/session/system.ts:19-27
export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
  if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3")) return [PROMPT_BEAST]
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  return [PROMPT_ANTHROPIC_WITHOUT_TODO] // qwen.txt fallback
}
```

---

## Layer 2: Agent-Specific Persona

When an agent defines its own `prompt` field, it **replaces** the provider prompt entirely (`src/session/llm.ts:68-72`):

```typescript
// src/session/llm.ts:68-72
const system = [
  agent.prompt ? [agent.prompt]          // agent prompt REPLACES provider prompt
    : isCodex ? []
    : SystemPrompt.provider(model),      // otherwise use provider prompt
  ...input.system,
  ...(input.user.system ? [...] : []),
].join("\n")
```

Built-in agents with custom prompts (identity override):

| Agent        | Prompt File                   | New Identity                                             | Tools Available                   |
| ------------ | ----------------------------- | -------------------------------------------------------- | --------------------------------- |
| `explore`    | `agent/prompt/explore.txt`    | "You are a file search specialist"                       | Read-only: grep, glob, read, bash |
| `compaction` | `agent/prompt/compaction.txt` | "You are a helpful AI assistant tasked with summarizing" | None (all denied)                 |
| `title`      | `agent/prompt/title.txt`      | "You are a title generator"                              | None (all denied)                 |
| `summary`    | `agent/prompt/summary.txt`    | No identity declaration                                  | None (all denied)                 |

Agents WITHOUT custom prompts (use base identity):

| Agent     | Identity                        | Notes                                 |
| --------- | ------------------------------- | ------------------------------------- |
| `build`   | Provider-specific base identity | Default agent, full tool access       |
| `plan`    | Provider-specific base identity | Read-only via permissions, not prompt |
| `general` | Provider-specific base identity | Sub-agent, full tools minus TodoWrite |

---

## Layer 3: Mode-Specific Directives

Injected on top of the base identity via `<system-reminder>` tags at `src/session/prompt.ts`:

### Plan Mode (lines 1739-1808)

A massive inner directive that constrains behavior while preserving identity:

```
<system-reminder>
CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes...

## Responsibility
Your current responsibility is to think, read, search, and delegate explore agents
to construct a well-formed plan...

## Phases:
Phase 1: Initial Understanding (launch up to 3 explore agents in parallel)
Phase 2: Design (launch general agent(s))
Phase 3: Review (read critical files, ask user)
Phase 4: Final Plan (write to plan file)
Phase 5: Call plan_exit tool
</system-reminder>
```

### Build Switch (`session/prompt/build-switch.txt`, 5 lines)

```
<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your
arsenal of tools as needed.
</system-reminder>
```

### Max Steps (`session/prompt/max-steps.txt`, injected at line 847)

Injected as **assistant message prefill** (not system/user message):

```
CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached.
Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions

Response must include:
- Statement that maximum steps have been reached
- Summary of what has been accomplished
- List of remaining tasks
- Recommendations for next steps

Any attempt to use tools is a critical violation. Respond with text ONLY.
```

### Mid-Loop User Messages (line 777-782)

When `step > 1`, user interjections are reframed as self-regulation:

```
<system-reminder>
The user sent the following message:
{actual user message}

Please address this message and continue with your tasks.
</system-reminder>
```

---

## Layer 4: Contextual Injections

### Memory Plugin (`src/memory/inject.ts`)

Injected at `agent.start` hook with priority-based budget:

| Priority | Budget                                                   | Content |
| -------- | -------------------------------------------------------- | ------- |
| P1 (30%) | Project invariants from `MEMORY.md`                      |
| P2 (40%) | Semantically relevant search results from vector store   |
| P3 (20%) | Recent session summaries (validated/candidate knowledge) |
| P4 (10%) | Entity-matched context from query                        |

Format: `"## Project Memory\n\n" + sections.join("\n\n")`

Injected as `prependContext` at AGENT_START pipeline stage (`src/session/prompt.ts:812-813`).

### Plugin System Prompt Transforms

- `experimental.chat.system.transform` hook (`src/session/llm.ts:83-93`): Any plugin can mutate system prompt array.
- `experimental.chat.messages.transform` (`src/session/prompt.ts:787`): Plugins can mutate entire message history.

---

## Layer 5: Instruction Files

Loaded by `InstructionPrompt.system()` (`src/session/instruction.ts`):

1. Walk up from project directory to worktree root for `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`
2. Check global config dir and `~/.claude/CLAUDE.md`
3. Resolve `config.instructions` entries (files, globs, URLs)

Each file prefixed with: `"Instructions from: {path}"`

Additionally, the `Read` tool (`src/tool/read.ts:220`) injects instruction files found in parent directories as `<system-reminder>` tags in tool output.

---

## Layer 6: Sub-Agent Identity Switching

When `TaskTool` spawns a sub-agent, the child session gets a completely different identity:

```
build agent (parent identity: "OpenCode")
    |
    +-- TaskTool("explore", "find API endpoints")
    |       child identity: "file search specialist"
    |       capabilities: read-only
    |       returns: text blob in <task_result> tags
    |
    +-- TaskTool("general", "refactor auth module")
            child identity: provider-specific base
            capabilities: full tools minus TodoWrite
            returns: text blob in <task_result> tags
```

Sub-agents:

- Cannot communicate with each other
- Cannot push back on parent's framing
- Cannot see parent's todo list (`todowrite: deny`, `todoread: deny`)
- Cannot spawn nested sub-agents (default: `task: deny`)
- Return a single text blob, no structured handoff

---

## Layer 7: Auxiliary LLM Calls

These operate with entirely separate identities, invisible to the primary agent:

| Operation            | Identity                                       | System Prompt        | Model                                | File                              |
| -------------------- | ---------------------------------------------- | -------------------- | ------------------------------------ | --------------------------------- |
| Title generation     | "You are a title generator"                    | `system: []` (empty) | Small model (haiku/flash/nano)       | `prompt.ts:2274`                  |
| Compaction           | "helpful AI assistant tasked with summarizing" | `system: []` (empty) | Current model or configured override | `compaction.ts:115`               |
| Knowledge extraction | "You are a knowledge extraction system"        | Via user message     | Small model                          | `memory/extract.ts:28`            |
| Agent generation     | "elite AI agent architect"                     | Direct system prompt | Current model                        | `agent/generate.txt`              |
| Code review          | "You are a code reviewer"                      | Via command template | Current model                        | `command/template/review.txt`     |
| Codebase init        | Codebase analyzer                              | Via command template | Current model                        | `command/template/initialize.txt` |

---

## Complete Prompt Template Inventory

### 39 .txt Files Across the Codebase

**Provider-specific (6)** -- imported in `src/session/system.ts`:
| File | Import Name | Used For |
|---|---|---|
| `session/prompt/anthropic.txt` | `PROMPT_ANTHROPIC` | Claude models |
| `session/prompt/qwen.txt` | `PROMPT_ANTHROPIC_WITHOUT_TODO` | Fallback / Qwen |
| `session/prompt/beast.txt` | `PROMPT_BEAST` | GPT/o1/o3 |
| `session/prompt/gemini.txt` | `PROMPT_GEMINI` | Gemini models |
| `session/prompt/codex_header.txt` | `PROMPT_CODEX` | GPT-5 models |
| `session/prompt/trinity.txt` | `PROMPT_TRINITY` | Trinity models |

**Pipeline control (3)** -- imported in `src/session/prompt.ts`:
| File | Import Name | Used For |
|---|---|---|
| `session/prompt/plan.txt` | `PROMPT_PLAN` | Plan mode (legacy) |
| `session/prompt/build-switch.txt` | `BUILD_SWITCH` | Plan-to-build transition |
| `session/prompt/max-steps.txt` | `MAX_STEPS` | Step limit enforcement |

**Agent prompts (5)** -- imported in `src/agent/agent.ts`:
| File | Import Name | Used For |
|---|---|---|
| `agent/generate.txt` | `PROMPT_GENERATE` | AI agent creation |
| `agent/prompt/compaction.txt` | `PROMPT_COMPACTION` | Context summarization |
| `agent/prompt/explore.txt` | `PROMPT_EXPLORE` | File search specialist |
| `agent/prompt/summary.txt` | `PROMPT_SUMMARY` | PR-style summaries |
| `agent/prompt/title.txt` | `PROMPT_TITLE` | Title generation |

**Command templates (2)** -- imported in `src/command/index.ts`:
| File | Import Name | Used For |
|---|---|---|
| `command/template/initialize.txt` | `PROMPT_INITIALIZE` | AGENTS.md creation |
| `command/template/review.txt` | `PROMPT_REVIEW` | Code review |

**Tool descriptions (20)** -- one per tool:
`bash.txt`, `read.txt`, `write.txt`, `edit.txt`, `glob.txt`, `grep.txt`, `batch.txt`, `task.txt`, `question.txt`, `plan-enter.txt`, `plan-exit.txt`, `todo.txt` (todowrite), `skill.txt`, `lsp.txt`, `webfetch.txt`, `websearch.txt`, `codesearch.txt`, `multiedit.txt`, `ls.txt`, `apply_patch.txt`

**Reference/unused (3)**:
`copilot-gpt-5.txt`, `plan-reminder-anthropic.txt`, `anthropic-20250930.txt`

---

## System-Reminder Injection Points

5 distinct injection sites:

| File                              | Lines     | Context                                                           |
| --------------------------------- | --------- | ----------------------------------------------------------------- |
| `session/prompt.ts`               | 777-782   | Mid-conversation user messages wrapped for self-regulation        |
| `session/prompt.ts`               | 1739-1808 | Plan mode activation (5-phase workflow)                           |
| `tool/read.ts`                    | 220       | AGENTS.md/CLAUDE.md in parent directories injected in tool output |
| `session/prompt/plan.txt`         | 1, 26     | Entire plan prompt wrapped in tags                                |
| `session/prompt/build-switch.txt` | 1, 5      | Mode transition notification                                      |

The system prompts document the convention:

> "Tool results and user messages may include `<system-reminder>` tags. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear."

---

## All Persona Identity Declarations

Every "You are..." statement in the codebase:

| File                   | Identity Statement                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `anthropic.txt`        | "You are OpenCode, the best coding agent on the planet."                                              |
| `codex_header.txt`     | "You are OpenCode, the best coding agent on the planet."                                              |
| `beast.txt`            | "You are opencode, an agent - please keep going until the user's query is completely resolved"        |
| `gemini.txt`           | "You are opencode, an interactive CLI agent specializing in software engineering tasks."              |
| `qwen.txt`             | "You are opencode, an interactive CLI tool that helps users with software engineering tasks."         |
| `trinity.txt`          | "You are opencode, an interactive CLI tool that helps users with software engineering tasks."         |
| `copilot-gpt-5.txt`    | "You are an expert AI programming assistant" / "Your name is opencode"                                |
| `explore.txt`          | "You are a file search specialist."                                                                   |
| `compaction.txt`       | "You are a helpful AI assistant tasked with summarizing conversations."                               |
| `title.txt`            | "You are a title generator."                                                                          |
| `generate.txt`         | "You are an elite AI agent architect specializing in crafting high-performance agent configurations." |
| `review.txt`           | "You are a code reviewer."                                                                            |
| `extract.ts` (runtime) | "You are a knowledge extraction system."                                                              |
| `system.ts` (runtime)  | "You are powered by the model named {model.api.id}"                                                   |
| `build-switch.txt`     | "You are no longer in read-only mode." (modifies existing identity)                                   |

---

## End-to-End Flow

```
User Input
    |
    v
+-- IDENTITY ASSEMBLY -----------------------------------------------+
|                                                                     |
|  1. Provider prompt: "You are OpenCode..."              [Layer 1]   |
|     (or agent.prompt replaces this entirely)            [Layer 2]   |
|                                                                     |
|  2. Environment: model name, platform, date             [Layer 1]   |
|                                                                     |
|  3. Instruction files: AGENTS.md, CLAUDE.md             [Layer 5]   |
|                                                                     |
|  4. Memory injection: P1-P4 priority context            [Layer 4]   |
|                                                                     |
|  5. Mode directives: plan/build/max-steps               [Layer 3]   |
|                                                                     |
|  6. Plugin system prompt transforms                     [Layer 4]   |
|                                                                     |
+---------------------------------------------------------------------+
    |
    v
+-- LLM INFERENCE ----------------------------------------------------+
|  Reasoning tokens (inner speech)     [model-native]                  |
|  Text tokens (outer speech)          [user-visible]                  |
|  Tool calls (actions)                [executed by code]              |
+----------------------------------------------------------------------+
    |
    v
  Tool results feed back --> next loop iteration
  (same identity stack, incremented step counter)
    |
    v
  If max steps: assistant prefill overrides everything    [Layer 3]
  If compaction: switch to compaction identity             [Layer 7]
  If title needed: switch to title identity                [Layer 7]
```

---

## Key Finding

The current system is **one mind wearing different hats**, not a team of specialists collaborating:

- No dialogue between roles
- No disagreement or critique
- No shared workspace
- No concurrent reasoning
- Each role runs in isolation, produces output consumed as raw text
- Sub-agents are hierarchical delegation, not collaboration

This finding motivates the Dynamic Cognitive Team Model proposed in [04-dynamic-cognitive-team-model.md](./04-dynamic-cognitive-team-model.md).
