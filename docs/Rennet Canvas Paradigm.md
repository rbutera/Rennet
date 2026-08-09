---
title: Rennet Canvas Paradigm
tags: [rennet, architecture, canvases, orchestrator]
categories: [project]
status: draft-for-rai
created: 2026-08-06
related: ["[[Rennet Contracts and Rulings]]", "[[Wingman Surfacing DSL and Model Routing Plan]]", "[[Rennet Architecture Contracts]]", "[[Rennet v3 Resteer 2026-08-09]]"]
---

# Rennet Canvas Paradigm

*Design doc, 2026-08-06. Responds to Rai's framing: "Rennet is, at its core, a bunch of **canvases** that the agent can fill and manipulate and the user can interact with." Designed against the two reference models he pointed at — the MCP Apps extension (SEP-1865, `io.modelcontextprotocol/ui`) and mcp_excalidraw — both read firsthand for this doc. Honours the 2026-08-06 corrections: MIT throughout, roll-up hard-baked, logical ordering, decisions never capped, action-defined read state, the review→agent handoff loop (Master Plan §2.1).*

**Headline recommendation up front: adopt the canvas paradigm as the product's interaction model — it is ~70% the existing architecture renamed, and the remaining 30% (the interaction contract and the primed orchestrator) is exactly the part OQ9 already says Rennet must build for itself. Implement it as a hybrid: a bespoke event-sourced canvas state model inside `core`, exposed to the orchestrator through an MCP tool surface that borrows the MCP Apps interaction grammar (tool visibility, context-update notifications) without adopting its iframe/`ui://` rendering layer, which solves a problem Rennet does not have.**

*Roster aligned to the [[Rennet v3 Resteer 2026-08-09]] (2026-08-09). The five review canvases are now **spec, sequence, decisions, flagged, noise** (the blast-radius overlay is unchanged, so still five canvases plus one overlay). The standalone **claims** lens is retired: its requirement-to-hunk coverage mapping folds into the spec canvas as coverage chips, and **flagged** takes the fifth slot as the index of the automated-review layer (model-council findings and dual-review disagreements), rendering its flags as marks at their anchors on the other canvases. The interaction contract, the layer model, the primer, and everything else below stand unchanged.*

---

## 1. Does the canvas metaphor track with the existing model?

Yes — closely enough that most of the vision's six steps are the ratified architecture wearing a better name. The mapping, step by step against Rai's flow:

| Vision step | Existing object | Status |
|---|---|---|
| 1. Point at a workspace / repo | The four frozen nouns already include **workspace** (repo/worktree/workspace/changeset, Master Plan §3 "Data model") | **Same object.** One gap: context contracts are per-repo (§1 of the gap table below) |
| 2. Pull existing context, incrementally refresh if stale, LLM + guidelines, based on the default branch | `.rennet/` **ProjectSnapshot** (deterministic, pinned to default-branch OID, incremental shard rebuild, byte-equivalent to full rebuild) + `knowledge/` (LLM-derived, evidence-carrying, guideline-driven) — Contracts §2.3–2.4, R27/R30 | **Same object.** Already designed exactly as described — see §4 |
| 3. Fleet of mixed agents, cheap doing cheap things, expensive doing expensive things, base context in mind | The **model-routing matrix** (deterministic / light / heavy tiers, DSL plan §5) + the RSP document emission pipeline | **Same object.** "Fleet" is a better name for what §5.2's 25 routing rows already are |
| 4. Analysis deterministically placed into canvases for the different lenses | The **validator-as-gate** + event store + per-angle projections (DSL plan §4; R17). Agents emit documents; deterministic code admits and projects them | **Same mechanism**, one genuinely new object: the canvas as a *named, stateful, addressable surface* rather than an implicit render (§2) |
| 5. Orchestrator arrives primed: knows what has been done, its context, how to interact with the canvas, what interactions mean | **OQ9** (refined 2026-08-06: one user-picked orchestrator, fresh sessions default) — but priming, the interaction vocabulary, and interaction *semantics* are undesigned. T3 research confirmed nothing to mine here | **Genuinely new.** This doc's §3 and §4.3 |
| 6. User and orchestrator converse about the code via the canvases | Nothing. M0 has "diff chat (one harness)" and anchored threads, but no contract making the canvas the shared medium of the conversation | **Genuinely new.** This doc's §3 |

