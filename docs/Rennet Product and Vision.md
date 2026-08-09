---
tags: [rennet, products, visions]
categories: [project]
status: active
created: 2026-08-06
updated: 2026-08-09
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Rennet Canvas Paradigm]]", "[[Rennet Orchestrator Context Access]]", "[[Rennet Comment Refinement Loop]]", "[[Rennet Model Council]]", "[[Rennet User Journey]]", "[[Rennet Design Doctrine]]", "[[Code Review Harness App]]"]
---

# Rennet Product and Vision

> **Resteer 2026-08-09:** see [[Rennet v3 Resteer 2026-08-09]] and the v3 prototype (gallery https://nimbus.piranha-wyvern.ts.net:9443/). A fuller content resteer of this doc is in progress.

**This is the canonical statement of what Rennet is.** Read it first. Every other document in `docs/` plays a supporting role — the authority register for rulings is [[Rennet Contracts and Rulings]], the frozen engineering contracts are [[Rennet Architecture Contracts]], and [[Rennet Doc Architecture]] maps the whole set. Where this document and a deeper document disagree on *intent*, this document wins; where they disagree on a *ruling or contract*, the deeper authority wins and this document has a bug — file it.

---

## 1. What Rennet is

**Rennet** (rennet.dev) is an MIT-licensed, local-first Electron desktop app: a **review harness**. A coding harness points a model at your codebase so it can *write*; a review harness points the coding harnesses already on your machine at a change so you can *read*.

A changeset too big to hold in your head is rolled up into logical cohorts you can read from base principles up, its decisions surfaced — never hidden, never capped — and the result lands either as a normal GitHub PR review or, on your own branch, as a batched set of requests handed straight back to a coding agent, after which Rennet re-reviews only what changed.

**Positioning headline (settled):** *You stopped writing the code. You still have to answer for it.*

The essentials, all settled and frozen:

- **Local-first, no Rennet backend, no telemetry.** Material sent through a selected harness may leave the machine for that harness's provider; every run discloses and records its assembled context. Never claim universally that nothing leaves the machine.
- **BYOK via the user's own installed harnesses** — Claude Code first (an `@anthropic-ai/claude-agent-sdk` integration that spawns the user's own installed `claude`, so auth stays on their subscription at no per-token cost), then codex and omp behind the same adapter protocol.
- **Zero-config is the North Star.** Install, and the harnesses already on your machine are auto-detected and just work. No API-key ceremony.
- **The human disposes.** No auto-approve, no auto-comment, nothing another human sees without an explicit human act. This is enforced structurally (see §4), not by prompt.
- **Both review modes are v1**: reviewing a diff an LLM just generated locally (working-tree changeset source) AND reviewing someone else's PR (GitHub changeset source). One engine, two sources.
- **MIT throughout** — one licence for every package. The `protocol`/`types` import-nothing rule survives as an architectural boundary (a mobile or third-party client is a peer of the renderer), not a licensing one.

## 2. Why it exists

LLM-generated code has inflated PR sizes everywhere, and review has become the bottleneck. Cloud review tools die at enterprise procurement; fully autonomous review is trusted by nobody. The gap Rennet occupies: the human stays the gate, and the machine does the structural work — grouping, ordering, narrating, surfacing the decisions — so the human's attention goes only where judgment is actually required.

The first user is a buyer, not a smuggler: the agentic engineer who no longer writes code by hand and cannot honestly say they have read the PRs their agents open. Launch copy leads with that confession, never with "makes 3,000-line PRs pleasant."

## 3. The vision — digestibility through roll-up, zoom, and lenses

**Rennet exists to make a large diff digestible, and the mechanism is roll-up + zoom + lenses.** In Rai's words (2026-08-06, verbatim, the thesis):

> "Anything that can be rolled up and grouped SHOULD be rolled up and grouped, and you should be able to approve the whole group / the whole roll-up at a time, OR partials of it. You should be able to ZOOM IN AND OUT of the diff at any point. The whole purpose of Rennet is to help you zoom in and out and put on different lenses."

Unpacked into the four load-bearing product principles (frozen doctrine — [[Rennet Contracts and Rulings]] §3):

1. **Aggressive roll-up is the default, not an option.** Related changes are grouped into **logical cohorts** understandable as one thing; the decisions inside a changeset are rolled up the same way. Grouping behaviour is **hard-baked** — one opinionated behaviour, never a per-project knob (the zero-config North Star wins that tension outright).
2. **Approve at ANY granularity.** Whole roll-up, cohort, group, partial, or single item — the user picks the altitude. **Decisions are never capped or truncated**: a cap can hide the one call you must answer for. Every decision stays reachable through collapse/expand, and bulk adjudication is one user act.
3. **Free zoom, in and out, anywhere.** The reading surface, the approval surface, and the orchestrator's own retrieval surface are all the same altitude ladder.
4. **Smooth and quick.** The user may be lazy and messy; the machine does the cleanup. Anything that adds user ceremony without adding user judgment is wrong.

