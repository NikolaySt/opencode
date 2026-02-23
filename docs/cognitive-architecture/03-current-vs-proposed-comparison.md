# Architecture Comparison: Current Static Model vs. Proposed Dynamic Team Model

> Side-by-side comparison of OpenCode's current single-agent architecture against
> the proposed multi-agent collaborative architecture, grounded in cognitive science
> models and real human team dynamics.

**Date**: 2026-02-20

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Fundamental Paradigm Comparison](#fundamental-paradigm-comparison)
3. [Cognitive Science Grounding](#cognitive-science-grounding)
4. [Detailed Component Comparison](#detailed-component-comparison)
5. [Communication Model Comparison](#communication-model-comparison)
6. [Memory and Context Comparison](#memory-and-context-comparison)
7. [Decision-Making Comparison](#decision-making-comparison)
8. [Failure Mode Comparison](#failure-mode-comparison)
9. [What Each Model Does Well](#what-each-model-does-well)
10. [The Gap Analysis](#the-gap-analysis)

---

## Executive Summary

| Dimension           | Current (Static)                              | Proposed (Dynamic Team)                     |
| ------------------- | --------------------------------------------- | ------------------------------------------- |
| **Paradigm**        | Solo practitioner with costume changes        | Collaborative team with emergent roles      |
| **Conversation**    | Linear stream (user-assistant-user-assistant) | Directed graph (agent-to-agent + broadcast) |
| **Identity**        | One mind, many hats                           | Many minds, persistent identities           |
| **Memory**          | One context window + RAG                      | Shared workspace + individual contexts      |
| **Disagreement**    | Impossible (one mind)                         | Explicit via review threads                 |
| **Adaptation**      | Fixed agent roster                            | Dynamic role spawning                       |
| **Quality control** | Self-review only                              | Cross-role review                           |
| **Coordination**    | Sequential delegation                         | Orchestrated collaboration                  |

---

## Fundamental Paradigm Comparison

### Current: The Solo Practitioner

```
User --> [Single LLM Call: "You are OpenCode"]
              |
              +--> tool calls --> tool results --> [LLM Call #2: same identity]
              |
              +--> [LLM Call #3: same identity, finishes]
              |
              +--> [Separate LLM Call: "You are a title generator"]
              |
              +--> [If overflow: "You are a helpful summarizer"]
```

One conversation stream. One active agent at a time. Identity switches are costume changes -- the same brain reads a different instruction card.

**Human cognition analog**: A single person working alone, occasionally consulting a reference book (sub-agents) and making notes (compaction). No external perspective, no critique, no specialization.

### Proposed: The Collaborative Team

```
User --> [Orchestrator: "You are a tech lead"]
              |
              +--> Spawns Architect: "Design this system"
              |        |
              |        +--> Spawns Explorer: "Map the codebase" (concurrent)
              |        |
              |        +--> Architect reads Explorer's map from workspace
              |        |
              |        +--> Architect writes proposal to workspace
              |
              +--> Orchestrator triggers review
              |        |
              |        +--> Security Reviewer critiques proposal
              |        |
              |        +--> Architect revises based on critique
              |        |
              |        +--> Review loop until convergence
              |
              +--> Orchestrator assigns implementation
              |        |
              |        +--> Developer implements
              |        |
              |        +--> Developer hits issue, writes to open_questions
              |        |
              |        +--> Orchestrator routes question to Architect
              |
              +--> Orchestrator triggers QA
                       |
                       +--> QA reviews against approved design
                       |
                       +--> QA files defects, Developer fixes
                       |
                       +--> QA approves
```

Multiple concurrent agent contexts. Agents communicate through a shared workspace. Roles emerge from the work.

**Human cognition analog**: A real software development team with distributed cognition (Hutchins, 1995), transactive memory (Wegner, 1987), and negotiated understanding.

---

## Cognitive Science Grounding

| Cognitive Model                            | Current Implementation                           | Proposed Implementation                                                                  |
| ------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Distributed Cognition** (Hutchins, 1995) | Not implemented. All cognition in one agent.     | Core paradigm. Knowledge distributed across agents + workspace.                          |
| **Transactive Memory** (Wegner, 1987)      | Not implemented. One memory system.              | Orchestrator knows "who knows what." Agents specialize.                                  |
| **Dual Process** (Kahneman, 2011)          | Partial. All tasks get System 2 (full LLM loop). | Better routing. Orchestrator decides complexity, assigns appropriate specialist.         |
| **Working Memory** (Miller, 1956)          | Excellent 4-layer management for single context. | Per-agent contexts + shared workspace summary. Total system capacity multiplied.         |
| **Metacognition** (Flavell, 1979)          | Weak. Doom loop + max steps only.                | Cross-agent review IS metacognition. QA checking Developer = external critique.          |
| **Problem Space** (Newell & Simon, 1972)   | Loop with tools as operators.                    | Richer: decomposition by Orchestrator, parallel exploration, alternative paths.          |
| **Inner Speech** (Vygotsky, 1934)          | Sophisticated `<system-reminder>` system.        | Per-agent inner speech + inter-agent dialogue as "social speech becoming thought."       |
| **Self-Explanation** (Chi et al., 1989)    | TodoWrite + plan mode.                           | Agents must explain decisions to other agents (forced explanation to external audience). |
| **Mental Models** (Johnson-Laird, 1983)    | Implicit (model's understanding only).           | Workspace IS the explicit shared mental model. Multiple perspectives on same model.      |

---

## Detailed Component Comparison

### Session Model

| Aspect      | Current                                                  | Proposed                                                                    |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Structure   | `SessionTable` -> `MessageTable` -> `PartTable` (linear) | `TeamSession` -> `AgentSession[]` + `Workspace` + `TeamMessage` (graph)     |
| Messages    | Linear: user -> assistant -> user -> assistant           | Graph: agent-A -> agent-B -> agent-A, with broadcasts                       |
| Parts       | text, reasoning, tool, file, step, snapshot, patch, etc. | Same per-agent parts + new: proposal, critique, question, decision, handoff |
| State       | `idle / busy / retry` per session                        | Per-agent status + team-level phase                                         |
| Persistence | SQLite via Drizzle ORM                                   | Same infrastructure, extended schema                                        |

### Agent Model

| Aspect        | Current                                               | Proposed                                                                                        |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Definition    | Static `Agent.Info`: name, prompt, permissions, model | Dynamic `AgentInstance`: role, prompt, context, expertise, relationships, workspace_permissions |
| Lifecycle     | Pre-defined at startup, immutable during session      | Spawned by Orchestrator on demand, retired when work complete                                   |
| Count         | One active agent per session (plus hidden sub-agents) | Multiple concurrent agents per team session                                                     |
| Communication | Cannot talk to each other                             | Directed messages via conversation graph                                                        |
| Memory        | Share one conversation stream                         | Individual contexts + shared workspace                                                          |

### Tool System

| Aspect           | Current                                                              | Proposed                                                             |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tool access      | Per-agent permission rules (same for all instances of an agent type) | Per-agent-instance permissions based on role + workspace_permissions |
| Tool execution   | In the main loop, synchronous per step                               | Per-agent, can execute concurrently across agents                    |
| Results          | Feed back into single conversation                                   | Feed back into agent's context AND workspace                         |
| No change needed | Tool definitions, validation, truncation                             | These stay as-is                                                     |

### Prompt System

| Aspect        | Current                                   | Proposed                                                       |
| ------------- | ----------------------------------------- | -------------------------------------------------------------- |
| System prompt | 7-layer stack for single agent            | Per-agent prompt + workspace context injection                 |
| Identity      | Switches via prompt swap (costume change) | Persistent per agent instance                                  |
| Inner speech  | `<system-reminder>` tags                  | Per-agent reminders + inter-agent messages as social cognition |
| Instructions  | AGENTS.md loaded once                     | Shared via workspace, role-specific filtering                  |

---

## Communication Model Comparison

### Current: Hub-and-Spoke Delegation

```
build agent (hub)
    |
    +-- TaskTool("explore") --> text result
    |
    +-- TaskTool("general") --> text result
    |
    +-- build agent continues
```

Properties:

- Unidirectional: parent -> child -> return
- No child-to-child communication
- No critique or pushback
- Child cannot ask parent questions
- Child cannot see parent's context (TodoWrite denied)
- Return value is unstructured text blob

### Proposed: Workspace-Mediated Collaboration

```
Orchestrator
    |
    +-- assigns --> Architect
    |                  |
    |                  +--> writes proposal to workspace
    |                  |
    |                  +--> reads Explorer's findings from workspace
    |
    +-- assigns --> Explorer
    |                  |
    |                  +--> writes codebase map to workspace
    |
    +-- triggers review --> Security Reviewer
    |                          |
    |                          +--> reads proposal from workspace
    |                          |
    |                          +--> writes critique to review thread
    |                          |
    |                          +--> Architect reads critique
    |                          |
    |                          +--> Architect revises proposal
    |                          |
    |                          +--> Security Reviewer re-reviews
    |
    +-- routes question: Developer -> Architect (via workspace.open_questions)
```

Properties:

- Multi-directional: any agent can message any other
- Workspace provides shared context without overwhelming individual context windows
- Review loops enable critique and revision
- Questions can be routed to the appropriate specialist
- Orchestrator manages flow without being a bottleneck for content

---

## Memory and Context Comparison

### Current: Single Working Memory

```
+-- Context Window (one agent) --------------------------+
|                                                         |
|  System prompt (provider + instructions + memory)       |
|  Message history (user/assistant pairs)                 |
|  Tool call results (pruned after 40K tokens)            |
|  Compacted summaries (when overflow)                    |
|                                                         |
|  Total: limited by model context (e.g. 200K tokens)    |
+---------------------------------------------------------+
```

Total system capacity = one context window. When it fills up, information is lost (compacted to summary).

### Proposed: Distributed Memory

```
+-- Workspace (persistent, shared) ------+
|  Goal, Constraints                      |
|  Plan (evolving)                        |
|  Decisions (with rationale)             |
|  Open questions                         |
|  Review threads                         |
|  Artifacts (code, docs)                 |
|  Agent states (summaries)               |
+-----------------------------------------+
        |
        +-- Agent A context: workspace summary + own history + role-specific slice
        |       (capacity: one context window)
        |
        +-- Agent B context: workspace summary + own history + different slice
        |       (capacity: one context window)
        |
        +-- Agent C context: workspace summary + own history + another slice
                (capacity: one context window)

Total system capacity = N context windows + persistent workspace
```

Key advantages:

- **Total memory scales with team size**: N agents = N context windows worth of reasoning
- **Workspace survives compaction**: Decisions and artifacts persist independently of any agent's context
- **Selective loading**: Each agent only loads relevant workspace sections
- **Failed approach persistence**: Workspace can track what didn't work, surviving per-agent compaction

---

## Decision-Making Comparison

### Current: Single-Point Decisions

Every decision goes through one LLM call. The agent:

1. Sees the full context
2. Generates a decision (text + tool calls)
3. Executes the decision
4. Sees results
5. Makes the next decision

No external validation. No second opinion. No separation between "deciding what to do" and "doing it."

### Proposed: Multi-Point Decisions with Review

Decisions pass through multiple perspectives:

| Decision Type    | Current Flow                  | Proposed Flow                                                                          |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| Design choice    | Agent decides alone           | Architect proposes -> Reviewer critiques -> Architect revises -> Orchestrator approves |
| Implementation   | Agent writes code             | Developer writes -> QA reviews -> Developer fixes -> QA approves                       |
| Security concern | Agent may or may not notice   | Security Reviewer specifically checks                                                  |
| Performance      | Agent may or may not optimize | Performance Specialist reviews if flagged                                              |
| Architecture     | Implicit in code              | Explicit in workspace, reviewed against constraints                                    |

The proposed model introduces **deliberate friction** -- decisions must survive scrutiny from different perspectives before being committed. This maps to Janis's (1972) finding that groupthink (unchallenged decisions) produces worse outcomes than structured dissent.

---

## Failure Mode Comparison

| Failure Mode                  | Current Vulnerability                           | Proposed Mitigation                                                                       |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Circular reasoning**        | Doom loop detector (3 identical calls only)     | Different agents bring different perspectives; Orchestrator detects stalls across team    |
| **Confabulation**             | No verification; agent's claims are trusted     | Cross-agent review catches unsupported claims; QA verifies against actual behavior        |
| **Anchoring**                 | First user message anchors all reasoning        | Architect's framing is challenged by Reviewer; multiple perspectives resist single anchor |
| **Premature convergence**     | Agent commits to first approach                 | Review loops force exploration of alternatives before commitment                          |
| **Context overflow**          | 4-layer management (excellent for single agent) | Distributed across agents; workspace persists independently                               |
| **Knowledge gaps**            | Agent doesn't know what it doesn't know         | Orchestrator can spawn specialists when gap detected                                      |
| **Self-review bias**          | Agent reviews own work (confirmation bias)      | Different agent reviews work (external perspective)                                       |
| **Loss of failed approaches** | Compaction may lose "what didn't work"          | Workspace preserves decision history including rejected alternatives                      |

---

## What Each Model Does Well

### Current Model Strengths

1. **Simplicity**: One conversation, one agent, straightforward debugging
2. **Low latency**: Single LLM call per step, no coordination overhead
3. **Low cost**: One context window, no redundant processing
4. **Predictability**: Linear flow is easy to reason about
5. **Working memory management**: The 4-layer system is excellent for single-agent operation
6. **Inner speech**: The `<system-reminder>` system is sophisticated
7. **Plugin extensibility**: 16 hook points allow external modification

### Proposed Model Strengths

1. **Quality**: Cross-agent review catches errors self-review misses
2. **Scalability**: Total reasoning capacity scales with team size
3. **Specialization**: Each agent excels at its domain
4. **Resilience**: If one agent fails, others compensate
5. **Knowledge persistence**: Workspace survives individual context compaction
6. **Adaptability**: New roles emerge from the work
7. **Metacognition**: External review IS metacognition

### Proposed Model Risks

1. **Cost**: Multiple LLM calls per decision = higher token usage
2. **Latency**: Coordination takes time, especially review loops
3. **Complexity**: Harder to debug, harder to understand flow
4. **Orchestrator quality**: Single point of failure for team management
5. **Over-engineering**: Simple tasks may not benefit from team approach
6. **Infinite deliberation**: Without convergence pressure, team may loop forever

---

## The Gap Analysis

What must change to go from current to proposed:

### New Components Required

| Component                | Purpose                                          | Complexity                                  |
| ------------------------ | ------------------------------------------------ | ------------------------------------------- |
| **Workspace**            | Shared structured artifact for team state        | Medium - new data model + CRUD              |
| **Orchestrator**         | Meta-agent for team management                   | High - new prompt design + decision logic   |
| **Conversation Graph**   | Multi-directional message passing between agents | Medium - extend MessageV2 with from/to/type |
| **Review Protocol**      | Structured critique/revision loops               | Medium - new interaction pattern            |
| **Role Templates**       | Library of specialist prompts                    | Low - prompt engineering                    |
| **Sharing Strategy**     | Pluggable context distribution                   | Medium - interface + 3 implementations      |
| **Convergence Protocol** | Prevents infinite deliberation                   | Medium - phase budgets + escalation rules   |

### Existing Components to Modify

| Component              | Modification                                  | Risk                              |
| ---------------------- | --------------------------------------------- | --------------------------------- |
| `Session` model        | Add `TeamSession` alongside existing          | Low - new parallel system         |
| `MessageV2`            | Add `from`, `to`, `type`, `references` fields | Low - additive only               |
| `Agent` definitions    | Add `relationships`, `workspace_permissions`  | Low - extend existing schema      |
| `SessionPrompt.loop()` | Orchestrator loop wraps existing agent loops  | Medium - new coordination layer   |
| `SessionCompaction`    | Per-agent + workspace-level summarization     | Medium - new compaction targets   |
| `Plugin hooks`         | Add team-level events                         | Low - extend existing hook system |

### Existing Components Unchanged

| Component         | Why No Change                                            |
| ----------------- | -------------------------------------------------------- |
| `Tool` system     | Tools work the same regardless of which agent calls them |
| `Provider` system | LLM infrastructure is agent-agnostic                     |
| `Snapshot` system | File tracking is independent of agent architecture       |
| `PermissionNext`  | Permission evaluation works per-agent already            |
| `Truncation`      | Tool output limits apply regardless                      |
| `Memory` (RAG)    | Long-term memory is project-scoped, not agent-scoped     |

---

## Key Insight

The current architecture is an excellent **single-agent system** -- arguably one of the best, given its sophisticated working memory management and inner speech mechanisms. The proposed architecture doesn't replace it; it **wraps it**. Each agent in the team still uses the existing `SessionPrompt.loop()`, tools, permissions, and memory. The new layer adds coordination, communication, and review on top.

The right analogy: the current system is a skilled individual developer. The proposed system puts that developer on a team. The developer's skills don't change -- but the team produces better work than the developer alone, because different perspectives catch different problems.