**What is the same object renamed:** the six lenses' reading surfaces, the RSP documents that back them, the deterministic fleet, the tier routing, the base-branch context, dispositions, the totality/residue guarantee.

**What is genuinely new (and needed):**

1. **The canvas as an addressable object with an operation vocabulary.** Today the pipeline is one-directional: agents emit → validator admits → store → render. There is no defined way for *anyone* — orchestrator or user — to operate on the rendered surface as a first-class act with defined meaning. The DSL plan governs what agents may *say*; nothing governs what an orchestrator may *do to what the user is looking at*.
2. **The interaction-semantics contract** — "what interactions mean." OQ4 defined one interaction (a disposition = read). Everything else (select, focus, highlight, ask-about-this, propose) is unnamed.
3. **The orchestrator priming manifest** — a deterministic assembly of "what has been done" that a fresh session can be handed. Provenance blocks (DSL §2.2) already record everything needed; nothing assembles them into a primer.
4. **Workspace-level context composition** — multi-repo workspaces need an aggregation over per-repo snapshots that no contract currently describes.

One vocabulary ruling this doc proposes (Rai to confirm): **"angle" and "canvas" are different words for different things and both survive.** An *angle* is the lens — the analysis dimension, the species, the document types that feed it. A *canvas* is the stateful surface instance of an angle for one review. Six angles; per review, **five canvases plus one overlay**, because the species table already says so: spec, sequence, decisions, flagged, and noise each get a canvas; **blast radius stays an overlay** — it paints amber onto the other canvases and owns no surface of its own (Master Plan §1; DSL plan §5.2 row 5). Renaming it to "six canvases" would silently promote the overlay to a queue, which R11/lens-v4 deliberately did not do.

---

## 2. What is a canvas, concretely?

### 2.1 Definition

A **canvas** is a named, addressable, layered projection over the event store, scoped to `(reviewId, patchsetId, angle)`. It is *not* a freeform drawing surface (the excalidraw analogy is about the interaction shape, not the geometry): every element on a Rennet canvas is anchored to code or to an admitted RSP document via the existing anchor grammar. A canvas can be rebuilt from the event store at any time (projections are disposable, R17); canvas *operations* are events, append-only, so the conversation's manipulation history survives exactly the way review state does.

### 2.2 Data model (PROPOSAL)

```ts
interface Canvas {
  canvasId: CanvasId                 // deterministic: hash(reviewId, patchsetId, angle)
  reviewId: ReviewId
  patchsetId: PatchsetId             // canvases are per-patchset; the delta re-review
                                     // (Master Plan §2.1) produces a NEW canvas whose
                                     // unchanged-and-approved elements carry forward
  angle: 'spec' | 'sequence' | 'decisions' | 'flagged' | 'noise'
  layers: {
    substrate:  SubstrateLayer       // L0 — read-only
    analysis:   AnalysisLayer        // L1 — deterministically placed
    disposition: DispositionLayer    // L2 — user-sovereign
    annotation: AnnotationLayer      // L3 — orchestrator-writable, visually distinct
  }
  overlay: BlastRadiusPaint[]        // amber paint from the overlay angle; never a layer
                                     // the orchestrator or user writes
}
```

**L0 Substrate** — the hunk occurrences / chunks / requirement list the canvas is *about*: slices of the occurrence manifest plus, for spec, the parsed requirement set. Deterministic ingest owns it entirely. Nothing above may mutate it.

**L1 Analysis** — the admitted RSP documents, projected into canvas elements. This is the "deterministically placed" step of the vision, and the placement rule is the load-bearing sentence of this design:

