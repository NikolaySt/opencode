# Cognitive Architecture Documentation Index

> Complete analysis and design documents for OpenCode's cognitive architecture,
> covering the current system analysis, proposed multi-agent team model, and
> implementation plan.

**Date**: 2026-02-20
**Author**: Cognitive Code Analysis Session

---

## Documents

### 1. [Cognitive Architecture Analysis](./01-cognitive-architecture-analysis.md)

Complete 5-phase analysis of OpenCode's current architecture through 8 cognitive science lenses:

- Phase 1: Architectural Survey (flow topology, component inventory)
- Phase 2: Chain-of-Thought Dissection (3 levels of CoT, coupling analysis)
- Phase 3: Cognitive Mechanism Mapping (Dual Process, Working Memory, Metacognition, etc.)
- Phase 4: Failure Mode Analysis (confabulation, anchoring, circular reasoning, etc.)
- Phase 5: Synthesis (strengths, weaknesses, recommendations)

### 2. [Role and Prompt Flow Analysis](./02-role-prompt-flow-analysis.md)

Complete mapping of every role, persona, and prompt injection point:

- The 7-layer identity stack
- All 39 .txt prompt templates inventoried
- All 15 persona identity declarations
- 5 system-reminder injection points
- Provider-specific prompt routing
- Sub-agent identity switching
- Auxiliary LLM calls with separate identities
- End-to-end flow diagram

### 3. [Current vs. Proposed Architecture Comparison](./03-current-vs-proposed-comparison.md)

Side-by-side comparison across all dimensions:

- Fundamental paradigm (solo practitioner vs. collaborative team)
- Cognitive science grounding (8 models compared)
- Session, agent, tool, prompt system comparisons
- Communication model (hub-spoke vs. workspace-mediated)
- Memory and context (single window vs. distributed)
- Decision-making (single-point vs. multi-point with review)
- Failure mode comparison (7 failure types analyzed)
- Gap analysis (what to build, what to modify, what stays)

### 4. [Dynamic Cognitive Team Model Design](./04-dynamic-cognitive-team-model.md)

Complete design specification:

- 4 core abstractions (Workspace, Roster, Conversation Graph, Orchestrator)
- Workspace data model and section structure
- Orchestrator decision model and system prompt
- Sharing strategy interface (3 pluggable implementations)
- Review protocol with convergence enforcement
- Dynamic role emergence triggers
- Role template library (10 specialist prompts)
- End-to-end example flow (auth feature)
- Database schema (5 new tables)
- Orchestrator loop pseudocode
- Agent execution bridge to existing SessionPrompt

### 5. [Implementation Plan](./05-implementation-plan.md)

Incremental 5-milestone delivery plan:

- Milestone 1: Foundation (Workspace + Orchestrator + Architect + Developer)
- Milestone 2: Review Protocol (critique/revision loops)
- Milestone 3: Dynamic Role Spawning (role templates + signal detection)
- Milestone 4: Sharing Strategy Interface (3 pluggable strategies)
- Milestone 5: Integration and Polish (/team command, CLI UI, plugin hooks)
- File structure, database migrations, testing strategy
- Risk mitigation matrix, open questions

---

## Key Discoveries

### Current Architecture

1. **OpenCode is a single-agent system** with sophisticated environmental scaffolding. The "chain of thought" is primarily the architectural loop (tool call -> observe -> next call), not the model's generated text.

2. **Working memory management is excellent** -- 4 layers (pruning, compaction, truncation, RAG) directly map to cognitive science models of human working memory and chunking.

3. **Inner speech is sophisticated** -- `<system-reminder>` tags, plan mode directives, and max-steps assistant prefill create a genuine analog to Vygotsky's self-regulatory inner speech.

4. **Metacognition is weak** -- no confidence scoring, no self-critique, no systematic verification. The doom loop detector is the only self-monitoring mechanism.

5. **The identity system is layered but static** -- 7 layers of prompt stacking, but no dialogue between roles. One mind wears different hats sequentially, never concurrently.

6. **Sub-agent delegation is hierarchical, not collaborative** -- TaskTool creates parent-child relationships with one-way communication. No critique, no pushback, no shared workspace.

### Proposed Architecture

7. **The fundamental shift is from solo practitioner to team** -- not just adding more agents, but introducing workspace-mediated communication, review protocols, and dynamic role emergence.

8. **The Orchestrator is the minimal new component** that unlocks everything else. Once you have something that reasons about team composition and coordination, the rest follows.

9. **Productive tension (disagreement) is a feature** -- cross-agent review catches errors self-review misses, directly implementing metacognition externally.

10. **The existing infrastructure wraps, not replaces** -- each team agent still uses SessionPrompt.loop(), tools, permissions, and memory. The team layer adds coordination on top.

---

## Cognitive Science References

- **Kahneman, D.** (2011). Thinking, Fast and Slow. (Dual Process Theory)
- **Newell, A. & Simon, H.A.** (1972). Human Problem Solving. (Problem Space Theory)
- **Ericsson, K.A. & Simon, H.A.** (1993). Protocol Analysis. (Think-Aloud Protocol)
- **Vygotsky, L.S.** (1934). Thought and Language. (Inner Speech, ZPD)
- **Miller, G.A.** (1956). The Magical Number Seven. (Working Memory)
- **Ericsson, K.A. & Kintsch, W.** (1995). Long-term Working Memory. (Retrieval-Augmented Memory)
- **Flavell, J.H.** (1979). Metacognition and Cognitive Monitoring. (Metacognition)
- **Nelson, T.O. & Narens, L.** (1990). Metamemory. (Monitoring and Control)
- **Chi, M.T.H. et al.** (1989). Self-Explanations. (Self-Explanation Effect)
- **Johnson-Laird, P.N.** (1983). Mental Models. (Mental Model Theory)
- **Hutchins, E.** (1995). Cognition in the Wild. (Distributed Cognition)
- **Wegner, D.M.** (1987). Transactive Memory. (Group Memory Systems)
- **Nisbett, R.E. & Wilson, T.D.** (1977). Telling More Than We Can Know. (Confabulation)
- **Janis, I.L.** (1972). Victims of Groupthink. (Groupthink and Structured Dissent)
- **Evans, J.St.B.T.** (2010). Thinking Twice. (Dual Process Theory)
- **Fernyhough, C.** (2016). The Voices Within. (Inner Speech)
