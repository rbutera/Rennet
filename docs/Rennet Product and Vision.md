---
tags: [rennet, products, visions]
categories: [project]
status: active
created: 2026-08-06
updated: 2026-08-09
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Rennet Canvas Paradigm]]", "[[Rennet Orchestrator Context Access]]", "[[Rennet Comment Refinement Loop]]", "[[Rennet Model Council]]", "[[Rennet User Journey]]", "[[Rennet Design Doctrine]]", "[[Code Review Harness App]]"]
---

# Rennet Product and Vision

> **Resteer 2026-08-09:** the v3 shell and lens set are folded into this document (§1 shape-of-the-app, §4.1 six angles incl. the new Flagged lens and purified Decisions, claims retired to infrastructure, §4.7 paper-and-sign, §4.8 peek-then-pin inspector). Full record: [[Rennet v3 Resteer 2026-08-09]] and the v3 prototype (gallery https://nimbus.piranha-wyvern.ts.net:9443/).

**This is the canonical statement of what Rennet is.** Read it first. Every other document in `docs/` plays a supporting role — the authority register for rulings is [[Rennet Contracts and Rulings]], the frozen engineering contracts are [[Rennet Architecture Contracts]], and [[Rennet Doc Architecture]] maps the whole set. Where this document and a deeper document disagree on *intent*, this document wins; where they disagree on a *ruling or contract*, the deeper authority wins and this document has a bug — file it.

---

## 1. What Rennet is

**Rennet** (rennet.dev) is an MIT-licensed, local-first Electron desktop app: a **review harness**. A coding harness points a model at your codebase so it can *write*; a review harness points the coding harnesses already on your machine at a change so you can *read*.

A changeset too big to hold in your head is rolled up into logical cohorts you can read from base principles up, its decisions surfaced — never hidden, never capped — and the result lands either as a normal GitHub PR review or, on your own branch, as a batched set of requests handed straight back to a coding agent, after which Rennet re-reviews only what changed.

**Positioning headline (settled):** *You stopped writing the code. You still have to answer for it.*

**The shape of the app (v3 shell, [[Rennet v3 Resteer 2026-08-09]]).** You land on a **Projects list**. You add a project by pointing Rennet at a **workspace** or a **project repo**, finding the path, and confirming its worktrees; then it **processes** the repo, a narrated context dump that says what it is reading in real time and then becomes the project. That processing moment is the app's identity moment (the delightful narrated animation is post-MVP; the MVP ships a plain spinner over the real narration feed). Clicking a project opens a **two-zone landing**: *Yours* (your local worktrees and branches, private to this machine) and *Team* (every PR, including your own). From either zone you enter the review surfaces, accumulate your dispositions into one editable draft, and **sign the paper**. Execution mode lives as one glyph in the title bar, defaulting to auto, present on every in-project screen; reviewing code with a model is Rennet's whole job, so it just runs — there is no mode that asks permission before a model turn (only a read-only glyph for a retrospective review). There is no consent banner and no onboarding wizard: first run is simply the empty state of the Projects list.

The essentials, all settled and frozen:

- **Local-first, no Rennet backend, no telemetry.** Material sent through a selected harness may leave the machine for that harness's provider; every run discloses and records its assembled context. Never claim universally that nothing leaves the machine.
- **BYOK via the user's own installed harnesses** — Claude Code first (an `@anthropic-ai/claude-agent-sdk` integration that spawns the user's own installed `claude`, so auth stays on their subscription at no per-token cost), then codex and omp behind the same adapter protocol.
- **Zero-config is the North Star.** Install, and the harnesses already on your machine are auto-detected and just work. No API-key ceremony.
- **The human disposes.** No auto-approve, no auto-comment, nothing another human sees without an explicit human act. It is the whole thesis: *you still have to answer for it*.
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