> ⭐ **Fleet agents never touch a canvas. They emit RSP documents; the validator admits them; a deterministic projector places admitted content onto canvas elements.** Placement — which canvas, which cohort, which position — is a pure function of the admitted document plus the deterministic ordering rules. This is Rai's "all that analysis is deterministically placed into the canvases" taken literally, and it means the canvas layer adds **zero** new fabrication surface: everything on L1 passed the same validator everything already passes.

Element shapes per canvas (all reference admitted docs by `docId` + anchor; canvas elements mint no identity):

| Canvas | L1 elements | Placement rule |
|---|---|---|
| decisions | **cohort** elements containing decision elements | grouping + **logical-dependency order** (correction 8) computed deterministically from the decomposition DAG position of each decision's anchored chunk (candidate mechanism (c) of the C-report's OQ1 — see Open Questions); collapsible, **never capped** (correction 4) |
| sequence | chunk elements in `readingOrder` (topological, V103) | the decomposition proposal *is* this canvas's L1 |
| spec | requirement elements, coverage edges | from `spec.model`; derived requirements carry their `reconstructed/unconfirmed` marks |
| flagged | finding elements: severity, agreement state (both concur / models disagree), anchor | from admitted `finding` docs; an index whose flags render as marks at their anchors on the other canvases (the automated-review layer's own lens, not a house) |
| noise | verified groups, SUSPECTED groups, anomaly callouts | deterministic checkers admit VERIFIED; the floor renders the residue guarantee |

**L2 Disposition** — the user's dispositions, in the one settled model: `{anchor, type: approve | request-change | comment | question, body}` (Master Plan §2.1). This layer is **user-sovereign**: no agent, including the orchestrator, may write to it. It is simultaneously (a) read state (OQ4: read is action-defined), (b) the publish payload on someone else's PR, and (c) the handoff bundle on your own branch. The canvas is therefore also *where the handoff loop lives*: batching L2 to a coding harness, receiving the new patchset, and opening the successor canvas whose lineage-carried approved elements arrive pre-settled is the loop of §2.1 expressed as canvas state.

**L3 Annotation** — the orchestrator's marks: highlights, callouts, links between elements, proposals. Visually distinct (glass doctrine: this is chrome, and it must *look* like the agent's hand, never like L1 analysis or L2 human judgment). Every L3 element is ephemeral-by-default (cleared when the conversation turn that motivated it is superseded) unless the user pins it. L3 can never alter L1 content, L2 state, cohort membership, or ordering.

### 2.3 How the orchestrator reads and manipulates it

Through the operation contract in §3, transported as MCP tools (§5). The excalidraw lesson applied: what made that canvas work for agents was not drawing primitives but the **read-back pair** — `describe_scene` (structured summary) + `get_canvas_screenshot` (rendered truth) — enabling a see-verify-fix loop. Rennet's equivalents: `canvas.describe` (structured: elements, cohorts, disposition counts, residue) and `canvas.view` (what the user is currently looking at: open canvas, expanded cohorts, viewport anchor, current selection). The second is what makes the conversation *deictic* — the orchestrator can say "the second decision in the cohort you have open" because it can see the same surface state the user sees.

---

## 3. The interaction contract

