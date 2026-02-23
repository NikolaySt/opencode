# Dynamic Cognitive Team Model: Design Document

> A comprehensive design for transforming OpenCode from a single-agent architecture into
> a dynamic multi-agent collaborative system, modeled on how real human teams think and
> work together.

**Date**: 2026-02-20
**Status**: Design / Brainstorm
**Decision**: New parallel system alongside existing single-agent mode
**Sharing Strategy**: Selective sharing with pluggable strategy interface

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Core Abstractions](#core-abstractions)
3. [The Workspace](#the-workspace)
4. [The Agent Roster](#the-agent-roster)
5. [The Conversation Graph](#the-conversation-graph)
6. [The Orchestrator](#the-orchestrator)
7. [The Sharing Strategy Interface](#the-sharing-strategy-interface)
8. [The Review Protocol](#the-review-protocol)
9. [Dynamic Role Emergence](#dynamic-role-emergence)
10. [Convergence Protocol](#convergence-protocol)
11. [Role Template Library](#role-template-library)
12. [End-to-End Example Flow](#end-to-end-example-flow)
13. [Data Model](#data-model)
14. [Orchestrator Loop Pseudocode](#orchestrator-loop-pseudocode)
15. [Agent Turn Execution](#agent-turn-execution)
16. [Integration with Existing OpenCode](#integration-with-existing-opencode)

---

## Design Principles

1. **Grounded in cognitive science**: Every mechanism maps to an established model of human team cognition (Hutchins' distributed cognition, Wegner's transactive memory, Vygotsky's social speech).

2. **Dynamic, not static**: Roles emerge from the work. The system starts minimal and grows as complexity demands. A simple bug fix might need only Developer + QA. A new feature might spawn Architect + Developer + Security Reviewer + QA.

3. **Workspace-mediated**: Agents communicate through a shared structured workspace, not direct message passing. This provides peripheral awareness (agents can observe others' work) without overwhelming individual contexts.

4. **Productive tension**: Disagreement between agents is a feature, not a bug. The review protocol creates deliberate friction that improves quality.

5. **Pluggable sharing**: The context-sharing strategy is a first-class abstraction that can be swapped without changing the rest of the system.

6. **Wraps, doesn't replace**: Each agent in the team still uses OpenCode's existing `SessionPrompt.loop()`, tools, permissions, and memory. The team layer adds coordination on top.

7. **Convergence guaranteed**: Every phase has a budget, every review loop has a limit, and the Orchestrator can force decisions. Infinite deliberation is architecturally prevented.

---

## Core Abstractions

Four new abstractions define the team model:

```
+-- TeamSession ------------------------------------------------+
|                                                                |
|  +-- Workspace (shared mental model) ------+                   |
|  |  goal, constraints, plan, artifacts,     |                   |
|  |  decisions, open_questions, reviews      |                   |
|  +------------------------------------------+                   |
|                                                                |
|  +-- Roster (dynamic team) ----------------+                   |
|  |  AgentInstance[]                         |                   |
|  |  (role, prompt, context, expertise,      |                   |
|  |   relationships, permissions)            |                   |
|  +------------------------------------------+                   |
|                                                                |
|  +-- ConversationGraph (multi-directional) +                   |
|  |  TeamMessage[]                           |                   |
|  |  (from, to, type, content, references)   |                   |
|  +------------------------------------------+                   |
|                                                                |
|  +-- Orchestrator (the manager brain) -----+                   |
|  |  assess, assign, detect, escalate, spawn |                   |
|  +------------------------------------------+                   |
|                                                                |
+----------------------------------------------------------------+
```

---

## The Workspace

The workspace replaces the flat conversation history as the shared mental model. It is a **structured, persistent artifact** that all agents can read and write to:

```typescript
interface Workspace {
  id: string
  teamSessionID: string

  // What we're trying to achieve
  goal: string
  constraints: Constraint[]

  // The evolving plan
  plan: {
    status: "draft" | "in_review" | "approved" | "in_progress" | "complete"
    architecture?: string // design decisions
    tasks: Task[] // decomposed work items
    dependencies: Dependency[] // task ordering constraints
  }

  // What's been built
  artifacts: Map<string, Artifact> // code, docs, configs

  // Recorded decisions (with rationale and alternatives considered)
  decisions: Decision[]

  // Unresolved questions needing routing
  openQuestions: Question[]

  // Active critique/response chains
  reviewThreads: ReviewThread[]

  // Per-agent state summaries (for workspace summary generation)
  agentStates: Map<string, AgentStateSummary>
}

interface Decision {
  id: string
  description: string
  rationale: string
  alternatives: string[] // what was considered and rejected
  madeBy: string // agent role
  reviewedBy?: string[] // agents who reviewed
  status: "proposed" | "approved" | "rejected"
  timestamp: number
}

interface Question {
  id: string
  question: string
  askedBy: string // agent role
  routedTo?: string // agent role or "user"
  answer?: string
  answeredBy?: string
  status: "open" | "answered" | "escalated"
}

interface ReviewThread {
  id: string
  artifactRef: string // what's being reviewed
  author: string // who created the artifact
  reviewer: string // who's reviewing
  messages: ReviewMessage[] // critique/response chain
  status: "active" | "approved" | "needs_revision" | "escalated"
  round: number // current review round
}
```

**Key design choice**: The workspace is NOT a conversation. It is a **structured document** with typed sections. This is critical -- it means agents interact with _organized knowledge_, not a stream of text.

---

## The Agent Roster

The roster tracks all active agents with their capabilities and relationships:

```typescript
interface AgentInstance {
  id: string
  role: string // "architect", "developer", "qa", etc.
  prompt: string // role-specific system prompt
  sessionID: string // links to existing OpenCode session for LLM calls
  expertise: string[] // what this agent knows about
  status: "idle" | "working" | "waiting" | "retired"

  // What workspace sections this agent can access
  workspacePermissions: {
    read: string[] // e.g. ["goal", "constraints", "plan", "decisions"]
    write: string[] // e.g. ["plan.architecture", "decisions", "open_questions"]
  }

  // Relationship graph
  relationships: {
    reportsTo?: string // who assigns work
    collaboratesWith: string[] // peer agents
    reviews: string[] // who this agent reviews
    reviewedBy: string[] // who reviews this agent's work
  }

  // Resource tracking
  metrics: {
    stepsUsed: number
    tokensConsumed: number
    lastActiveTime: number
  }
}
```

**Dynamic lifecycle**: Agents are created by the Orchestrator when work demands, and retired when their contribution is complete. The roster grows and shrinks organically.

---

## The Conversation Graph

Messages between agents form a directed graph, not a linear stream:

```typescript
interface TeamMessage {
  id: string
  teamSessionID: string
  fromRole: string // "architect", "developer", "orchestrator", "user"
  toRole: string | null // null = broadcast to all agents
  type: MessageType
  content: string
  references: string[] // IDs of messages this responds to
  workspaceMutations: Mutation[] // what workspace sections this changes
  timestamp: number
}

type MessageType =
  | "proposal" // Agent proposes a design/approach
  | "critique" // Agent critiques another's work
  | "question" // Agent asks another agent or user
  | "answer" // Response to a question
  | "decision" // Orchestrator or agent records a decision
  | "handoff" // Work assignment from Orchestrator
  | "status" // Agent reports progress
  | "artifact" // Agent delivers completed work
  | "spawn_request" // Agent requests a new specialist be added
  | "escalation" // Problem escalated to Orchestrator or user

interface Mutation {
  section: string // workspace section being modified
  operation: "set" | "append" | "update" | "remove"
  path: string // dot-notation path within section
  value: unknown
}
```

---

## The Orchestrator

The meta-agent that manages the team. It does NOT do domain work -- it manages people and process.

### Orchestrator System Prompt

```
You are a technical project lead managing a team of AI specialists working on
a software engineering task. Your job is NOT to write code, design systems, or
review implementations. Your job is to manage the team.

## Your Responsibilities

1. UNDERSTAND the user's request and decompose it into clear work items
2. STAFF the team by deciding which specialist roles are needed
3. ASSIGN work to the right specialists with clear instructions
4. MONITOR progress by reading workspace state and agent status reports
5. ROUTE questions to the right specialist when agents need help
6. DETECT stalls, conflicts, or gaps and intervene
7. TRIGGER reviews at appropriate checkpoints
8. ESCALATE to the user when the team cannot resolve something
9. SPAWN new specialist roles when expertise gaps are discovered
10. CONVERGE by forcing decisions when deliberation has run long enough

## Decision Framework

### Team Composition
- Simple bug fix: Developer + QA (2 agents)
- Feature addition: Architect + Developer + QA (3 agents)
- Security-sensitive: add Security Reviewer
- Performance-critical: add Performance Specialist
- Database changes: add Database Specialist
- Large refactor: add Refactoring Specialist
- Start minimal. You can always add agents later.

### When to Intervene
- An agent writes to open_questions --> route the question
- A review thread exceeds 3 rounds --> mediate or escalate
- An agent hasn't reported status in N steps --> check if stuck
- Two agents write conflicting decisions --> resolve conflict
- All assigned tasks are complete --> trigger next phase
- Context budget for any agent exceeds 70% --> trigger compaction

### When to Escalate to User
- The team disagrees on a fundamental approach and cannot converge
- The task requirements are ambiguous
- A decision is irreversible and high-stakes
- The user explicitly asked to be consulted

### When to Spawn a New Agent
- An agent says "I'm not sure about the security implications" --> Security Reviewer
- An agent says "this is slow" or "performance concern" --> Performance Specialist
- Multiple agents reference an unfamiliar subsystem --> Domain Specialist
- A review reveals a knowledge gap --> appropriate expert

## Output Format

For each turn, output a structured action:
{
  "type": "assign_task" | "spawn_agent" | "retire_agent" | "mediate" |
          "escalate_to_user" | "advance_phase" | "complete" | "route_message",
  "target": "<agent role or 'user'>",
  "content": "<instructions or message>",
  ... type-specific fields
}
```

### Orchestrator's Four Decision Types

**1. Team Composition**: Given a task, who do we need?

**2. Work Assignment**: Who does what, in what order? The Orchestrator models task dependencies:

```
[Explore codebase] --> [Design approach] --> [Review design]
                              |                     |
                              v                     v
                    [Implement module A]    [Approved design]
                    [Implement module B]
                              |
                              v
                      [QA verification]
```

**3. Intervention**: When does the Orchestrator step in? Signals: open_questions, review loops > 3 rounds, stalled agents, conflicting decisions, phase completion.

**4. Dynamic spawning**: When does a new role emerge? Signals: uncertainty expressions, performance concerns, unfamiliar subsystem references, review-revealed gaps.

---

## The Sharing Strategy Interface

Pluggable context distribution, switchable via configuration:

```typescript
interface SharingStrategy {
  // What does this agent see when it starts a turn?
  buildContext(params: { agent: AgentInstance; workspace: Workspace; recentMessages: TeamMessage[] }): AgentContext

  // After an agent produces output, what gets shared?
  propagate(params: {
    source: AgentInstance
    output: AgentOutput
    workspace: Workspace
    roster: AgentInstance[]
  }): PropagationResult

  // How is the workspace summary maintained?
  summarize(workspace: Workspace): WorkspaceSummary
}
```

### Three Implementations

**SelectiveSharingStrategy** (recommended default):

- `buildContext`: Agent's workspace slice + workspace summary + relevant review threads
- `propagate`: Update workspace, notify directly addressed agents
- `summarize`: LLM-generated structured summary, cached, refreshed on major changes

**HierarchicalSharingStrategy**:

- `buildContext`: Only what Orchestrator explicitly included in the assignment
- `propagate`: All output goes to Orchestrator, who decides distribution
- `summarize`: Orchestrator maintains summary manually

**BroadcastSharingStrategy**:

- `buildContext`: Full workspace (truncated/compacted if needed)
- `propagate`: All agents notified of all changes
- `summarize`: No separate summary needed

### Configuration

```json
{
  "team": {
    "sharing": {
      "strategy": "selective",
      "options": {
        "summaryRefreshThreshold": 5,
        "maxContextPerAgent": 0.7,
        "includeReviewThreads": true,
        "includeDecisionHistory": true
      }
    }
  }
}
```

---

## The Review Protocol

The mechanism for productive disagreement between agents:

```
function reviewLoop(author, reviewer, artifact, workspace):
  maxRounds = 3
  round = 0

  while round < maxRounds:
    // Reviewer critiques
    critique = runAgent(reviewer, {
      type: "review",
      artifact: artifact,
      criteria: workspace.decisions,
      instruction: "Be specific. For each issue: what's wrong, why it
                    matters, and what you'd suggest instead.
                    If the work meets all criteria, approve it."
    })

    if critique.approved:
      workspace.addDecision("Approved by " + reviewer.role)
      return artifact

    // Author revises
    revision = runAgent(author, {
      type: "revise",
      artifact: artifact,
      critique: critique,
      instruction: "Address each critique point. If you disagree with
                    a critique, explain why with evidence.
                    Don't silently ignore feedback."
    })

    artifact = revision.updatedArtifact
    round++

  // If no convergence after maxRounds, escalate
  orchestrator.mediate(author, reviewer, artifact, allCritiques)
```

### Review Types

| Review Type   | Author    | Reviewer                                  | Focus                                       |
| ------------- | --------- | ----------------------------------------- | ------------------------------------------- |
| Design review | Architect | Security Reviewer, Performance Specialist | Approach correctness, security, performance |
| Code review   | Developer | Architect, QA                             | Implementation quality, adherence to design |
| Test review   | QA        | Developer                                 | Test coverage, edge cases, validity         |
| Final review  | Any       | Orchestrator                              | Completeness, requirement satisfaction      |

---

## Dynamic Role Emergence

Roles are not predefined -- they emerge from the work:

### Trigger Signals

| Signal in Agent Output                   | Spawned Role           | Prompt Focus                                   |
| ---------------------------------------- | ---------------------- | ---------------------------------------------- |
| "security implications", "vulnerability" | Security Reviewer      | OWASP, auth patterns, data protection          |
| "slow", "performance", "latency"         | Performance Specialist | Profiling, optimization, caching               |
| "database", "migration", "schema"        | Database Specialist    | Schema design, migrations, query optimization  |
| "deploy", "CI/CD", "infrastructure"      | DevOps Specialist      | Deployment, pipelines, infrastructure          |
| "unclear requirements", "ambiguous"      | Requirements Analyst   | Clarification, user story decomposition        |
| "test", "coverage", "edge case"          | QA Engineer            | Testing strategy, test implementation          |
| "API design", "endpoint", "contract"     | API Designer           | REST/GraphQL design, versioning, documentation |
| "UI", "user experience", "accessibility" | UX Reviewer            | Usability, accessibility, design patterns      |
| "documentation", "README"                | Documentation Writer   | Technical writing, API docs                    |

### Spawn Decision Process

The Orchestrator doesn't blindly spawn on every keyword. It evaluates:

1. **Is this a genuine gap?** Does the signal indicate actual missing expertise, or can the existing team handle it?
2. **Is it worth the cost?** Adding an agent adds coordination overhead. For minor concerns, the existing agent may handle it.
3. **Is there a natural fit?** Could an existing agent's role be expanded instead of spawning new?
4. **Budget check**: Is there room in the step/token budget for another agent?

---

## Convergence Protocol

Prevents infinite deliberation:

### Phase Budgets

Each phase has a maximum step budget:

| Phase          | Default Budget             | Escalation              |
| -------------- | -------------------------- | ----------------------- |
| Understanding  | 10 steps across all agents | Force to Design phase   |
| Design         | 15 steps across all agents | Force to Implementation |
| Implementation | 30 steps across all agents | Force to Verification   |
| Verification   | 15 steps across all agents | Force to Complete       |

### Review Loop Limits

- Maximum 3 rounds per review thread
- After 3 rounds without approval: Orchestrator mediates
- Orchestrator mediation: read both positions, make a decision, record rationale in workspace

### Diminishing Returns Detection

If workspace mutations are shrinking (less new information per exchange), the Orchestrator triggers convergence:

```
if (last3Mutations.every(m => m.content.length < averageMutationSize * 0.3)):
  forceConvergence()
```

### Escalation to User

When the team cannot converge:

- Present both positions clearly
- Show the evidence for each
- Ask the user to decide
- Record the decision with "user-decided" attribution

---

## Role Template Library

### Architect

```
You are a software architect. Your expertise is in system design, pattern selection,
and technical decision-making.

Your responsibilities:
- Analyze the codebase structure and existing patterns
- Propose architectural approaches for the given task
- Define interfaces and contracts between components
- Make and justify technical decisions
- Review implementation for adherence to design

You communicate through the workspace:
- Write proposals to workspace.plan.architecture
- Record decisions to workspace.decisions (always include rationale + alternatives)
- Read other agents' findings from workspace.artifacts
- Respond to critiques in review threads with evidence

When you're uncertain about an aspect outside your expertise, write to
workspace.openQuestions with a clear question and suggest which specialist
should answer.
```

### Developer

```
You are a software developer. Your expertise is in writing clean, correct,
well-tested code.

Your responsibilities:
- Implement the tasks assigned to you following the approved design
- Write code that follows existing codebase patterns and conventions
- Handle edge cases and error conditions
- Write tests for your implementations
- Address review feedback with code changes

You communicate through the workspace:
- Read the approved plan from workspace.plan
- Read assigned tasks from your handoff message
- Write completed code as artifacts
- Ask questions via workspace.openQuestions when requirements are unclear
- Respond to review critiques with revisions

If you encounter issues outside your expertise (security concerns, performance
problems, database design questions), write to workspace.openQuestions rather
than guessing.
```

### QA Engineer

```
You are a QA engineer. Your expertise is in testing, verification, and
quality assurance.

Your responsibilities:
- Review implemented code against the approved design
- Write tests that cover normal cases, edge cases, and error cases
- Verify that security requirements are met
- Check for common bugs, race conditions, and error handling gaps
- Verify that existing tests still pass

You communicate through the workspace:
- Read the approved plan from workspace.plan
- Read implemented code from workspace.artifacts
- Write test code as artifacts
- File issues via review threads (be specific: what's wrong, why, suggested fix)
- Approve or reject implementation in review status

Be rigorous but pragmatic. Focus on issues that affect correctness, security,
and maintainability. Don't block on style preferences.
```

### Security Reviewer

```
You are a security specialist. Your expertise is in identifying
vulnerabilities and ensuring secure coding practices.

Your responsibilities:
- Review designs for security implications (OWASP Top 10, auth patterns)
- Review code for common vulnerabilities (injection, XSS, CSRF, etc.)
- Evaluate authentication and authorization implementations
- Check data handling (encryption, storage, transmission)
- Verify input validation and output encoding

You communicate through the workspace:
- Read proposals from workspace.plan.architecture
- Read code from workspace.artifacts
- Write security findings to review threads with severity ratings
- Propose mitigations, not just identify problems

Rate findings: CRITICAL (must fix), HIGH (should fix), MEDIUM (consider),
LOW (informational).
```

### Performance Specialist

```
You are a performance engineer. Your expertise is in optimization,
profiling, and scalable system design.

Your responsibilities:
- Analyze proposed designs for performance implications
- Review code for performance anti-patterns
- Identify bottlenecks and propose optimizations
- Evaluate data structure and algorithm choices
- Consider scalability under load

Focus on measurable impact. Don't micro-optimize unless the context
justifies it. Prefer algorithmic improvements over constant-factor tweaks.
```

---

## End-to-End Example Flow

**User request**: "Add authentication to the API"

### Phase 1: Understanding

```
Orchestrator reads request
  |
  +--> Assesses: This is a feature addition touching security.
  |     Team needed: Architect + Developer + QA + Security Reviewer
  |
  +--> Spawns Explorer (read-only, concurrent)
  |     Task: "Map existing auth-related code, middleware, user models, API structure"
  |     Writes to: workspace.artifacts["codebase_map"]
  |
  +--> Spawns Architect
        Task: "Analyze codebase map and propose auth approach"
        Reads from: workspace.artifacts["codebase_map"]
        Writes to: workspace.plan.architecture, workspace.decisions
```

### Phase 2: Design

```
Architect reads Explorer's codebase map from workspace
Architect writes proposal:
  "JWT-based auth with refresh tokens, middleware matching existing route handlers"
  Decision: "JWT over session-based because API is stateless"
  Alternative considered: "Session-based auth (rejected: doesn't match REST patterns)"
  |
  +--> Orchestrator detects proposal, triggers Security Review
  |
  +--> Security Reviewer reads proposal from workspace
  |     Critique: "CRITICAL: JWT in localStorage vulnerable to XSS.
  |                Recommend httpOnly cookies with CSRF tokens."
  |
  +--> Architect reads critique, revises:
  |     "Updated: httpOnly cookies for token storage, CSRF protection via
  |      double-submit pattern. JWT still used for token format."
  |
  +--> Security Reviewer re-reviews, approves
  |
  +--> Orchestrator records: Design approved. Advances to Implementation.
```

### Phase 3: Implementation

```
Orchestrator decomposes approved plan into tasks:
  Task A: Auth middleware (Developer)
  Task B: User model + DB migration (Developer)
  Task C: Login/register endpoints (Developer)
  Task D: Token refresh logic (Developer)
  |
  +--> Developer implements Task A (auth middleware)
  |     Writes code artifact to workspace
  |
  +--> Developer hits issue on Task B:
  |     "User model doesn't have password field. Add to existing
  |      model or create separate Credentials table?"
  |     Writes to: workspace.openQuestions
  |
  +--> Orchestrator routes question to Architect
  |
  +--> Architect answers: "Separate Credentials table. Rationale:
  |     separation of concerns, user profile != auth credentials,
  |     easier to support multiple auth methods later."
  |     Writes to: workspace.decisions
  |
  +--> Developer implements with separate Credentials table
  |
  +--> Developer completes all tasks
```

### Phase 4: Verification

```
Orchestrator detects all implementation tasks complete
  |
  +--> Spawns QA Engineer
  |     Task: "Review auth implementation against approved design.
  |            Write tests, check edge cases, verify security requirements."
  |     Reads: workspace.plan, workspace.decisions, workspace.artifacts
  |
  +--> QA reviews, files findings:
  |     "Missing: rate limiting on login endpoint"
  |     "Missing: test for expired refresh token"
  |     "Bug: middleware doesn't handle malformed JWT gracefully"
  |
  +--> Review thread opens with Developer
  |
  +--> Developer fixes all three issues
  |
  +--> QA re-verifies, approves
  |
  +--> Orchestrator: All reviews approved. Present result to user.
```

---

## Data Model

### New Tables (alongside existing OpenCode tables)

```sql
-- Team sessions (wraps multiple agent sessions)
CREATE TABLE team_session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'understanding',
  status TEXT NOT NULL DEFAULT 'active',
  sharing_strategy TEXT NOT NULL DEFAULT 'selective',
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

-- Workspace sections (the shared mental model)
CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  team_session_id TEXT NOT NULL REFERENCES team_session(id) ON DELETE CASCADE,
  section TEXT NOT NULL,             -- 'plan', 'decisions', 'questions', etc.
  content TEXT NOT NULL,             -- JSON
  last_updated_by TEXT,              -- agent role
  version INTEGER NOT NULL DEFAULT 1,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE INDEX workspace_session_section_idx ON workspace(team_session_id, section);

-- Agent instances (the dynamic roster)
CREATE TABLE agent_instance (
  id TEXT PRIMARY KEY,
  team_session_id TEXT NOT NULL REFERENCES team_session(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES session(id),  -- links to existing OpenCode session
  role TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expertise TEXT NOT NULL,           -- JSON array
  workspace_read TEXT NOT NULL,      -- JSON array of readable sections
  workspace_write TEXT NOT NULL,     -- JSON array of writable sections
  relationships TEXT NOT NULL,       -- JSON object
  status TEXT NOT NULL DEFAULT 'idle',
  steps_used INTEGER NOT NULL DEFAULT 0,
  tokens_consumed INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE INDEX agent_instance_team_idx ON agent_instance(team_session_id);

-- Team messages (the conversation graph)
CREATE TABLE team_message (
  id TEXT PRIMARY KEY,
  team_session_id TEXT NOT NULL REFERENCES team_session(id) ON DELETE CASCADE,
  from_role TEXT NOT NULL,
  to_role TEXT,                      -- null = broadcast
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  ref_ids TEXT,                      -- JSON array of referenced message IDs
  workspace_mutations TEXT,          -- JSON array of mutations
  time_created INTEGER NOT NULL
);
CREATE INDEX team_message_session_idx ON team_message(team_session_id, time_created);

-- Review threads
CREATE TABLE review_thread (
  id TEXT PRIMARY KEY,
  team_session_id TEXT NOT NULL REFERENCES team_session(id) ON DELETE CASCADE,
  artifact_ref TEXT NOT NULL,
  author_role TEXT NOT NULL,
  reviewer_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  round INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE INDEX review_thread_session_idx ON review_thread(team_session_id);
```

---

## Orchestrator Loop Pseudocode

```
function orchestratorLoop(teamSession, userGoal):
  workspace = createWorkspace(userGoal)
  roster = assessAndStaff(userGoal, workspace)

  while not done:
    // Build the Orchestrator's view
    summary = sharingStrategy.summarize(workspace)
    pendingQuestions = workspace.getOpenQuestions()
    activeReviews = workspace.getActiveReviewThreads()
    agentStatuses = roster.map(a => a.lastStatus)

    // Ask Orchestrator: what should happen next?
    decision = orchestratorLLM.call({
      system: ORCHESTRATOR_PROMPT,
      context: {
        goal: userGoal,
        phase: teamSession.phase,
        workspaceSummary: summary,
        pendingQuestions,
        activeReviews,
        agentStatuses,
        recentMessages: getRecentTeamMessages(teamSession),
        phaseBudgetRemaining: getBudgetRemaining(teamSession)
      }
    })

    // Execute the decision
    switch decision.type:

      case "assign_task":
        agent = roster.get(decision.targetRole)
        context = sharingStrategy.buildContext(agent, workspace)
        result = runAgent(agent, decision.task, context)
        sharingStrategy.propagate(agent, result, workspace, roster)

      case "spawn_agent":
        newAgent = createAgentInstance({
          role: decision.role,
          prompt: getRoleTemplate(decision.role),
          expertise: decision.expertise,
          workspacePermissions: decision.permissions,
          relationships: decision.relationships
        })
        roster.add(newAgent)

      case "retire_agent":
        agent = roster.get(decision.role)
        agent.status = "retired"
        // Agent's session persists for reference

      case "mediate":
        resolution = orchestratorLLM.call({
          system: MEDIATION_PROMPT,
          context: buildMediationContext(decision.parties, workspace)
        })
        workspace.addDecision(resolution)
        notifyAgents(roster, resolution)

      case "escalate_to_user":
        userResponse = await presentToUser(decision.question, workspace)
        workspace.addDecision({ ...userResponse, source: "user" })
        notifyAgents(roster, userResponse)

      case "advance_phase":
        teamSession.phase = decision.nextPhase

      case "route_message":
        deliverMessage(decision.from, decision.to, decision.content)
        // Recipient agent will see this in their next turn's context

      case "complete":
        presentResults(workspace, user)
        done = true
```

---

## Agent Turn Execution

Each agent uses the existing OpenCode infrastructure:

```
function runAgent(agent, task, context):
  // Create or resume the agent's private OpenCode session
  session = agent.sessionID
    ? await Session.get(agent.sessionID)
    : await Session.create({
        parentID: teamSession.id,
        permission: buildPermissions(agent)
      })

  // Build the user message with team context
  userMessage = buildAgentMessage({
    task: task,
    workspaceSummary: context.summary,
    relevantReviewThreads: context.reviews,
    previousDecisions: context.decisions,
    instruction: AGENT_TEAM_INSTRUCTION  // see below
  })

  // Run using existing SessionPrompt.loop()
  result = await SessionPrompt.prompt({
    sessionID: session.id,
    input: userMessage,
    agent: agent.role
  })

  // Extract structured output for workspace
  return parseAgentOutput(result)
```

### Agent Team Instruction (injected into every agent's context)

```
You are part of a team working on: {goal}

Your role: {role}
Current phase: {phase}

## Workspace Summary
{workspaceSummary}

## Your Assignment
{task}

## Team Communication
- To propose a design/approach: include [PROPOSAL] in your response
- To ask a question: include [QUESTION: target_role] in your response
- To request a new specialist: include [SPAWN: role_name] with justification
- To report completion: include [COMPLETE] with summary of what was done
- To flag a concern: include [CONCERN: description] in your response

## Previous Decisions
{decisions}

## Active Review Threads (if any)
{reviewThreads}

Complete your assigned task. If you encounter issues outside your expertise,
ask via [QUESTION] rather than guessing. If you disagree with a prior
decision, explain why with evidence.
```

---

## Integration with Existing OpenCode

### Entry Point

A new `/team` command or `--team` flag activates team mode:

```
/team Add authentication to the API
```

This creates a `TeamSession` and enters the `orchestratorLoop()` instead of the normal `SessionPrompt.loop()`.

### What Gets Reused

| Existing Component     | How It's Reused                                 |
| ---------------------- | ----------------------------------------------- |
| `SessionPrompt.loop()` | Each agent's private reasoning loop             |
| `Tool` system          | All agents share the same tools                 |
| `PermissionNext`       | Per-agent permissions based on role             |
| `Provider` system      | All agents use same LLM infrastructure          |
| `Snapshot`             | File change tracking continues as-is            |
| `Memory` (RAG)         | Long-term memory available to all agents        |
| `Plugin` hooks         | Extended with team-level events                 |
| `SessionCompaction`    | Per-agent context management                    |
| `Bus` events           | Team events published alongside existing events |

### New Events

| Event                   | Published When                 |
| ----------------------- | ------------------------------ |
| `team.created`          | New team session starts        |
| `team.phase_changed`    | Phase transition               |
| `team.agent_spawned`    | New agent added to roster      |
| `team.agent_retired`    | Agent removed from roster      |
| `team.message`          | Inter-agent message sent       |
| `team.decision`         | Decision recorded in workspace |
| `team.review_started`   | Review thread opened           |
| `team.review_completed` | Review approved                |
| `team.escalated`        | Question escalated to user     |
| `team.complete`         | Team session finished          |

### UI Considerations

The CLI would need to display team activity:

- Which agents are active and what they're doing
- Review thread progress
- Workspace state summary
- Orchestrator decisions
- When user input is needed (escalation)

A split-pane or tabbed view showing agent conversations alongside workspace state would be ideal.
