# Implementation Plan: Dynamic Cognitive Team Model

> Incremental implementation plan for building the multi-agent team system as a
> new parallel mode alongside OpenCode's existing single-agent architecture.

**Date**: 2026-02-20
**Approach**: New parallel system (team mode) coexisting with existing single-agent mode
**Integration**: `/team` command activates team mode; existing behavior unchanged

---

## Table of Contents

1. [Implementation Strategy](#implementation-strategy)
2. [Milestone 1: Foundation](#milestone-1-foundation)
3. [Milestone 2: Review Protocol](#milestone-2-review-protocol)
4. [Milestone 3: Dynamic Role Spawning](#milestone-3-dynamic-role-spawning)
5. [Milestone 4: Sharing Strategy Interface](#milestone-4-sharing-strategy-interface)
6. [Milestone 5: Integration and Polish](#milestone-5-integration-and-polish)
7. [File Structure](#file-structure)
8. [Database Migrations](#database-migrations)
9. [Testing Strategy](#testing-strategy)
10. [Risk Mitigation](#risk-mitigation)
11. [Open Questions](#open-questions)

---

## Implementation Strategy

### Principles

1. **Incremental delivery**: Each milestone is independently valuable and testable
2. **Zero regression**: Existing single-agent mode is never modified; team mode is additive
3. **Reuse maximally**: Every agent in the team uses existing `SessionPrompt.loop()`, tools, permissions
4. **Test actual behavior**: Integration tests run real agent flows, not mocked logic
5. **Ship early**: Milestone 1 alone (Orchestrator + 2 fixed roles) is useful

### Dependency Order

```
Milestone 1: Foundation
  |-- Workspace data model
  |-- TeamSession management
  |-- Orchestrator agent
  |-- Basic agent execution (reusing SessionPrompt)
  |-- Two fixed roles: Architect + Developer
  |
  v
Milestone 2: Review Protocol
  |-- ReviewThread data model
  |-- Review loop logic
  |-- Critique/revision agent instructions
  |
  v
Milestone 3: Dynamic Role Spawning
  |-- Role template library
  |-- Spawn signal detection
  |-- Agent lifecycle management
  |
  v
Milestone 4: Sharing Strategy Interface
  |-- Strategy interface definition
  |-- SelectiveSharingStrategy implementation
  |-- HierarchicalSharingStrategy implementation
  |-- BroadcastSharingStrategy implementation
  |
  v
Milestone 5: Integration and Polish
  |-- /team command
  |-- CLI UI for team activity
  |-- Plugin hooks for team events
  |-- Documentation
```

---

## Milestone 1: Foundation

**Goal**: Prove the basic loop works -- Orchestrator assigns work, agents execute, workspace tracks state.

### Deliverables

#### 1.1 Database Schema

Create migration for new tables:

- `team_session` -- wraps multiple agent sessions
- `workspace` -- shared structured artifact (section-based)
- `agent_instance` -- dynamic roster entries
- `team_message` -- conversation graph

See [04-dynamic-cognitive-team-model.md](./04-dynamic-cognitive-team-model.md#data-model) for full schema.

**File**: `src/team/team.sql.ts` (Drizzle schema)
**Migration**: `bun run db generate --name team-session`

#### 1.2 Workspace Module

```
src/team/workspace.ts
```

CRUD operations for workspace sections:

- `Workspace.create(teamSessionID, goal)` -- initialize with goal + empty sections
- `Workspace.get(teamSessionID, section)` -- read a section
- `Workspace.update(teamSessionID, section, content, updatedBy)` -- write with optimistic concurrency
- `Workspace.summary(teamSessionID)` -- generate a text summary of all sections
- `Workspace.addDecision(teamSessionID, decision)` -- append to decisions section
- `Workspace.addQuestion(teamSessionID, question)` -- append to questions section
- `Workspace.getOpenQuestions(teamSessionID)` -- filter unanswered questions

#### 1.3 Agent Roster Module

```
src/team/roster.ts
```

Agent instance lifecycle:

- `Roster.spawn(teamSessionID, role, prompt, config)` -- create agent instance + underlying OpenCode session
- `Roster.retire(agentInstanceID)` -- mark retired
- `Roster.get(teamSessionID, role)` -- find agent by role
- `Roster.list(teamSessionID)` -- all active agents
- `Roster.updateStatus(agentInstanceID, status)` -- track idle/working/waiting

#### 1.4 Conversation Graph Module

```
src/team/message.ts
```

Team message operations:

- `TeamMessage.send(from, to, type, content, references?, mutations?)` -- send message
- `TeamMessage.list(teamSessionID, filters?)` -- query messages
- `TeamMessage.recent(teamSessionID, limit)` -- latest messages for Orchestrator context

#### 1.5 Orchestrator Module

```
src/team/orchestrator.ts
src/team/prompt/orchestrator.txt
```

The meta-agent that manages the team:

- `Orchestrator.run(teamSession)` -- the main orchestrator loop
- `Orchestrator.assess(workspace, roster)` -- determine next action
- `Orchestrator.staffTeam(goal, workspace)` -- initial team composition decision
- `Orchestrator.routeQuestion(question, roster)` -- route to appropriate agent

The Orchestrator uses an underlying OpenCode session (with a dedicated system prompt) for its LLM calls. Its output is parsed as structured JSON actions.

#### 1.6 Agent Execution Bridge

```
src/team/execute.ts
```

Bridge between team model and existing `SessionPrompt`:

- `Execute.runAgent(agentInstance, task, context)` -- build message with workspace context, call `SessionPrompt.prompt()`, parse output for workspace mutations
- `Execute.buildAgentMessage(task, context)` -- construct the user message with team instructions
- `Execute.parseAgentOutput(result)` -- extract proposals, questions, concerns, completion signals from agent output

#### 1.7 Team Session Module

```
src/team/index.ts
```

Top-level entry point:

- `Team.create(goal)` -- create team session + workspace + start orchestrator
- `Team.get(teamSessionID)` -- fetch team session state
- `Team.cancel(teamSessionID)` -- abort all agent sessions

#### 1.8 Two Fixed Roles

Initial role templates:

- `src/team/prompt/architect.txt`
- `src/team/prompt/developer.txt`

Simple prompt files following the patterns in [04-dynamic-cognitive-team-model.md](./04-dynamic-cognitive-team-model.md#role-template-library).

### Validation

- [ ] Orchestrator can decompose a task into work items
- [ ] Architect agent produces a design proposal in workspace
- [ ] Developer agent reads design from workspace and produces code
- [ ] Workspace tracks all artifacts and decisions
- [ ] End-to-end: user request -> team completes -> result presented

---

## Milestone 2: Review Protocol

**Goal**: Architect reviews Developer output. Back-and-forth until approval.

### Deliverables

#### 2.1 Review Thread Module

```
src/team/review.ts
```

- `Review.create(teamSessionID, author, reviewer, artifactRef)` -- open review
- `Review.addCritique(threadID, content)` -- reviewer submits critique
- `Review.addRevision(threadID, content)` -- author submits revision
- `Review.approve(threadID)` -- reviewer approves
- `Review.escalate(threadID)` -- exceeded round limit, send to Orchestrator

#### 2.2 Review Loop Logic

```
src/team/review-loop.ts
```

The `reviewLoop()` function as described in the design doc:

- Run reviewer agent with artifact + criteria
- If approved, record decision and return
- If not, run author agent with critique
- Loop up to 3 rounds
- Escalate to Orchestrator on non-convergence

#### 2.3 Review Role Prompts

- `src/team/prompt/reviewer-instructions.txt` -- injected into reviewer context
- `src/team/prompt/revision-instructions.txt` -- injected into author context during revision

#### 2.4 Orchestrator Review Triggering

Update Orchestrator to:

- Detect when an artifact is ready for review (agent signals [COMPLETE])
- Determine appropriate reviewer based on artifact type
- Trigger review loop
- Handle escalation from review loops

### Validation

- [ ] Architect reviews Developer's implementation
- [ ] Review thread has back-and-forth critique/revision
- [ ] Review converges within 3 rounds for straightforward cases
- [ ] Non-convergence escalates to Orchestrator
- [ ] Orchestrator can mediate and force a decision

---

## Milestone 3: Dynamic Role Spawning

**Goal**: Orchestrator can create new agents when expertise gaps are discovered.

### Deliverables

#### 3.1 Role Template Library

```
src/team/prompt/qa.txt
src/team/prompt/security-reviewer.txt
src/team/prompt/performance-specialist.txt
src/team/prompt/database-specialist.txt
src/team/prompt/devops.txt
src/team/prompt/ux-reviewer.txt
src/team/prompt/documentation-writer.txt
```

Each template follows the pattern: identity + responsibilities + communication protocol + workspace permissions.

#### 3.2 Role Registry

```
src/team/roles.ts
```

- `Roles.list()` -- all available role templates
- `Roles.get(name)` -- fetch specific role template
- `Roles.match(signal)` -- given a signal string, suggest appropriate role

#### 3.3 Spawn Signal Detection

Update `Execute.parseAgentOutput()` to detect spawn signals:

- Explicit: `[SPAWN: role_name]` in agent output
- Implicit: Pattern matching on agent concerns (security, performance, etc.)
- Orchestrator evaluates signals before spawning (cost/benefit check)

#### 3.4 Agent Lifecycle

Update `Roster` module:

- Track agent lifecycle: spawned -> working -> idle -> retired
- Retirement criteria: no assigned tasks, no pending reviews, Orchestrator decides
- Metrics: steps used, tokens consumed, contributions to workspace

### Validation

- [ ] Developer encounters a security concern, signals for help
- [ ] Orchestrator evaluates and spawns Security Reviewer
- [ ] Security Reviewer integrates into team, reviews relevant artifacts
- [ ] Security Reviewer is retired after review is complete
- [ ] Orchestrator doesn't spawn unnecessarily for minor concerns

---

## Milestone 4: Sharing Strategy Interface

**Goal**: Make context sharing pluggable so different strategies can be tested.

### Deliverables

#### 4.1 Strategy Interface

```
src/team/sharing/strategy.ts
```

```typescript
interface SharingStrategy {
  buildContext(agent, workspace, recentMessages): AgentContext
  propagate(source, output, workspace, roster): PropagationResult
  summarize(workspace): WorkspaceSummary
}
```

#### 4.2 SelectiveSharingStrategy

```
src/team/sharing/selective.ts
```

- Agent sees: own workspace slice + summary + relevant review threads
- Propagation: update workspace, notify addressed agents
- Summary: LLM-generated, cached, refreshed on major changes

#### 4.3 HierarchicalSharingStrategy

```
src/team/sharing/hierarchical.ts
```

- Agent sees: only what Orchestrator included in assignment
- Propagation: all output goes to Orchestrator
- Summary: Orchestrator maintains manually

#### 4.4 BroadcastSharingStrategy

```
src/team/sharing/broadcast.ts
```

- Agent sees: full workspace (truncated if needed)
- Propagation: all agents notified of all changes
- Summary: not needed (everyone sees everything)

#### 4.5 Configuration

Add to `opencode.json` config schema:

```json
{
  "team": {
    "sharing": {
      "strategy": "selective",
      "options": { ... }
    }
  }
}
```

### Validation

- [ ] Same task produces comparable results with each strategy
- [ ] Selective strategy uses fewer tokens than broadcast
- [ ] Hierarchical strategy gives Orchestrator maximum control
- [ ] Strategy can be switched via config without code changes

---

## Milestone 5: Integration and Polish

**Goal**: Seamless user experience with team mode as a first-class feature.

### Deliverables

#### 5.1 /team Command

```
src/command/team.ts
```

- `/team <description>` -- start team session for the given task
- `/team status` -- show current team state
- `/team roster` -- show active agents
- `/team workspace` -- show workspace summary
- `/team cancel` -- abort team session

#### 5.2 CLI UI

Update `src/cli/` to display team activity:

- Agent status indicators (working, reviewing, idle)
- Review thread progress
- Workspace decision log
- Orchestrator action feed
- Escalation prompts for user input

#### 5.3 Plugin Hooks

```
src/team/hooks.ts
```

New events for plugin system:

- `team.created`, `team.completed`, `team.phase_changed`
- `team.agent.spawned`, `team.agent.retired`
- `team.message`, `team.decision`
- `team.review.started`, `team.review.completed`
- `team.escalated`

#### 5.4 Documentation

- User-facing docs for team mode
- Architecture documentation
- Role template authoring guide

### Validation

- [ ] `/team` command works end-to-end from CLI
- [ ] User can observe team activity in real time
- [ ] User can respond to escalations
- [ ] Existing single-agent mode is completely unaffected
- [ ] Plugin hooks fire correctly for team events

---

## File Structure

```
src/team/
  index.ts              -- TeamSession namespace (create, get, cancel)
  team.sql.ts           -- Drizzle schema (team_session, workspace, agent_instance, team_message, review_thread)
  workspace.ts          -- Workspace CRUD
  roster.ts             -- Agent instance lifecycle
  message.ts            -- Team message graph
  orchestrator.ts       -- Orchestrator meta-agent loop
  execute.ts            -- Bridge to SessionPrompt.loop()
  review.ts             -- Review thread management
  review-loop.ts        -- Review loop logic
  roles.ts              -- Role template registry
  hooks.ts              -- Team-level plugin hooks
  sharing/
    strategy.ts         -- SharingStrategy interface
    selective.ts        -- Selective sharing implementation
    hierarchical.ts     -- Hierarchical sharing implementation
    broadcast.ts        -- Broadcast sharing implementation
  prompt/
    orchestrator.txt    -- Orchestrator system prompt
    architect.txt       -- Architect role template
    developer.txt       -- Developer role template
    qa.txt              -- QA Engineer role template
    security-reviewer.txt
    performance-specialist.txt
    database-specialist.txt
    devops.txt
    ux-reviewer.txt
    documentation-writer.txt
    reviewer-instructions.txt  -- Injected during review
    revision-instructions.txt  -- Injected during revision
```

---

## Database Migrations

### Migration 1: Team Foundation (Milestone 1)

```
bun run db generate --name team-session
```

Creates: `team_session`, `workspace`, `agent_instance`, `team_message`

### Migration 2: Review Threads (Milestone 2)

```
bun run db generate --name review-thread
```

Creates: `review_thread`

### Migration 3: Role Metadata (Milestone 3)

```
bun run db generate --name agent-role-metadata
```

Adds: `role_template` column to `agent_instance`, tracking columns for spawn signals

---

## Testing Strategy

### Unit Tests

- Workspace CRUD operations
- Roster lifecycle (spawn, retire, status transitions)
- Team message graph queries
- Review thread state machine
- Sharing strategy implementations
- Agent output parsing (extracting proposals, questions, signals)

### Integration Tests

- Orchestrator decomposes a task and assigns to agents
- Agent reads workspace and produces output
- Review loop runs to completion (approval or escalation)
- Dynamic spawning triggers correctly
- Sharing strategies produce different context sizes
- End-to-end: simple task (bug fix with Developer + QA)
- End-to-end: complex task (feature with Architect + Developer + Security + QA)

### Not Mocked

Following the project's testing philosophy ("Avoid mocks as much as possible"):

- Tests use actual LLM calls (or a test provider)
- Tests use actual SQLite database
- Tests run actual `SessionPrompt.loop()` for agent execution

---

## Risk Mitigation

| Risk                                                               | Probability | Impact | Mitigation                                                                                                         |
| ------------------------------------------------------------------ | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| Orchestrator makes poor staffing decisions                         | Medium      | High   | Start with simple heuristics, refine prompt iteratively. Allow user override.                                      |
| Agents produce output that's hard to parse for workspace mutations | Medium      | Medium | Structured output format with fallback to free-text. Robust parsing with error tolerance.                          |
| Cost explosion from multiple LLM calls                             | High        | Medium | Budget limits per phase. Selective sharing reduces per-agent context size. Small model for Orchestrator decisions. |
| Infinite review loops                                              | Low         | Medium | Hard limit of 3 rounds. Orchestrator mediation as escape valve.                                                    |
| Team mode slower than single agent for simple tasks                | High        | Low    | Only activate team mode for tasks that benefit from it. `/team` is opt-in.                                         |
| Context overflow in individual agents                              | Medium      | Medium | Per-agent compaction using existing infrastructure. Workspace persists independently.                              |

---

## Open Questions

1. **Orchestrator model selection**: Should the Orchestrator use a small/fast model (since it's making routing decisions, not domain work) or the same model as other agents?

2. **Agent session reuse**: Should an agent's OpenCode session persist across multiple task assignments from the Orchestrator, or should each assignment get a fresh session?

3. **User visibility**: How much of the inter-agent communication should the user see in real time? All of it (transparent but noisy) or summaries (clean but opaque)?

4. **Workspace persistence**: Should workspaces persist across user sessions? If the user comes back tomorrow, can they resume a team session?

5. **Cost reporting**: How should token/cost usage be reported for team sessions? Per-agent breakdown? Total only?

6. **Hybrid mode**: Should the system auto-detect when team mode would be beneficial, or always require explicit `/team` activation?

7. **Agent model heterogeneity**: Should different roles use different models? (e.g., Architect uses Claude Opus, Developer uses Claude Sonnet, QA uses a smaller model)