The heart of "how to interact with the canvas and what interactions mean." Four actors, four disjoint capability sets. The MCP Apps `visibility: ["model", "app"]` split (SEP-1865) is the right shape here: every operation below is tagged with who may invoke it, and the boundary is enforced structurally (the orchestrator's MCP surface simply does not contain the user-only or engine-only operations), never by prompt.

### 3.1 Operations by actor

**(a) Deterministic engine** (never exposed as tools; internal commands):

| Op | Meaning |
|---|---|
| `project(doc)` | An admitted RSP document becomes L1 elements per the placement rules. The only path onto L1 |
| `invalidate(scope, reason)` | R29: elements over directly-affected analysis → `invalid`; dependency/context-affected → `potentially-invalid`. Stale content stays visible, marked |
| `carry(lineage)` | On a new patchset: build the successor canvas; `exact`/`one-to-one` lineage carries L2 approvals forward; ambiguity fails closed (R8) — the element arrives unread |
| `order(cohorts)` | Recompute logical-dependency order. Deterministic, hard-baked (corrections 7+8): neither agent nor project config can change the grouping behaviour |

**(b) Fleet agents:** exactly one operation — **emit RSP documents**. No canvas access, no read-back, no placement influence beyond what their admitted documents contain. This is deliberate and is the existing "agents surface, the validator decides" doctrine unchanged.

**(c) Orchestrator** (MCP tools, `visibility: model`):

| Op | Signature (sketch) | What it MEANS |
|---|---|---|
| `canvas.describe` | `(canvasId?, depth?)` → structured state | "Tell me what is on the surface." Includes residue and disposition coverage, so the orchestrator can honestly answer "what have you not looked at yet" |
| `canvas.view` | `()` → open canvas, expanded cohorts, viewport anchor, selection | "Tell me what the user is looking at." Read-only deixis |
| `canvas.focus` | `(anchor \| elementId)` | "Look here." Scrolls/opens the target for the user. Purely presentational: **no state changes, nothing becomes read.** The user's attention is invited, never spent on their behalf |
| `canvas.annotate` | `(target, kind: highlight \| callout \| link, body?)` → L3 element | "I am marking this for our conversation." Ephemeral by default; pinnable by the user only |
| `canvas.propose` | `(kind: disposition \| regroup \| split, payload)` → proposal element | "I suggest — you decide." A proposed disposition renders on L3 *next to* the target with an accept/edit/dismiss affordance; **accepting is a user act and only then does it become L2** (and thereby read). A regroup/split proposal follows the R9 pattern exactly: complete proposal, deterministic validation, user accepts/edits. ⛔ Under hard-baked grouping the orchestrator may propose regroups within the deterministic rules for *this review*; it cannot change grouping *behaviour* |
| `canvas.recompute` | `(scope, angle?)` | "Re-run the fleet on this slice." Explicit, budget-gated by the same RoutePlan machinery (R10); maps to R29's explicit affected-only regeneration — model-backed regeneration stays never-automatic, and an orchestrator tool call is an explicit act the user sees |
| `context.query` | `(question about snapshot/knowledge)` | Read the base-branch context (§4) without re-deriving it |

⛔ **The orchestrator cannot:** write L2 (disposition, approve, mark read), edit or delete L1, reorder or re-cohort anything outside an accepted proposal, touch the publish sheet, or see canvases of another review. The safety line of Master Plan §2.1 — "the human still disposes" — becomes a structural property of the tool surface rather than an instruction.

**(d) User** (direct UI; some ops also emit context updates to the orchestrator, §3.2):

| Op | What it MEANS |
|---|---|
| `disposition(anchor, type, body)` | The sovereign act. Creates read state (OQ4), feeds publish or the handoff bundle. The only op that makes something READ |
| `accept / edit / dismiss (proposal)` | Adjudicate an orchestrator proposal. Edit-then-accept is first-class (the R9 pattern) |
| `expand / collapse (cohort)` | Navigation only. **Explicitly not read state** — the totality guarantee keeps reporting collapsed content as unread |
| `select(element) + ask` | "This thing — talk to me about it." Selection flows into the orchestrator's context as a structured event; the answer may arrive as prose, as annotations, or both |
| `pin / clear (annotation)` | Promote an L3 mark to persistent, or sweep the agent's marks away |

### 3.2 What interactions mean *to the orchestrator*: the context-update stream

The second half of "what interactions mean" is the direction MCP Apps formalises as `ui/notifications/*` and `ui/update-model-context`: **user interactions are structured events pushed into the orchestrator's context**, not things the orchestrator must poll for or guess at. Rennet adopts that grammar internally:

| User act | Event pushed to orchestrator context |
|---|---|
| selects an element | `{event: "selected", anchor, elementSummary}` |
| dispositions | `{event: "disposed", anchor, type, body}` — so the orchestrator's mental model of coverage stays current without re-describing |
| accepts/edits/dismisses a proposal | `{event: "proposal-adjudicated", proposalId, outcome, editedPayload?}` — dismissals teach; the orchestrator sees its proposal was declined *and how it was edited* |
| opens a canvas / expands a cohort | `{event: "viewing", canvasId, cohortId?}` — cheap deixis, batched |

Every pushed event is visible in the open-assembled-prompt panel like everything else that enters a prompt (DSL §6.3 doctrine) — the conversation's shared state is inspectable, byte for byte.

### 3.3 Where the reference models actually land

- **mcp_excalidraw** contributes the *operation shape*: small CRUD-plus-query tool surface, structured `describe` + rendered read-back, agent and human co-present on one live surface, human watching the agent's marks appear. It is confirmation the interaction loop works, not code to use: its canvas is freeform geometry with in-memory state; Rennet's is anchored, validated, event-sourced state. Nothing to import.
- **MCP Apps** contributes the *contract grammar*: tool visibility split (`model`/`app`), host-controlled capability exposure, structured user-interaction → model-context updates, tool-input/result streaming into a live surface. Rennet is the **host** in this relationship (see §5) — it borrows the grammar without the rendering stack.

---

## 4. Base-branch workspace context as a first-class input

### 4.1 Mostly already designed — say so and reuse it

Rai's step 2 is, almost clause for clause, Contracts §2 + R27/R30:

- **Where it lives:** `.rennet/` — `project.jsonc`, `snapshot/` (deterministic shards + manifest), `knowledge/` (Contracts §2.1). Visibility `local` by default or `git-visible` (§2.2).
- **Always the default branch:** `ProjectSnapshot` is pinned to the resolved default-branch OID, with the resolution order specified (forge metadata → symbolic HEAD → configured upstream → explicit setting; §2.3).
- **Incrementally refreshed if stale:** default-branch advance → changed-path closure → rebuild only affected shards → byte-identical to full rebuild (§2.4). Freshness is evaluated at use time (`current/updating/stale/failed`) and **stale context is never consumed silently** (R30).
- **"Using an LLM with guidelines":** this is the `knowledge/` layer, and the two-layer split matters and should be kept: the **snapshot is deterministic and model-free** (byte-reproducible); the **knowledge layer is where the LLM works** — guideline-driven, every learned statement carrying evidence, provenance, confidence, and the snapshot it was learned against; model-derived knowledge is a labelled hypothesis until confirmed (§2.1). The vision sentence should not be read as making the snapshot itself LLM-produced — an LLM-refreshed *map* would surrender byte-equivalence and freshness-by-fingerprint, which is what makes "never consume stale context" checkable.

### 4.2 The genuine gap: workspace-level composition

`.rennet/` is repository-local; a workspace spanning repos has no context object. **ADOPTED (2026-08-09, R54):** a `WorkspaceContext` that is a thin deterministic composition, the member repos' current `ProjectSnapshot` ids plus cross-repo edges (dependency references between members, shared contract packages), living in app-owned storage, not in any one repo. Freshness is the conjunction of member freshness; one stale member makes the workspace context `stale` with the member named. Knowledge stays per-repo (evidence anchors are repo-scoped); workspace-level learned statements are LATER. **Composition rule (folded from the repo-map advice, R54):** maps compose BY REFERENCE, never by inlining, every cross-map edge carrying (identity, pinned OID, content digest); the unit of a map is one git repository, with an internal scope tree derived from workspace tooling (pnpm/Nx/cargo/go.work) rather than folder heuristics, and a submodule is a separate `RepoRecord` pinned at the gitlink OID. One uniform recursion covers monorepo, submodule, and workspace-with-submodules. Design adopted here; build still sequenced later (§5.3).

### 4.3 The primer: how context reaches the canvases and the orchestrator

Two consumers, two mechanisms:

**Fleet:** unchanged — context documents enter prompts through the existing context pipeline (DSL §6.3 slots 6–7), snapshot sections fingerprinted into `inputDigest`. "All with the base-branch context in mind" is already how the pipeline assembles.

**Orchestrator:** new object, the **priming manifest** — a deterministically assembled document handed to the fresh orchestrator session (fresh-by-default per OQ9):

```
primer = {
  workspace/repo identity + snapshot ids + freshness verdicts,
  knowledge digest (top learned statements, confidence-labelled),
  the review: changeset source, patchset lineage position,
    // "delta re-review of ps_03; 14 of 19 elements carried approved"
  the run ledger: which fleet tasks ran, tiers, models, budgets spent,
    what was admitted vs rejected      // from provenance blocks, §2.2
  canvas state summary: per-canvas element/cohort/disposition counts, residue,
  the interaction contract itself     // §3 — "how to interact and what it means"
    + the ordering principle (slot 6 of the prompt contract: LOGICAL, ground-up)
}
```

Assembly is deterministic, versioned like a base instruction, and inspectable in the open-assembled-prompt panel. "The orchestrator is primed" is then a checkable property — the primer's digest lands in the orchestrator session's provenance — rather than a hope.

---

## 5. Recommendation: bespoke state, MCP-shaped interface — a hybrid, precisely drawn

### 5.1 The decision

**Canvas state and placement: bespoke, inside `core`.** Event-sourced canvas ops, projections, lineage carry, deterministic ordering — this is review state, governed by R17/R28/R29/R8, reachable from the renderer only through the existing IPC command map (R19/R20). No external protocol involved; putting an interop layer inside the state model would buy nothing and cost the invariants.

**Orchestrator-facing interface: MCP tools, served by Rennet.** Rennet exposes the §3.1(c) operations as an MCP server attached to the orchestrator session. Concretely buildable today: the ratified Claude adapter is an `@anthropic-ai/claude-agent-sdk` integration (R2), and the SDK's `query()` accepts MCP server wiring, including in-process servers — so the canvas tools ride the session Rennet already spawns. Codex and omp likewise speak MCP, which keeps the orchestrator-slot harness-agnostic: **the canvas tool surface is the same contract for all three slots**, satisfying the no-`if (harness === X)` rule at the interaction layer for free, and giving schema-constrained tool calls (the DSL's strongest error-reduction lever) without inventing a second format.

