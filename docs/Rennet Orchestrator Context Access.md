---
title: Rennet Orchestrator Context Access
tags: [rennet, architecture, orchestrator, retrieval, canvases]
categories: [project]
status: draft-for-rai
created: 2026-08-06
related: ["[[Rennet Canvas Paradigm]]", "[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Wingman Surfacing DSL and Model Routing Plan]]"]
---

# Rennet Orchestrator Context Access

*Design doc, 2026-08-06. Answers Rai's superseding direction on OQ6/primer-budget (voice, ~13:00): capping the primer is wrong, and dumping the whole context is wrong. The right design arms the orchestrator with tools and on-demand retrieval — possibly a background knowledge agent it can ask questions to — so it accesses what it needs without overloading its own context window, and it must know (a) that it CAN ask, (b) HOW to ask, and (c) WHAT KIND of answers come back. This doc supersedes the primer sketch in [[Rennet Canvas Paradigm]] §4.3 and its Open Question 6.*

**Headline recommendation: turn the priming manifest from a container of context into a map of context. Boot the orchestrator with a lean, deterministic bootstrap (~2–4 KB: identity, freshness verdicts, count-level canvas state, and a protocol card that teaches it to ask) and put everything else behind a read-only retrieval tool family added to the existing in-process `canvasOps` MCP server (version the combined surface `canvasOps@2`). Build the background knowledge agent — but hide it behind ONE tool, `context.ask`, so from the orchestrator's side asking a sub-agent and calling a tool are the same act with the same schema-constrained contract. Nothing about the orchestrator's world changes if the answering machinery behind that tool is later upgraded, downgraded, or re-tiered. Settle the remaining unknowns (sync-vs-async ask, primer floor, should-ask rate) with the five experiments in §6.**