**Ordering is the product.** The whole value of Rennet over "read the changed files top-down on GitHub" IS the reading order + the cohorts + the surfaced decisions. And the order is **logical, optimised for comprehension** — Rai, verbatim: *"stop basing things around safety. base things about logic... ordered logically so that a human reading a PR can understand the PR from base principles."* Mechanically: a deterministic code-dependency order (the decomposition DAG) is the baseline; an **agent then produces the final ordering** — high-level first, then bottom-up — asked whether the baseline is the clearest way to understand the diff or whether a better structure exists. The user does not approve the ordering ("too much effort from the user"); it is an agent-owned comprehension task. Danger, blast-radius, and salience are **never** the ordering signal — blast radius is an overlay (paint), not an order.

Deterministic validation of model output, the surfacing DSL, and model-tier routing are all **means, never the point**. The old framing "a wrong model produces an invalid document, not a wrong review" is retired as a thesis; it survives only as a mechanism.

## 4. The feature set

### 4.1 Six angles, five canvases, one overlay

Every changeset is decomposed into sub-400-LOC chunks and read through six concurrent **angles** (lens set v4, ratified):

| # | Angle | Species | One line |
|---|---|---|---|
| 0 | **Spec** | queue over requirements | What this change was *supposed* to be: committed spec (Kiro/OpenSpec/superpowers), PR body, ticket; derived-and-marked when nothing is committed. The only angle that exists on a zero-hunk (spec-only) changeset. Upstream source of requirements for claims-and-evidence and of the decisions angle's `evidenced` disposition. |
| 1 | **The sequence** | sequence | Post-hoc reading order, named switchable strategies (layered / tests-first / spine-first), prose collapsed. |
| 2 | **Decisions** | queue | The calls only you can make. The decision log is the angle's spine: everything the author(-agent) decided, each with a reconstructed WHY marked as reconstructed; triage evidenced / mechanical / contestable. **Never capped or truncated** — rolled into cohorts, in logical comprehension order (agent-produced over the DAG baseline), collapsible. |
| 3 | **Claims and evidence** | queue | Bidirectional hunk↔requirement and claim↔test mapping, explicit polarity, UNCLAIMED bucket as the scope-creep detector. "Would that test have failed." |
| 4 | **Blast radius** | overlay | Cheap explainable signals only (irreversibility, contract surface, deletions, fan-in, CODEOWNERS, safety-net-weakening preset). Never churn-heat. **An overlay, never an ordering input.** |
| 5 | **Noise** | floor | Everything that earned no place above, grouped, categorised, summarised. Deterministic checkers are the only admission authority for VERIFIED noise; the LLM narrates, proposes patterns (→ SUSPECTED tier, skim-required), and spots anomalies. The totality/residue guarantee made visible: at any moment the user can see exactly what they have not looked at. |

An *angle* is the lens; a **canvas** is the stateful per-review surface instance of one. Per review there are **five canvases plus the blast-radius overlay** — the overlay paints amber onto the other canvases and owns no surface of its own. Subtraction is not an angle; its content (over-engineering, defensive scaffolding, redundancy) lives in `finding.ruleFamily` values and noise categories, with the propose-deletion affordance riding the finding.

### 4.2 The canvas paradigm — the interaction model

([[Rennet Canvas Paradigm]], adopted 2026-08-06.) Canvases are named, addressable, event-sourced, layered projections that agents fill deterministically and the user and an orchestrator converse over. Four layers:

- **L0 substrate** — deterministic ingest, read-only.
- **L1 analysis** — validator-admitted RSP documents, deterministically placed. Fleet agents never touch a canvas; placement is a pure function; the canvas adds zero fabrication surface.
- **L2 dispositions** — **user-sovereign**. No agent may write it. It is simultaneously read state, publish payload, and handoff bundle.
- **L3 annotations** — the orchestrator's visually-distinct marks; ephemeral but session-scoped (they persist for the whole ongoing review, vanish at session end; pin promotes keepers).

Four actors, partitioned **structurally**: the engine (project/invalidate/carry/order), the fleet (emit RSP documents, nothing else), the orchestrator (describe/view/focus/annotate/propose/recompute via MCP tools), and the user (dispose/adjudicate/expand/select/pin, direct UI). The orchestrator's tool surface simply does not contain user-only or engine-only operations — "the human still disposes" is a property of the wiring, not an instruction.