**MCP Apps wholesale: no — Rennet is the host, not the guest.** The Apps extension solves *rendering a server's UI inside someone else's chat host* (sandboxed iframe, `ui://` resources, CSP negotiation, postMessage transport). Rennet owns its renderer; its canvases are its own UI. Adopting the full apps dialect internally would add an iframe bridge with no consumer. What the Apps spec is *right* about for Rennet is the grammar — and that is adopted deliberately:

| Borrowed from MCP Apps | Rennet form |
|---|---|
| `visibility: ["model", "app"]` tool split | actor-partitioned op sets (§3.1), enforced structurally |
| `ui/update-model-context` | the user-interaction → orchestrator context-update stream (§3.2) |
| `ui/notifications/tool-input` / `tool-result` streaming into a live surface | fleet/orchestrator activity rendering onto canvases as it happens |
| host controls capability exposure | Rennet decides per-session which canvas tools the orchestrator gets |

**The aspirational third leg (LATER, and worth keeping alive):** because the interface is already MCP-shaped, publishing **read-only Rennet canvases as genuine MCP Apps** — a `ui://` canvas resource another host (Claude Desktop et al.) renders — becomes a distribution option rather than a rewrite: same op vocabulary, apps transport bolted on at the edge. Under MIT (correction 1) the canvas op vocabulary can ship as part of the open RSP spec family. Not in any near-term cut; the design just should not foreclose it, and this one does not.