**User-facing name (Rai, 2026-08-09): this whole baseline is the "Repo Map."** What this doc calls the ProjectSnapshot (deterministic, model-free), the knowledge layer (LLM, evidence-anchored), and the primer (this lean orientation map) is, to the user, one thing: the project's **Repo Map**, stored in its `.rennet` folder and mined once when the project is opened. It is the **baseline context pack**, fed alongside a **per-diff context pack** to the review agents and the orchestrator so neither spends its own window re-reading the codebase. The review agents' resulting PR review is what surfaces as the **Flagged lens** (R49). **Storage (R55), local-only by default:** the derived Repo Map lives in an app-owned store keyed by repo identity (`RepoRecord` / `realpath(git-common-dir)`, R19), so every worktree shares one entry and nothing "travels across branches" (the snapshot is pinned to main's OID); human-authored config stays committable in `.rennet/`; Rennet discovers a Repo Map committed into a repo, and mirroring your local map in is a per-project opt-in, default off. The other three directions are adopted (fable advice, folded 2026-08-09; R54): **nesting** composes by reference with an internal scope tree from workspace tooling and submodules pinned at the gitlink OID (the Canvas Paradigm §4.2 `WorkspaceContext` is promoted to adopted); **proactive update** keeps the deterministic snapshot rebuild and makes the knowledge layer log-structured (delta passes + periodic re-rollup), never blocking review; **net-novel** is a deterministic novelty ledger plus LLM judgment that must cite the baseline evidence it compared against. Rulings R54/R55; issues #141-#144. Source: `/Users/rai/notes/26-08-09 rennet feedback.md`.

---

## 0. The reframe: why neither dump nor cap was right

The two rejected designs fail the same way from opposite ends:

- **Dump** front-loads content the conversation may never touch. A big review's RSP corpus + knowledge layer + diff is tens to hundreds of KB; loading it eats the conversation's room (the thing OQ9's fresh-session default exists to protect) and *still* goes stale mid-review — a new patchset (R28/R29) invalidates analysis the orchestrator already swallowed, and there is no mechanism to un-read a context window.
- **Cap** makes the assembler guess which slice of the world this conversation will need, before the conversation exists. Whatever the budget, the interesting question is always about something that got truncated, and the DSL plan's own doctrine says truncation must be visible — a primer that is mostly visible-truncation markers is an apology, not a primer.

The property both miss: **the event store, the snapshot, and the canvases are already the durable, queryable state.** The orchestrator does not need a copy of the state; it needs *addressable access* to the state plus enough orientation to know what exists and how to reach it. That is a retrieval architecture, not a document. Retrieval also gets staleness for free: a tool call at minute 40 reads the current patchset's canvas, where a primer assembled at minute 0 reads a memory of it.

One more thing the reframe buys, and it is Rai's own product thesis pointed inward: **the tool surface IS zoom for the orchestrator.** "You should be able to zoom in and out of the diff at any point" is the user-facing principle (canvas Q&A, core principle); `canvas.describe` at count depth → cohort depth → element depth → `canvas.read` of one element's body is the same altitude ladder, machine-facing. The orchestrator reads the review the way the user does: roll-up first, zoom on demand.

---

## 1. Lean bootstrap vs on-demand: what goes where

### 1.1 The bootstrap (in the opening context, always, ~2–4 KB)

Everything in this set shares one justification: **the orchestrator cannot know to ask for what it does not know exists, and it must never act on stale context without knowing it is stale (R30).** Orientation and safety rails are un-retrievable by definition; content is not.

| # | Item | Why it cannot be retrieved instead | Size |
|---|---|---|---|
| B1 | **Review identity**: workspace/repo, `reviewId`, `patchsetId`, lineage position ("delta re-review of ps_03; 14 of 19 elements carried approved"), mode (own-branch handoff vs someone-else's-PR publish) | It is the addressing scheme every tool call needs; nothing can be asked for without it | ~300 B |
| B2 | **Freshness verdicts**, one line per repo: snapshot id + `current/updating/stale/failed` | R30: stale context is never consumed silently. The orchestrator must know *before* its first answer whether the ground it stands on is current — a rule enforced at tool-response level too (§2.4), but the headline verdict belongs in orientation | ~100 B/repo |
| B3 | **Canvas state summary, count level only**: per canvas — element count, cohort count, disposition coverage (n approved / n request-changed / n unread), residue count | The shape of the review. Lets the orchestrator answer "where are we" and "what have you not looked at" without a call, and tells it where zooming is worthwhile. Counts, never contents — the decisions list is never capped (correction 4) and never inlined either; it is *reachable*, which is the actual requirement | ~400 B |
| B4 | **The protocol card** (§4): the four-actor interaction contract in compressed form, the two product principles that govern its behaviour (logical ordering; roll-up/zoom), what it can never do, and the ask protocol — can-ask / how-to-ask / answer-shapes | This is the teaching layer. It is *about* the tools, so it cannot be behind them | ~1.5 KB |
| B5 | **Tool index**: tool names + one-line when-to-use descriptions. Full schemas stay deferred (§2.5) | "Know that it CAN ask" requires the menu in view. Schemas do not need to be — the Agent SDK's tool search defers them and loads on demand | ~500 B |
| B6 | **Run-ledger headline**: one line — n fleet tasks ran, n docs admitted, n rejected, budget spent/remaining | Honest capability statement: whether analysis is complete, degraded, or budget-starved changes what the orchestrator should claim. Detail via `run.ledger` | ~150 B |

Assembly stays exactly as [[Rennet Canvas Paradigm]] §4.3 specified for the old fat primer: **deterministic, versioned like a base instruction, digest recorded in the orchestrator session's provenance**, inspectable in the open-assembled-prompt panel. "The orchestrator is primed" remains a checkable property; only the payload shrinks from *the context* to *the map of the context*.

### 1.2 On demand (behind tools, never in the bootstrap)

Explicitly evicted from the old §4.3 sketch:

- **The knowledge digest** ("top learned statements, confidence-labelled") — was in the fat primer; now `context.knowledge` / `context.ask`. A digest chosen at boot answers questions nobody asked; a retrieval answers the one that was.
- **The full interaction contract text** — compressed to the protocol card; the long form is a resource the orchestrator can read if genuinely confused (`meta.contract`), which in practice it should never need because the *structural* enforcement (§2.6) does not depend on it having read anything.
- RSP document bodies (decisions, claims, spec model, noise groups), disposition bodies and their inline clarification threads, annotation contents.
- Diff hunks, file content at base ref, the occurrence manifest, the decomposition DAG.
- Snapshot shards (symbols, dependency edges, entry points, test relationships), learned knowledge statements with their evidence.
- Full run ledger and per-doc provenance blocks.
- Instruction/guidance texts (the DSL §6 ladder) — those govern *fleet* prompts; the orchestrator only ever needs to *cite* them, which `run.provenance` covers.

---

## 2. The tool surface: `canvasOps@2`

Extend, don't reinvent: the canvas doc §5.1 already puts an in-process MCP server inside Rennet, attached to the orchestrator session (Claude slot via `@anthropic-ai/claude-agent-sdk` — `query()`'s `mcpServers` option takes in-process servers built with `createSdkMcpServer`; Codex and omp speak MCP externally, same contract, no `if (harness === X)`). The §3.1(c) operations stand unchanged. This design adds a **retrieval family** to the same server and versions the combined surface **`canvasOps@2`** — one version, one compatibility surface, because the interaction ops and the retrieval ops will be reasoned about together by every orchestrator prompt ever written.

All retrieval tools are **read-only** (`readOnlyHint: true` — which also lets the harness parallelise them), **actor-tagged `visibility: model`**, and widen the write surface by exactly nothing: the ⛔ list of Canvas Paradigm §3.1c (no L2 writes, no L1 edits, no reordering, no publish sheet, no cross-review reads) is preserved because those operations simply do not exist on the surface.

### 2.1 Canvas bucket (the review's surfaces)

| Tool | Signature (sketch) | Returns |
|---|---|---|
| `canvas.describe` | `(canvasId?, depth: counts \| cohorts \| elements, cursor?)` | Structured state at the requested altitude. `counts` = B3's numbers, fresh; `cohorts` = the cohort tree in logical order with per-cohort disposition coverage; `elements` = element summaries (docId, anchor, one-line summary, disposition state). **Paginated with totality**: every response carries `total` and a cursor — "n of N shown" is honest, a silent cap is forbidden (correction 4 applied to the machine reader) |
| `canvas.view` | `()` | What the user is looking at now: open canvas, active lens, expanded cohorts, viewport anchor, selection. (Per Q5's resolution this context is *also pushed* with each user request; the pull form exists for mid-answer re-checks) |
| `canvas.read` | `(elementId \| anchor \| cohortId)` | **NEW — the zoom-in the old surface lacked.** Full content of L1 elements (the admitted RSP document body, its provenance pointer, its blast-radius paint), L2 dispositions (raw draft + refined form + state), L3 annotations. `describe` tells you what is on the surface; `read` is how a specific thing gets into the conversation without dragging its siblings along |
| `canvas.thread` | `(dispositionId)` | The per-diff inline clarification thread on a disposition (the comment-interpretation loop's back-and-forth), oldest-first, plus the current refined/published form. Needed the moment the refinement loop shipped: interpreting "is this what you meant?" requires reading what was already said |

### 2.2 Diff/patchset bucket (the code under review)

| Tool | Signature (sketch) | Returns |
|---|---|---|
| `diff.read` | `(anchor \| hunkId \| file, contextLines?)` | Hunk content with surrounding context, its lineage status (`carried-approved / new / modified / ambiguous-failed-closed` per R8), and any dispositions anchored to it |
| `diff.search` | `(query: text \| symbol \| path-glob)` | Matching anchors from the occurrence manifest — anchors, not content, so a broad search is cheap and the orchestrator zooms with `diff.read` |
| `diff.structure` | `()` | The decomposition DAG / topological reading order (the sequence canvas's L1 as data). This is the ordering substrate (correction 8), so "why is this cohort first?" is answerable with evidence rather than vibes |

### 2.3 Base-branch/workspace bucket (Contracts §2, exposed rather than copied)

| Tool | Signature (sketch) | Returns |
|---|---|---|
| `context.map` | `(query: symbol \| path \| dependency-edge \| owners \| entry-points)` | Deterministic snapshot-shard lookup. **No LLM anywhere in this path** — it is a database read of the byte-reproducible map, and keeping it model-free preserves the two-layer split §4.1 of the canvas doc insists on |
| `context.file` | `(path, range?)` | File content **at the pinned base ref**, escape-checked with the same repo-relative rules as `instructions.files`. Range-required above a size threshold so one careless call cannot swallow the window |
| `context.knowledge` | `(topic \| anchor)` | Learned statements relevant to the topic/anchor, each carrying evidence, provenance, confidence, and the snapshot it was learned against — the Contracts §2.1 shape returned verbatim, hypothesis labels intact |
| `context.ask` | `(question, scope?, budgetHint?)` | **The escalation valve — the background knowledge agent lives behind this** (§3). Free-form question; bounded, evidence-cited, confidence-labelled answer |

### 2.4 Run/provenance bucket + the uniform envelope

`run.ledger(filter?)` — which fleet tasks ran, tiers, models, budgets, admitted vs rejected. `run.provenance(docId)` — the DSL §2.2 provenance block for one document.

**Every retrieval tool returns the same envelope:**

```ts
{
  data: ...,                          // tool-specific payload
  evidence?: Anchor[] | DocId[],      // where this came from
  freshness: 'current'|'stale'|...,   // on anything snapshot- or canvas-derived
  total?: number, cursor?: string,    // pagination with totality — no silent caps
  truncated?: { droppedBytes: number } // visible, DSL-doctrine truncation only
}
```

Byte-capped per response (settings-owned cap, same family as `context.totalBudgetBytes`), continuation by cursor. **A `stale` freshness verdict rides on the answer itself** — R30 enforced at the reply, not just at boot, so a mid-review default-branch advance cannot be silently consumed. **"Nothing found" is a distinguished value, never an empty-looking success** — `{data: [], total: 0}` with the searched scope named, so absence of results is distinguishable from a failed search.

### 2.5 Cost model: why a wide surface is affordable

The obvious objection — "fifteen tools' schemas will eat the context you saved" — is already answered by the harness: **the Claude Agent SDK's tool search is on by default and defers in-process MCP tool schemas**; Claude sees a compact name list and loads a schema on demand (verified against the SDK's custom-tools doc, 2026-08-06). The bootstrap's B5 tool index plus deferred schemas is a few hundred bytes; only the schemas of tools actually used enter the window. Mark the always-hot trio — `canvas.describe`, `canvas.view`, `context.ask` — `alwaysLoad: true` so the core loop never pays a search round-trip. Codex/omp slots lack this exact mechanism; for them the schema set is the cost, which is one of the things E5 measures — and a reason to keep the tool *count* disciplined rather than the tool *reach*.

### 2.6 What stays structural

The actor partition is enforced by surface composition, not by the protocol card: the orchestrator's MCP server contains no user-only or engine-only operation, so "the human still disposes" remains a property of the wiring. The retrieval family adds only reads. `canvas.recompute` (the one expensive escalation that *causes* model spend) stays exactly as §3.1c defined it — explicit, RoutePlan-budget-gated, visible to the user.

---

## 3. The background knowledge agent: yes — as the implementation of one tool

### 3.1 The decision

Rai's instinct that a knowledge/context agent belongs here is right; the design question is what *shape* it presents to the orchestrator. Recommendation: **the orchestrator never converses with a second agent. It calls `context.ask` and gets an answer document back.** The retrieval sub-orchestrator is real, but it is plumbing behind the tool boundary.

Three reasons, in order of weight:

1. **Harness-agnosticism.** The orchestrator slot is user-picked among claude/codex/omp (OQ9). A tool call is the one grammar all three speak with schema constraints — the DSL plan's strongest error-reduction lever. "A conversation with a peer agent" has no portable grammar; it would be the first `if (harness === X)` in the interaction layer.
2. **The (a)/(b)/(c) requirement collapses to one already-solved problem.** If asking is a tool call, then *can ask* = tool in the index, *how to ask* = the schema, *what comes back* = the declared answer shape. No second protocol to teach, version, or drift.
3. **Upgradability without contract churn.** v1 can implement `context.ask` as deterministic composition (knowledge lookup + shard query + a light-tier summarise). If E2 shows synthesis questions need a real agent with its own context, swap the implementation; the orchestrator's world is byte-identical. The empirical question Rai wants answered gets answered *behind* a stable interface instead of in front of it.

### 3.2 The knowledge agent's contract

**Position in the actor model: below the interaction contract, beside the fleet.** It is a consumer of the same substrate the fleet reads and it emits a validated document — it never touches a canvas, never sees dispositions-as-authority, never gets a write surface. (Fleet agents: "exactly one operation — emit RSP documents." The knowledge agent: exactly one operation — emit an `answer` document.)

| Aspect | Contract |
|---|---|
| **Input** | `question` (free text), optional `scope` (anchors, paths, canvasId, angle — bounds the search and shrinks the prompt), optional `budgetHint` (`quick` / `thorough`) |
| **Has access to** (that the orchestrator doesn't hold loaded) | Full snapshot shards; full knowledge layer; base-ref file contents; the admitted RSP corpus for this review; the occurrence manifest. All read-only |
| **Does NOT have** | Canvas ops of any kind; the user's view state; the conversation between user and orchestrator (it gets the question, not the chat); any write path |
| **Output** | An **`answer` document**, validated like everything else: `{answer, evidence: [anchors/docIds/file:line], confidence: high\|medium\|low, consulted: [...], unanswered?: reason}` — byte-capped, provenance-carrying (model, tier, inputs digest). `unanswered` with a reason is a first-class success: an honest "the snapshot does not cover generated code" beats a fluent guess, and the schema makes refusal cheap |
| **Routing** | Through the existing model-routing matrix: light tier default, heavy only via `budgetHint: thorough` + RoutePlan budget gate (R10). Spend appears in `run.ledger` like fleet spend — asking questions is analysis and is accounted as analysis |
| **Session model** | One **persistent warm session per review** (not per question): it accumulates map-knowledge of this reviewpatchset and gets prompt-cache reuse. Killed and re-warmed on patchset advance (its cached picture is exactly what R29 invalidates). E5 measures whether warm actually beats fresh |

### 3.3 Sync vs async

**v1: synchronous, with a hard latency budget.** "Smooth and quick" is the governing principle, and for a *conversation* the killer is stall: an orchestrator that fires an async question and keeps talking is composing answers it does not have. A bounded synchronous call (deterministic tools well under a second; `context.ask` targeted at low single-digit seconds on the light tier) keeps the mental model simple: ask, receive, answer the user.

The escape hatch is already designed elsewhere: if E3 shows `thorough` questions blow the budget, add `async: true` returning a ticket, with completion delivered as a pushed event on the **context-update stream** (§3.2 of the canvas doc — the grammar for "structured events pushed into the orchestrator's context" exists; an `{event: "answer-ready", ticket, answerDocId}` is one more row, and the answer body is then a `canvas.read`-style fetch). Do not build this until the measurement says so.

---

## 4. Teaching the orchestrator to ask: the protocol card

The (a)/(b)/(c) requirement, made concrete. The card is section B4 of the bootstrap — versioned, byte-budgeted like a base instruction, and *short*, because the schemas carry the details. Draft content (~1.5 KB rendered):

```
## How this session works
You are the orchestrator for review {reviewId}. You converse with the reviewer
about the code via the canvases. Four actors: the deterministic engine places
analysis; fleet agents emitted it; YOU may describe, focus, annotate, propose,
and ask; the USER alone dispositions. You cannot mark anything read, edit
analysis, or reorder cohorts — your proposals become real only when the user
accepts them.

Two principles govern everything you present: content is grouped and ordered
LOGICALLY so the review is understandable from first principles (never by
danger); and anything that can be rolled up is rolled up — the user approves at
any altitude, and you help them zoom.

## You are deliberately under-informed, and you can always ask
Your context holds a MAP of the review, not the review. This is by design.
The state is one tool call away and always fresher than your memory of it:
 - what is on a surface / where are we    → canvas.describe (zoom via depth)
 - what is the user looking at            → canvas.view (also pushed to you)
 - the full content of one thing          → canvas.read / canvas.thread
 - the code itself                        → diff.read, diff.search, diff.structure
 - the base branch: map / files / learned → context.map, context.file, context.knowledge
 - a QUESTION needing synthesis           → context.ask
 - what analysis ran and what it cost     → run.ledger, run.provenance

Never answer about the base branch or unexamined code from recall — retrieve
or ask first. Answers return {data, evidence, freshness, total/cursor}: cite
the evidence; if freshness is not "current", say so before relying on it; a
cursor means more exists — never present a page as the whole. context.ask
returns {answer, evidence, confidence, unanswered?}: an "unanswered" is a real
result — relay the gap honestly rather than filling it.
```

Why this lands the three requirements:

- **(a) CAN ask** — the card states the under-informed condition as *intentional* and enumerates the menu. Naming the negative space ("never answer about the base branch from recall") matters as much as naming the tools: the failure mode to prevent is not "didn't know the tool existed" but "answered from priors because asking felt unnecessary." E4 measures exactly this.
- **(b) HOW** — the schemas are the contract (schema-constrained calls, loaded on demand per §2.5), and each tool's *description* carries its when-to-use trigger condition — prescriptive trigger conditions in tool descriptions measurably lift should-call rates on current models, which is precisely the lever this design leans on.
- **(c) WHAT comes back** — the uniform envelope and the answer-document shape are stated once in the card and declared per-tool in the schemas. Crucially the card teaches the *semantics* the schema can't: cite evidence, surface staleness, respect cursors, honour `unanswered`.

And the enforcement note that keeps this honest: the card is teaching, not security. Everything the orchestrator must not do is absent from its surface (§2.6), so a mis-taught or prompt-drifted orchestrator degrades to *unhelpful*, never to *unsafe*.

---

## 5. What this supersedes / touches

1. **[[Rennet Canvas Paradigm]] §4.3**: the primer's role changes from container to map; the knowledge digest and inlined interaction contract leave the primer. Its OQ6 ("cap like an instruction budget?") is answered: neither cap nor scale — retrieve. Deterministic assembly + provenance digest survive unchanged.
2. **`canvasOps@1` → `canvasOps@2`**: adds `canvas.read`, `canvas.thread`, the diff bucket, the context bucket (including `context.ask`, replacing §3.1c's thinner `context.query`), and the run bucket. One versioned surface, published under MIT alongside RSP as before.
3. **[[Rennet Contracts and Rulings]] OQ9** gains its missing half: the orchestrator model now has a designed context-access subsystem, not just a session-shape ruling.
4. **The routing matrix** (DSL §5.2) gains one row: `answer` (the knowledge agent's doc type), light tier default, heavy behind budget gate.
5. **The validator/doc-type family** gains the `answer` schema — smallest doc type in the system, same envelope + provenance rules.

---

## 6. Empirical plan — "answer this empirically and figure it out"

Fixtures: three real reviews from Rennet's own history (small ≈ PR #2's doc-only change; medium; large ≈ the MVP branch), each with a scripted question set with known-true answers ("what hasn't been reviewed yet", "why is cohort X ordered before Y", "does this change alter the auth path", "summarise the unresolved request-changes").

| # | Experiment | Conditions | Measures | Decision it settles |
|---|---|---|---|---|
| E1 | **Primer ablation** | (i) fat-dump primer, (ii) capped 8 KB primer, (iii) lean map + tools | answer correctness on the question set; tokens resident in context at turn 10; tool calls per answer; time-to-first-useful-token | Confirms (or falsifies) the whole thesis; also finds the **primer floor** — which bootstrap items, when removed, measurably degrade first answers. B1–B6 is a hypothesis, not scripture |
| E2 | **`context.ask` quality** | deterministic-composition impl vs real sub-agent impl, light vs heavy tier | answer correctness; evidence validity (do the cited anchors actually resolve and support the claim); honest-refusal rate on deliberately unanswerable questions | Whether the knowledge agent needs to be an agent at all in v1, and its default tier |
| E3 | **Latency budget** | per-tool p50/p95 under realistic review sizes; `context.ask` quick vs thorough | wall-clock per call; conversation-stall perception threshold (does a reply feel "smooth and quick" with a synchronous ask inside it) | Sync-only vs building the async ticket path (§3.3) |
| E4 | **Does it actually ask?** | protocol card present/absent × trigger-conditions-in-descriptions present/absent, on questions whose answers are NOT in context | should-ask rate (asked when it needed to); over-ask rate (called tools for things already in context); fabrication rate when it didn't ask | Requirement (a)/(b) verified as behaviour, not as prose. This is the experiment most likely to surprise |
| E5 | **Session & cache economics** | knowledge agent warm-per-review vs fresh-per-question; orchestrator slot claude vs codex (schema-deferral vs full-schema cost) | cost per question; cache-read fraction; per-slot bootstrap token cost | Warm-session default (§3.2) and whether the tool count needs trimming for non-Claude slots |

Instrument everything through the existing provenance machinery: every tool call and its envelope already have a natural home in the run ledger, so the experiments are mostly *reading* infrastructure the architecture requires anyway.

---

## OPEN QUESTIONS for Rai

1. **`context.ask` spend visibility**: asking is model spend on your account. Ledger-only (visible in `run.ledger`, no ceremony), or a visible per-review ask-budget the way fleet budgets are surfaced? Recommendation: ledger-only in v1 — smooth-and-quick, and it is light-tier pennies — with the budget gate existing but generous.
2. **Naming**: `canvasOps@2` as one surface vs splitting `retrievalOps@1` out. Doc recommends one surface (one contract to version and teach); flag if you want the retrieval family independently adoptable.
3. **The protocol card's voice** (§4 draft) is written to be model-facing and terse — worth one read from you since it is the closest thing the orchestrator has to a constitution.
