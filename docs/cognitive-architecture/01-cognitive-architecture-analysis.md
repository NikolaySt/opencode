# Cognitive Architecture Analysis: OpenCode Agent

> A cognitive-science-grounded analysis of how chain-of-thought reasoning is architecturally
> implemented in the OpenCode agent. This document treats source code as an externalized,
> inspectable cognitive system and maps its structures to established models of human cognition.

**Date**: 2026-02-20
**Codebase Analyzed**: `packages/opencode/src/` (~40+ source files across 15 modules)
**Cognitive Science Framework**: Kahneman (2011), Newell & Simon (1972), Ericsson & Simon (1993), Vygotsky (1934), Miller (1956), Flavell (1979), Chi et al. (1989), Johnson-Laird (1983)

---

## Table of Contents

1. [Phase 1: Architectural Survey](#phase-1-architectural-survey)
2. [Phase 2: Chain-of-Thought Dissection](#phase-2-chain-of-thought-dissection)
3. [Phase 3: Cognitive Mechanism Mapping](#phase-3-cognitive-mechanism-mapping)
4. [Phase 4: Failure Mode Analysis](#phase-4-failure-mode-analysis)
5. [Phase 5: Synthesis](#phase-5-synthesis)

---

## Phase 1: Architectural Survey

### 1.1 Entry Points: How Does a Thought Begin?

A "thought" in OpenCode begins at `SessionPrompt.prompt()` (`src/session/prompt.ts`), triggered when a user submits a message. The function:

1. Intercepts slash commands (`/command`) via `ChatCommand.execute()` -- a reflexive fast-path
2. Calls `createUserMessage()` -- resolves files, agents, MCP resources, persists the user message
3. Enters `SessionPrompt.loop()` -- the core deliberative cycle

The loop is a `while(true)` with exit conditions, making the fundamental flow topology a **looping pipeline with conditional branching**.

### 1.2 Flow Topology

```
User Input
    |
    v
+-------------------------------------------------------------+
|  SessionPrompt.loop() -- THE AGENTIC LOOP                   |
|                                                              |
|  +--------------------------------------------------------+  |
|  |  Pipeline (9 stages, Koa-style middleware)              |  |
|  |                                                         |  |
|  |  RESOLVE_AGENT --> CREATE_MESSAGE --> RESOLVE_TOOLS     |  |
|  |       |                                    |            |  |
|  |       v                                    v            |  |
|  |  BUILD_SYSTEM --> AGENT_START --> PRE_SEND              |  |
|  |                                      |                  |  |
|  |                                      v                  |  |
|  |                                   PROCESS               |  |
|  |                                      |                  |  |
|  |                              +-------+-------+          |  |
|  |                              v       v       v          |  |
|  |                           "stop"  "compact" "continue"  |  |
|  |                              |       |       |          |  |
|  |                              v       v       |          |  |
|  |                          POST_PROCESS        |          |  |
|  |                              |               |          |  |
|  |                              v               |          |  |
|  |                      COMPACTION_CHECK         |          |  |
|  |                              |               |          |  |
|  +------------------------------+---------------+          |  |
|                                 |                          |  |
|  <-------------- loop continues +                          |  |
|                                                            |  |
|  Exit conditions:                                          |  |
|  - Model finishes without tool calls (natural completion)  |  |
|  - Permission rejected (blocked)                           |  |
|  - Unrecoverable error                                     |  |
|  - Max steps reached                                       |  |
|  - Compaction triggers context reset                       |  |
+------------------------------------------------------------+
         |
         v
   Return to user
```

**Classification**: The topology is **iterative-looping with embedded pipeline**. Each loop iteration is a full deliberation cycle (System 2 in cognitive terms). The pipeline stages within each iteration are linear-sequential, but tool calls within a step can be parallel (the AI SDK handles this).

### 1.3 Component Inventory

| Component              | Cognitive Role                                              | Key Files                      |
| ---------------------- | ----------------------------------------------------------- | ------------------------------ |
| `Agent` definitions    | **Personality/Role** -- constrains what the mind can do     | `src/agent/agent.ts`           |
| System prompts         | **Internalized Instructions** -- beliefs about itself       | `src/session/prompt/*.txt`     |
| `SessionPrompt.loop()` | **Executive Control** -- central deliberation loop          | `src/session/prompt.ts`        |
| `SessionProcessor`     | **Perception + Action** -- processes stream, executes tools | `src/session/processor.ts`     |
| `LLM.stream()`         | **Thought Generation** -- the actual inference call         | `src/session/llm.ts`           |
| `ToolRegistry` + tools | **Action Repertoire** -- what the agent can do              | `src/tool/`                    |
| `PermissionNext`       | **Impulse Control** -- gates actions via allow/deny/ask     | `src/permission/next.ts`       |
| `SessionCompaction`    | **Memory Consolidation** -- compresses context              | `src/session/compaction.ts`    |
| Memory system          | **Long-term Memory** -- RAG with vector embeddings          | `src/memory/`                  |
| Snapshot system        | **Episodic Memory** -- git-based file change tracking       | `src/snapshot/`                |
| Plugin hooks           | **Neuromodulation** -- external systems modify processing   | `src/plugin/`                  |
| Plan mode              | **Structured Deliberation** -- read-only phased planning    | `prompt/plan.txt`, `prompt.ts` |
| Task tool (sub-agents) | **Cognitive Delegation** -- spawns specialist sub-minds     | `src/tool/task.ts`             |
| Todo system            | **Goal Stack** -- explicit task tracking                    | `src/session/todo.ts`          |

### 1.4 Data Flow

Information passes between components through four channels:

1. **Structured state objects**: `PipelineSharedState` carries typed data between pipeline stages
2. **SQLite persistence**: Messages, parts, and tool states are persisted and re-loaded each iteration
3. **Natural language intermediaries**: System prompts, `<system-reminder>` tags, and plan files pass instructions as natural language embedded in the conversation
4. **Event bus**: `Bus.publish()` enables asynchronous, decoupled communication

The most cognitively significant channel is #3 -- the agent's "inner speech" is literally natural language instructions injected into the conversation stream.

---

## Phase 2: Chain-of-Thought Dissection

### 2.1 CoT Generation Points

OpenCode implements chain-of-thought at three distinct levels:

**Level 1: Model-Native Reasoning Tokens** (`src/session/processor.ts:100-126`)

Models like Claude and GPT-5 produce dedicated reasoning tokens. These are captured as `MessageV2.ReasoningPart` objects with `reasoning-start`, `reasoning-delta`, and `reasoning-end` events. This is the most literal implementation of CoT -- the model's own step-by-step thinking.

**Level 2: Prompt-Instructed CoT** (system prompt templates)

The system prompts instruct models to reason step by step:

- `gemini.txt`: 5-step workflow (Understand -> Plan -> Implement -> Verify Tests -> Verify Standards)
- `beast.txt`: 10-step workflow with mandatory internet research
- `anthropic.txt`: TodoWrite-based planning

These are externally imposed reasoning structures.

**Level 3: Architectural CoT** (the loop itself)

The most important CoT is emergent from the architecture: each iteration of `SessionPrompt.loop()` IS a reasoning step. The agent generates text and/or tool calls -> receives tool results -> generates the next step. The "chain" is the sequence of (thought, action, observation) triples persisted as message parts.

### 2.2 CoT Structure Classification

**Hybrid: Iterative-Hierarchical with Parallel Delegation**

- **Iterative**: The main loop cycles through Draft -> Tool Calls -> Observe Results -> Refine
- **Hierarchical**: Plan mode decomposes into phases. Sub-agents create a second hierarchy level.
- **Parallel**: Tool calls within a single step execute in parallel. `TaskTool` delegates to sub-agents. `BatchTool` runs up to 25 tools simultaneously.

### 2.3 CoT Content at Each Step

| Loop Step         | Content Being Reasoned About                              | Where                                             |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------- |
| 1 (Initial)       | Problem understanding, information gathering              | System prompt; model's first response             |
| 2-N (Tool loops)  | Hypothesis generation, evidence gathering, implementation | Model generates tool calls based on prior results |
| N-1 (Convergence) | Self-checking, synthesis                                  | Model sees accumulated results, decides to stop   |
| N (Final)         | Conclusion, summary                                       | Model generates final text response               |
| (Max steps)       | Forced convergence                                        | `max-steps.txt` injected as assistant prefill     |

### 2.4 CoT Coupling Analysis

| Level                         | Coupling                                                  | Evidence                                                                                                          |
| ----------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Model-native reasoning tokens | **Tightly coupled** (within model) but **opaque to code** | Reasoning parts are stored and echoed back but never parsed or acted upon by code                                 |
| Prompt-instructed reasoning   | **Loosely coupled**                                       | System prompt says "think step by step" but code doesn't verify compliance                                        |
| Architectural loop CoT        | **Tightly coupled**                                       | Each tool call result directly determines next model input. `finish_reason === "tool-calls"` forces continuation. |

**Critical finding**: The "real" chain of thought in OpenCode is the **architectural loop**, not the model's generated text. The code's control flow -- deciding when to loop, stop, compact, inject reminders -- constitutes the actual cognitive architecture. The model's text generation is one component within this larger reasoning system.

---

## Phase 3: Cognitive Mechanism Mapping

### 3.1 Dual-Process Theory (Kahneman, 2011; Evans, 2010)

**System 1 (Fast Path):**

- Slash commands: Intercepted before LLM call. Pure pattern matching, zero deliberation.
- Tool validation: Zod schema parsing is instant; invalid calls caught before execution.
- Permission deny rules: Hard-coded denials bypass all deliberation.
- Cached embeddings: SHA-256 hash checks before re-embedding.
- Model routing: `SystemPrompt.provider()` uses string matching to select prompts.

**System 2 (Slow Path):**

- The main loop: Every iteration is a full LLM inference call.
- Plan mode: Forces a 5-phase structured reasoning process.
- Compaction: A full LLM call dedicated to summarizing -- "thinking about thinking."
- Memory extraction: LLM-based knowledge extraction from completed sessions.

**Routing**: No explicit complexity detection routes between fast and slow paths. The agent always engages System 2 for any substantive task. The `explore` agent (restricted to read-only tools) is the closest analog to a fast path.

**Missing**: A mechanism to detect task simplicity and skip the full deliberation loop.

### 3.2 Problem Space Navigation (Newell & Simon, 1972)

**Problem state representation**: `PipelineSharedState` + conversation history in SQLite. Rich state including current agent, step number, available tools, system prompts, all prior messages.

**Operators**: Tool calls. Each transforms state (reading files adds knowledge, writing changes environment, searching narrows possibilities).

**Progress tracking**: `step` counter, `TodoWrite` for explicit task tracking, `StepStartPart`/`StepFinishPart` for step boundaries with token accounting.

**Sub-goal structures**: Plan mode creates explicit sub-goals. `TaskTool` delegates sub-goals. `TodoWrite` maintains a hierarchical task list.

**Dead-end detection**: Limited. Doom loop detector catches 3 identical tool calls. `Snapshot.revert()` enables undo. No strategic backtracking mechanism -- relies on model judgment.

### 3.3 Think-Aloud Protocol (Ericsson & Simon, 1993)

**Concurrent verbalization**: Model-native reasoning tokens generated before decisions. Captured via `reasoning-start/delta/end` stream events. For models with extended thinking, this is genuine concurrent think-aloud.

**Retrospective verbalization**: The `summary`, `compaction`, and `title` agents generate post-hoc labels and summaries. These are after-the-fact rationalizations.

**Does verbalization change reasoning?** Yes, in two ways:

1. Reasoning tokens feed back: Stored as `ReasoningPart`, included in subsequent model calls via `toModelMessages()`.
2. TodoWrite shapes behavior: Agent's own planning text constrains future actions via context.

**Confabulation risk**: The code does NOT verify that stated reasoning matches actual decisions. No mechanism detects inconsistency between "I'll check first" and immediately writing.

### 3.4 Inner Speech and Self-Regulation (Vygotsky, 1934)

This is one of OpenCode's **most sophisticated cognitive mechanisms**:

**`<system-reminder>` tags**: The primary inner speech mechanism. Mid-loop user messages are wrapped:

```
<system-reminder>
The user sent the following message:
{user's text}
Please address this message and continue with your tasks.
</system-reminder>
```

Structurally identical to Vygotsky's inner speech: externalized instructions internalized as self-regulation.

**Plan mode directives**: Massive self-regulatory instructions:

- "You may ONLY observe, analyze, and plan"
- "This ABSOLUTE CONSTRAINT overrides ALL other instructions"
  Analogous to self-talk for impulse control.

**Max-steps prefill**: Content injected as **assistant message prefill** -- the model sees it as words it already began speaking. The coding equivalent of putting words in someone's mouth.

**Thinking vs. speaking distinction**: OpenCode explicitly separates `ReasoningPart` (inner speech) from `TextPart` (outer speech). Some providers support opaque reasoning that is echoed back but never rendered -- truly private inner speech.

### 3.5 Working Memory and Chunking (Miller, 1956; Ericsson & Kintsch, 1995)

OpenCode's **most elaborate cognitive mechanism**, with four layers:

**Layer 1: Context window as working memory**
Every model has `limit.context` and `limit.output`. The system monitors token usage via `SessionCompaction.isOverflow()`. Direct analog of Miller's 4+/-1 chunks measured in tokens.

**Layer 2: Pruning (selective forgetting)**
`SessionCompaction.prune()` protects recent ~40,000 tokens and marks older outputs as compacted: `"[Old tool result content cleared]"`. Analogous to working memory decay: recent items accessible, older items degrade to gist.

**Layer 3: Compaction (chunking/summarization)**
`SessionCompaction.process()` invokes the compaction agent to summarize into: Goal, Instructions, Discoveries, Accomplished, Relevant files. Cognitive chunking -- reducing many items into organized representation.

**Layer 4: Tool output truncation (attention gating)**
`Truncate.output()` caps any output at 2,000 lines / 50KB. Prevents single input from monopolizing working memory.

**Long-term working memory (Ericsson & Kintsch)**:
The `src/memory/` system implements retrieval-augmented long-term working memory:

- Chunking: Markdown files split into ~400-token chunks with heading context
- Embedding: `text-embedding-3-small` (1536 dimensions)
- Hybrid retrieval: 70% vector similarity + 30% BM25 keyword search
- Priority injection: P1 (invariants) -> P2 (relevant search) -> P3 (summaries) -> P4 (entities)
- Budget management: Injection dynamically clamped to prevent context overflow

### 3.6 Metacognition and Self-Monitoring (Flavell, 1979; Nelson & Narens, 1990)

**Present:**

1. Doom loop detection (`processor.ts:169-193`): Recognizes repetitive behavior as failure signal.
2. Max steps enforcement: Hard limit on reasoning depth.
3. Context overflow detection: Self-monitoring of cognitive load.
4. Retry with backoff (`retry.ts`): Distinguishes "can't right now" from "can't at all."
5. Permission gates: Pauses for verification on uncertain actions.

**Absent:**

1. Confidence calibration: No self-scored confidence.
2. Self-critique loops: No built-in output review and revision.
3. Error recognition: Cannot detect own errors without external feedback.
4. "Feeling of knowing" (FOK): No mechanism to distinguish knowledge gaps.

### 3.7 Self-Explanation Effect (Chi et al., 1989)

`TodoWrite` is the strongest self-explanation mechanism. The system prompt says: "These tools are also EXTREMELY helpful for planning tasks... If you do not use this tool when planning, you may forget to do important tasks."

The generated todo list feeds back into context, guiding subsequent actions. Plan mode forces structured plan production before execution -- mirroring Chi et al.'s finding.

**However**: The system never evaluates whether self-explanation improved outcomes.

### 3.8 Mental Models (Johnson-Laird, 1983)

**Present but implicit:**

- Snapshot diffs: Before/after view of file changes.
- Session summaries: Cumulative change tracking.
- Memory entities: Structured representations of paths, functions, classes, technologies.
- Plan files: Explicit model of intended solution.

**Absent**: No simulation or what-if reasoning. No pre-execution consequence evaluation.

### Summary Table

| Mechanism                      | Present? | Implementation                            | Fidelity    | Notes                            |
| ------------------------------ | -------- | ----------------------------------------- | ----------- | -------------------------------- |
| Dual Process (System 1/2)      | Partial  | Multiple agents, model routing            | Medium      | No complexity-based routing      |
| Problem Space Navigation       | Yes      | Loop + state + tools + steps              | High        | Rich state, limited backtracking |
| Think-Aloud / Verbalization    | Yes      | Reasoning tokens, TodoWrite               | Medium-High | Concurrent + retrospective       |
| Inner Speech / Self-Regulation | Yes      | `<system-reminder>`, plan mode, prefill   | High        | Sophisticated layered authority  |
| Working Memory Management      | Yes      | 4-layer pruning/compaction/truncation/RAG | Very High   | Most elaborate mechanism         |
| Metacognition                  | Partial  | Doom loop, max steps, overflow detection  | Medium      | No confidence, no self-critique  |
| Self-Explanation               | Partial  | TodoWrite, plan mode                      | Low-Medium  | Not evaluated for effectiveness  |
| Mental Model Construction      | Partial  | Snapshots, summaries, entities            | Medium      | No simulation capability         |

---

## Phase 4: Failure Mode Analysis

### 4.1 Reasoning Chain Collapse

**Risk**: Malformed tool calls break the chain.

**Mitigations**: Tool name repair (lowercase matching), `InvalidTool` fallback, Zod validation returns errors as results, retry with backoff for transient failures.

**Residual risk**: Consistently nonsensical outputs cycle between invalid calls without guidance on correct tools.

### 4.2 Circular Reasoning / Loops

**Risk**: Agent calls same tools repeatedly without progress.

**Mitigations**: Doom loop detector (3 identical calls), max steps limit, compaction breaks patterns.

**Gap**: Detector only catches identical calls. Slightly varying calls (read line 1-50, then 1-51) evade detection. No semantic repetition detection.

### 4.3 Confabulation (Nisbett & Wilson Parallel)

**Risk**: Plausible reasoning that doesn't match actual behavior.

**Mitigations**: None in architecture. Code never cross-validates stated intentions against actions. Reasoning tokens stored but never parsed or verified.

### 4.4 Anchoring

**Risk**: Early information disproportionately influences later reasoning.

**Where it manifests**: System prompt dominates; memory injection uses first user message as search query; compaction preserves original Goal/Instructions.

**Mitigations**: None. Prompt caching actually reinforces anchoring.

### 4.5 Premature Convergence

**Risk**: Agent commits to an approach too early.

**Mitigations**: Plan mode forces exploration before action. User can reject plans. But no automated multi-hypothesis generation.

### 4.6 Context Overflow (Working Memory Overload)

**Risk**: Conversation exceeds context window.

**Mitigations**: Token tracking, truncation (2,000 lines/50KB), pruning (protect recent 40K), compaction (LLM summarization), memory budget clamping, overflow error detection.

**Residual risk**: Compaction loses nuance. Failed-approach knowledge may be lost, causing re-attempts.

### 4.7 Metacognitive Failure

**Risk**: Confidently wrong without knowing it.

**Where it manifests**: No confidence scoring, no verification step, no knowledge-gap detection.

**Mitigations**: Permission system creates human-in-the-loop checkpoints for destructive actions. Non-destructive actions have no safety net.

---

## Phase 5: Synthesis

### The Cognitive Architecture in Summary

OpenCode is a **prompted deliberation loop with environmental scaffolding**. The code provides scaffolding (tools, permissions, memory, context management, plan mode) within which the LLM performs actual reasoning.

The "chain of thought" is not primarily in the model's generated text but in the **sequence of loop iterations and tool calls** that the architecture orchestrates. The code thinks through iteration; the model thinks through generation. Together they form a cognitive system more capable than either component alone.

**Strongest mechanism**: Working memory management (4-layer pruning/compaction/truncation/RAG).

**Most interesting mechanism**: Inner speech system (`<system-reminder>`, plan mode, max-steps prefill).

**Weakest area**: Metacognition (no self-assessment, no confidence calibration, no self-critique).

**Fundamental characteristic**: Single-agent architecture. One mind, one conversation stream. No inter-agent dialogue, no cross-role review, no collaborative reasoning.

### Recommendations

1. **Complexity-based routing**: Pre-pipeline classifier to route simple tasks to fast path.
2. **Self-verification loops**: Post-process step that runs tests/linting and evaluates output.
3. **Improved loop detection**: Semantic similarity checking, not just identity matching.
4. **Explicit world model**: Auto-constructed project model injected as context.
5. **Compaction knowledge preservation**: Add "Failed Approaches" and "Decision Rationale" sections.
6. **Multi-hypothesis reasoning**: Generate alternative approaches before committing.
7. **Multi-agent collaboration**: See [04-dynamic-cognitive-team-model.md](./04-dynamic-cognitive-team-model.md).