### 5.2 Tradeoffs stated honestly

- *Hybrid vs bespoke-only:* bespoke-only would need each harness taught a private interaction dialect by prompt — exactly the fabrication surface the DSL exists to close. MCP costs a server inside the app (small; in-process) and buys schema-constrained calls plus harness-neutrality.
- *Hybrid vs apps-wholesale:* wholesale buys third-party-host rendering nobody needs yet, and costs sandboxing/CSP/postMessage machinery inside an app that already owns its window. The extension is also young; tracking a moving spec at the core of the product is risk with no near-term payoff. Borrowing the grammar keeps the exit open.
- *Real cost of the hybrid:* the op vocabulary becomes a compatibility surface once the orchestrator depends on it — version it like a docType from day one (`canvasOps@1`).

### 5.3 Near-term vs aspirational

**Buildable in the near term** (mostly M0 objects rearranged): canvas state model + deterministic placement over the M0 angles; L2 dispositions (M0 already has the model); L3 annotations + proposals; the canvas MCP server with `describe / view / focus / annotate / propose`; the priming manifest v1; the context-update stream for `selected` and `disposed`.

**Aspirational:** `canvas.recompute` (needs the affected-only regeneration UX, R29); regroup/split proposals (needs the decomposition-proposal edit flow); workspace-level context composition (design adopted 2026-08-09, R54; build still later); canvases-as-MCP-Apps in third-party hosts; multi-orchestrator or N=3 disagreement rendered on-canvas.