### 4.3 The disposition model and the review→agent handoff loop

The **disposition** is the one data model of review action: `{anchor, type: approve | request-change | comment | question, body}` — extended by the refinement loop (§4.4) with `refined`, `published`, and an inline `thread`. One model, two destinations — the mode decides where it goes, never what it is:

- Reviewing **someone else's PR** → dispositions publish as one batched GitHub review.
- Reviewing **your own branch** → dispositions batch into a **task bundle handed to a coding harness**, which addresses them on the branch → produces a **new patchset** → Rennet **re-reviews only the DELTA**. An approved hunk that did not change stays approved.

This loop is what turns Rennet from a reading tool into a **review-driven coding loop**, and it is cheap precisely because the architecture already pays for it: immutable patchsets, occurrence-ID + lineage identity, and review state that survives a force-push. The safety properties do not relax inside the loop: the human still disposes, Rennet never pushes source code, and an agent-authored change is never "already read" because a human once read the code it replaced. Full contract: [[Rennet Contracts and Rulings]] §2.1.

### 4.4 The comment-refinement loop

([[Rennet Comment Refinement Loop]], designed 2026-08-06.) The user's raw input is **not** what gets posted. Write it messy → the agent interprets, investigates, and cleans it up → the clean version lands on the PR (or in the handoff bundle). When the raw text is unclear, the agent asks **inline, anchored to that little diff** — a per-disposition back-and-forth to clarify, suggest approaches, or confirm "is this what you mean?". The publish preview always shows the cleaned artifact; nothing unadjudicated ever leaves the machine. This extends the handoff loop to the comment-authoring side and is the "smooth and quick" principle made concrete: the user is allowed to be lazy *because* this loop exists.

### 4.5 The orchestrator and its context access

([[Rennet Orchestrator Context Access]], adopted 2026-08-06.) You always talk to **one** orchestrator harness and session, which you pick; it synthesises findings across the other harnesses and roles. Fresh sessions by default. Its context architecture is **neither dump nor cap — retrieve**:

- **The primer is a map of the context, not a container** (~2–4 KB, deterministic, versioned): review identity, freshness verdicts, count-level canvas state, the protocol card, a tool index.
- **`canvasOps@2`** — one versioned in-process MCP tool surface: the interaction ops plus a read-only retrieval family, uniform envelope, no silent caps (never-cap applied to the machine reader), staleness on every reply.
- **`context.ask`** — a background knowledge agent behind one tool; honest refusal is a first-class success.
- **The tool surface IS zoom for the orchestrator** — the product thesis pointed inward: the same altitude ladder the user has.
- The user's **current canvas/lens/view context is injected at request time** with each ask, so a terse comment is disambiguated by where they were looking ("requested a change while on the decisions lens"). Never dwell/pace metrics — those are not collected at all.

### 4.6 Read state, totality, and honesty

**Read state is action-defined**: a chunk is READ when the reviewer acts on it (approve, request-change, ask-question) — never by scroll position or dwell time. Anything merely scrolled past is at most *skimmed*, and the totality/residue guarantee reports it as unread. Done/publish block on incomplete ingestion; the noise angle is the floor that makes the residue visible. Read state never auto-carries through similarity; ambiguity fails closed.

### 4.7 Publish as preview

The paper sheet previews **exactly what leaves the machine**, context-dependent: reviewing your own unpushed branch or your own PR → it previews the **PR submission**; someone else's PR → it previews the **review it will post**, every line item, with the degradation ledger. What posts is the **refined** form of each comment (§4.4). Publish is a three-phase explicit human act, idempotent, with outcome-unknown reconciliation. Rennet never pushes source code.

### 4.8 LSP code intelligence

View the definition of any symbol in a diff, inline — Tier 0 tree-sitter index everywhere, Tier 1 TypeScript against ephemeral app-cache-owned materialisations, every answer tier-labelled, degraded-result detector load-bearing. Definitions are context, never coverage. **Open-in-editor** above every diff with copy disclosure before the click. **Impl↔tests toggle** on any diff, with "no tests reference this" as an honest first-class state.

### 4.9 GitHub interop

GitHub is one changeset source and one publish destination, behind a forge-neutral `ForgePort`. PR ingestion with SSO partial-results detection, local-diff-first, immutable head pinning; a remote head update creates a new patchset and never rewrites the active one. Publication is one batched review event. Mobile remains the long-game companion (a remote control for the desktop app, which is the server); the transport-neutral protocol boundary exists for exactly that.