Every changeset is decomposed into sub-400-LOC chunks and read through six concurrent **angles** (the v4 lens set, revised by the 2026-08-09 v3 resteer: Spec becomes a structured artifact viewer, **Flagged** joins as a new lens, Decisions is purified, and the standalone claims lens is retired; its hunk-to-requirement mapping survives as infrastructure feeding the Spec view's coverage chips and the view-test wiring):

| # | Angle | Species | One line |
|---|---|---|---|
| 0 | **Spec** | queue over requirements | What this change was *supposed* to be: committed spec (Kiro/OpenSpec/superpowers), PR body, ticket; derived-and-marked when nothing is committed. Rendered as a **structured artifact viewer** (header band, prose spine, capability grid, requirements and scenarios as first-class disposition anchors, coverage chips, honest `unimplemented` state), never raw markdown. The only angle that exists on a zero-hunk (spec-only) changeset. Its coverage chips are fed by the hunk-to-requirement claims mapping (infrastructure, no longer a lens of its own; the UNCLAIMED bucket surfaces here as the scope-creep detector, "would that test have failed"). |
| 1 | **The sequence** | sequence | Post-hoc reading order, named switchable strategies (layered / tests-first / spine-first), prose collapsed. |
| 2 | **Decisions** | queue | The calls only you can make: the grouped decisions the implementer (or their agent) made, discerned from the spec, the PR body, and the diff, each with **evidence chips** (the hunks and files it is read from, click-to-jump) and a reconstructed WHY marked as reconstructed. **Never capped or truncated**, rolled into cohorts, in logical comprehension order (agent-produced over the DAG baseline), collapsible. The evidenced / mechanical / contestable triage taxonomy is dropped from the UI (that classification layer was the mutation Rai flagged in the v3 resteer). |
| 3 | **Flagged** | queue | The automated-review output: the findings the model council and dual review produced, each with severity, an agreement state (both models concur / models disagree), and an anchor. The flags still render as marks at their anchors on the code surfaces; this lens is the **index that jumps to them**, never the house that holds them. New in the v3 resteer. |
| 4 | **Blast radius** | overlay | Cheap explainable signals only (irreversibility, contract surface, deletions, fan-in, CODEOWNERS, safety-net-weakening preset). Never churn-heat. **An overlay, never an ordering input.** |
| 5 | **Noise** | floor | Everything that earned no place above, grouped, categorised, summarised. Deterministic checkers are the only admission authority for VERIFIED noise; the LLM narrates, proposes patterns (→ SUSPECTED tier, skim-required), and spots anomalies. The totality/residue guarantee made visible: at any moment the user can see exactly what they have not looked at. |

The bidirectional hunk-to-requirement and claim-to-test mapping (formerly the standalone claims-and-evidence lens) persists as **infrastructure**: it computes the Spec view's coverage chips, the `unimplemented` and UNCLAIMED states, and the `view test` / `view implementation` wiring. It no longer owns a surface.

An *angle* is the lens; a **canvas** is the stateful per-review surface instance of one. Per review there are **five canvases (spec, sequence, decisions, flagged, noise) plus the blast-radius overlay**: the overlay paints amber onto the other canvases and owns no surface of its own. Subtraction is not an angle; its content (over-engineering, defensive scaffolding, redundancy) lives in `finding.ruleFamily` values and noise categories, with the propose-deletion affordance riding the finding.

### 4.2 The canvas paradigm — the interaction model

([[Rennet Canvas Paradigm]], adopted 2026-08-06.) Canvases are named, addressable, event-sourced, layered projections that agents fill deterministically and the user and an orchestrator converse over. Four layers:

- **L0 substrate** — deterministic ingest, read-only.
- **L1 analysis** — validator-admitted RSP documents, deterministically placed. Fleet agents never touch a canvas; placement is a pure function; the canvas adds zero fabrication surface.
- **L2 dispositions** — **the user's own layer**, simultaneously read state, publish payload, and handoff bundle.
- **L3 annotations** — the orchestrator's visually-distinct marks; ephemeral but session-scoped (they persist for the whole ongoing review, vanish at session end; pin promotes keepers).

Four actors, each with its own job: the engine (project/invalidate/carry/order), the fleet (emit RSP documents), the orchestrator (describe/view/focus/annotate/propose/recompute via MCP tools), and the user (dispose/adjudicate/expand/select/pin, direct UI).

### 4.3 The disposition model and the review→agent handoff loop

The **disposition** is the one data model of review action: `{anchor, type: approve | request-change | comment | question, body}` — extended by the refinement loop (§4.4) with `refined`, `published`, and an inline `thread`. One model, two destinations — the mode decides where it goes, never what it is:

- Reviewing **someone else's PR** → dispositions publish as one batched GitHub review.
- Reviewing **your own branch** → dispositions batch into a **task bundle handed to a coding harness**, which addresses them on the branch → produces a **new patchset** → Rennet **re-reviews only the DELTA**. An approved hunk that did not change stays approved.

This loop is what turns Rennet from a reading tool into a **review-driven coding loop**, and it is cheap precisely because the architecture already pays for it: immutable patchsets, occurrence-ID + lineage identity, and review state that survives a force-push. Two properties hold inside the loop: the human still disposes, and an agent-authored change is never "already read" because a human once read the code it replaced. Full contract: [[Rennet Contracts and Rulings]] §2.1.

### 4.4 The comment-refinement loop

([[Rennet Comment Refinement Loop]], designed 2026-08-06.) The user's raw input is **not** what gets posted. Write it messy → the agent interprets, investigates, and cleans it up → the clean version lands on the PR (or in the handoff bundle). When the raw text is unclear, the agent asks **inline, anchored to that little diff** — a per-disposition back-and-forth to clarify, suggest approaches, or confirm "is this what you mean?". The publish preview always shows the cleaned artifact; nothing unadjudicated ever leaves the machine. This extends the handoff loop to the comment-authoring side and is the "smooth and quick" principle made concrete: the user is allowed to be lazy *because* this loop exists.

### 4.5 The orchestrator and its context access

([[Rennet Orchestrator Context Access]], adopted 2026-08-06.) You always talk to **one** orchestrator harness and session, which you pick; it synthesises findings across the other harnesses and roles. Fresh sessions by default. Its context architecture is **neither dump nor cap — retrieve**:

- **The Repo Map is the baseline** (user-facing name, Rai 2026-08-09): the project's `.rennet` context pack, mined once when you open the project, deterministic ProjectSnapshot + evidence-anchored knowledge layer + the primer below. It is fed, alongside a per-diff context pack, to both the review agents and the orchestrator so neither burns its window re-reading the codebase; the review agents' own PR review becomes the **Flagged lens** (R49). **Stored local-only by default** (derived map in an app-owned store keyed by repo identity; human config committable in `.rennet/`; Rennet discovers a committed map, mirroring is per-project opt-in), R55. The nesting, proactive-update, and net-novel directions are adopted (fable advice, R54); build tracking in #141-#144.
- **The primer is a map of the context, not a container** (~2–4 KB, deterministic, versioned): review identity, freshness verdicts, count-level canvas state, the protocol card, a tool index.
- **`canvasOps@2`** — one versioned in-process MCP tool surface: the interaction ops plus a read-only retrieval family, uniform envelope, no silent caps (never-cap applied to the machine reader), staleness on every reply.
- **`context.ask`** — a background knowledge agent behind one tool; honest refusal is a first-class success.
- **The tool surface IS zoom for the orchestrator** — the product thesis pointed inward: the same altitude ladder the user has.
- The user's **current canvas/lens/view context is injected at request time** with each ask, so a terse comment is disambiguated by where they were looking ("requested a change while on the decisions lens"). Never dwell/pace metrics — those are not collected at all.

### 4.6 Read state, totality, and honesty

**Read state is action-defined**: a chunk is READ when the reviewer acts on it (approve, request-change, ask-question) — never by scroll position or dwell time. Anything merely scrolled past is at most *skimmed*, and the totality/residue guarantee reports it as unread. Incomplete ingestion is shown in the residue and on the sheet, and the user publishes anyway if they want to. The noise angle is the floor that makes the residue visible. Read state never auto-carries through similarity; ambiguity fails closed.

### 4.7 Publish as preview

The paper sheet previews **exactly what leaves the machine**, context-dependent: reviewing your own unpushed branch or your own PR → it previews the **PR submission**; someone else's PR → it previews the **review it will post**, every line item, with the degradation ledger. What posts is the **refined** form of each comment (§4.4). Publish is an explicit human act, idempotent, with outcome-unknown reconciliation; on your own branch, signing the paper submits the PR, push included. This is the **paper-and-sign**:

> the paper is the one solid, signable object in an otherwise translucent product, and the review it posts to GitHub is the human's **signed verdict**, previewed line for line before it leaves the machine.

### 4.8 LSP code intelligence

View the definition of any symbol through a **peek-then-pin inspector** (v3 resteer): a plain click opens a floating glass card near the symbol (signature, doc comment, first lines of the definition, origin path, tree-sitter-vs-TypeScript honesty label); pinning docks it into the right rail as a mini code browser whose navigation never moves the diff. Never inline, never reflowing. Tier 0 tree-sitter index everywhere, Tier 1 TypeScript against ephemeral app-cache-owned materialisations, every answer tier-labelled, degraded-result detector load-bearing. Definitions are context, never coverage. **Open-in-editor** on the card and above every diff, with copy disclosure before the click. A single context-labelled button reads `view test` on an implementation hunk and `view implementation` on a test, with "no tests reference this" as an honest first-class state.

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

The MVP is merged to `main`: local immutable Git capture, append-only SQLite review state, action-defined read progress, conservative invalidation, explicit regeneration, typed Electron IPC, a real diff-review surface, and a green full gate across all seven Nx projects (`types`, `protocol`, `core`, `adapters`, `ui`, `instructions`-pending, `desktop`). The disposition model (slice 1) and the harness adapter protocol + Claude adapter (slice 1) have landed on main since.

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
| The map of every document and its role | [[Rennet Doc Architecture]] |

---

*Created 2026-08-06 in the docs consolidation (Rai: turn the docs and issues "into something coherent and complete in the repo"). Sources: the hub's Decisions ledger, the former Master Plan §1, the 2026-08-06 voice decisions (roll-up/zoom/lenses, ordering, handoff loop, refinement loop, orchestrator context), and the 2026-08-06 state-of-play synthesis.*