---

## OPEN QUESTIONS / DECISIONS for Rai

1. **Vocabulary:** confirm *angle* = lens, *canvas* = per-review stateful surface; five canvases + blast-radius overlay (not six canvases). (§1)
2. **The decisions-cohort ordering mechanism** (carried from the C-report, now load-bearing for canvas placement): deterministic post-pass ordering decisions by their anchored chunk's DAG position is this doc's assumed answer — confirm, or pick agent-emitted decision edges instead; and does `salience` survive as a within-cohort tiebreak? (§2.2)
3. **Annotation lifetime:** ephemeral-by-default with user pinning — right default? The alternative (persistent-by-default) silts the canvas up with stale agent marks. (§2.2 L3)
4. **May the orchestrator *draft* dispositions in bulk** (e.g. "propose approve for all 12 verified-noise groups") as one proposal element, or only per-anchor? Bulk is powerful and edges toward auto-approve territory; per-anchor is safer and slower. (§3.1)
5. **`canvas.view` privacy line:** the orchestrator seeing the user's live viewport/selection is what enables deixis, and is also attention-surveillance of a mild kind. In-scope for a local-first single-user tool, but pace/coverage privacy is elsewhere "not a setting" — confirm the orchestrator seeing *view state* (never dwell/pace metrics) is on the acceptable side of that line. (§2.3)
6. **Primer budget:** the priming manifest competes with conversation for the orchestrator's context window. Cap it like an instruction budget (8KB-ish) with overflow behaviour defined, or let it scale with review size?
7. **OQ17 closure ride-along:** this design assumes grouping hard-baked (correction 7); the Master Plan still records OQ17 as open — close it when adopting this doc.

## ⚠️ Where this reframes the existing plan

1. **Master Plan OQ9** graduates from a refined note to a designed subsystem: the orchestrator model gains the tool surface (§3.1c), the primer (§4.3), and the context-update stream (§3.2). A new §2.3-style section or a companion contract doc is warranted.
2. **The Wingman Architecture Plan's IPC command map** gains a canvas command family (engine ops + user ops), and the event taxonomy (R17) gains canvas events (`CanvasAnnotated`, `ProposalAdjudicated`, …) — additive, no existing event changes.
3. **The DSL plan** gains a sibling spec: `canvasOps@1` (the orchestrator tool schemas), versioned and published alongside RSP under MIT. Fleet-facing RSP is untouched — the fleet still never sees a canvas.
4. **`decision.record`** needs the cohort/logical-ordering data shape the C-report already flagged (no `cohortId`, no dependency field today); canvas placement makes that gap blocking rather than cosmetic.
5. **Architecture Contracts** gain §2.5-style text for `WorkspaceContext` (multi-repo composition, §4.2) and the primer's provenance requirements.
6. **The M0 cut** is unchanged in substance but should *name* the canvas objects so the near-term list in §5.3 lands as a re-description of work already scheduled, not new scope. The one genuinely new M0-adjacent item is the in-process canvas MCP server.
7. **UI doctrine** gains one sentence: L3 annotations are glass (chrome, agent's hand, visually distinct); L1/L2 remain what they are. No new hue — annotations use the existing glass identity, not a third colour.