### 4.10 The supporting engineering (means, not purpose)

- **The RSP surfacing DSL** — structured JSON documents against versioned schemas in `packages/protocol`; agents surface, the deterministic validator decides; agents never mint identity; quotes verified byte-for-byte. Publishable as an open spec.
- **The instruction layer** — versioned base instructions shipped with the app; user guidance layered through the settings ladder; the exact assembled prompt always inspectable. The contract is not configurable; the voice is.
- **Glass identity** — glass is chrome, code is opaque, paper is what leaves the machine; backlight blue = private-to-reviewer; amber = blast radius/disagreement only. Ratified as required reading: [[Rennet Design Doctrine]].

### 4.11 The Model Council

Rennet runs ~45 discrete jobs per review, and **being intelligent about which mind does which job is a product capability, not cost plumbing** — promoted here from a §4.10 footnote after the Luna spike proved the cheap end of the model market produces validator-admitted documents at $0. The **Model Council** ([[Rennet Model Council]]) is the named subsystem that owns it:

- A **versioned job catalogue** — ~24 deterministic jobs (no model, ever) + ~21 model-facing jobs, of which ~13 are light-tier bulk and only ~4 seats genuinely need a flagship.
- A **deterministic resolver**: `(job, availability, overrides) → (harness, model, effort)`, resolved before anything runs, with a **resolution trace** the UI can show ("ordering ran on Luna-low because: tier=light, codex available, council row 9, no override").
- **Cross-harness routing** (R39): light-tier work may run on a different installed harness than the review — Claude reviews while cheap Codex models do the light thinking. Default-on when both are installed; user-pinnable.
- The **budget gate on the live path**: the <15s / <5-invocation ceiling refused at runtime, retries counted — a mechanical gate, not a CI-only test.
- **Static forever, measured always**: the only feedback loop is a surfaced rejection-rate table a human reads and answers with a table edit. Never adaptive routing.

The user's day through the product, in order — from first run to signing the paper — is [[Rennet User Journey]].

## 5. Where it stands (2026-08-06)

The MVP is merged to `main`: local immutable Git capture, append-only SQLite review state, action-defined read progress, conservative invalidation, explicit regeneration, hardened Electron IPC, a real diff-review surface, and a green full gate across all seven Nx projects (`types`, `protocol`, `core`, `adapters`, `ui`, `instructions`-pending, `desktop`). The disposition model (slice 1) and the harness adapter protocol + Claude adapter (slice 1) have landed on main since.

Everything else in §4 is designed and **queued as GitHub issues** labelled `openspec-seed` on `rbutera/rennet` — the issue queue is the backlog, each issue a self-contained seed for an openspec proposal, worked autonomously through the pipeline in [[Rennet Contracts and Rulings]] §7. The repo ships to `main` directly (no PR ceremony), with quality gated internally before every push.

## 6. Where the depth lives

| I want… | Read |
|---|---|
| The ruling register (R1–R39), frozen core, open questions, M0 cut, spikes, the execution pipeline | [[Rennet Contracts and Rulings]] |
| The ordered user journey (first run → sign), stage ownership, built-vs-open | [[Rennet User Journey]] |
| The model council: job catalogue, assignment tables, resolver, budget gate, ledger | [[Rennet Model Council]] |
| The design register: materials, colour law, interaction laws | [[Rennet Design Doctrine]] |
| The frozen engineering contracts (project context, patchsets, invalidation, persistence, privacy, publication) | [[Rennet Architecture Contracts]] |
| Dependencies, versions, toolchain ownership | [[Rennet Dependency Standard]] |
| The interaction model in depth (canvases, layers, actors, ops) | [[Rennet Canvas Paradigm]] |
| The orchestrator's context architecture in depth | [[Rennet Orchestrator Context Access]] |
| The comment-refinement design in depth | [[Rennet Comment Refinement Loop]] |
| The append-only ledger of Rai's product decisions | [[Code Review Harness App]] (Decisions section) |
| Orientation for the building agent | [[Rennet Navi Handoff]] |
| What is proven vs. assumed | [[Rennet Evidence Gate Status]] |
| The map of every document and its role | [[Rennet Doc Architecture]] |

---

*Created 2026-08-06 in the docs consolidation (Rai: turn the docs and issues "into something coherent and complete in the repo"). Sources: the hub's Decisions ledger, the former Master Plan §1, the 2026-08-06 voice decisions (roll-up/zoom/lenses, ordering, handoff loop, refinement loop, orchestrator context), and the 2026-08-06 state-of-play synthesis.*
