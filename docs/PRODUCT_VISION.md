# Rennet product vision

Rennet is a local-first Electron **review harness**: it points the coding harnesses already installed on a developer's machine at a change so the developer can read, understand, and deliberately publish the result. The human remains responsible for every outcome.

## Prototype alignment

`prototypes/moodboard/` is the approved product target, not decorative inspiration. The screen theses below govern implementation:

| Prototype screen | Doctrine area it governs | Thesis carried forward |
|---|---|---|
| [`home.html`](../prototypes/moodboard/home.html) | Entry and freshness | Author-first work leads; incoming PRs are a second entry. Project-context freshness is visible beside the work it informs. |
| [`review.html`](../prototypes/moodboard/review.html) | Immutable review and freshness | A new draft patchset preserves exact-current analysis, visibly marks affected work, and regenerates only invalid or potentially invalid work after an explicit request. |
| [`decisions.html`](../prototypes/moodboard/decisions.html) | Decisions and human judgment | Show a deliberately bounded-at-a-glance set of human calls with reconstructed why and in-place evidence; harness disagreement opens an adjacent thread. The product limits attention, not the underlying decision set. |
| [`publish.html`](../prototypes/moodboard/publish.html) | Publication gate | Publication is always an explicit preview: author-side review produces PR copy without pushing; reviewer-side review previews the exact GitHub mutation before the human submits it. Paper is what leaves the machine. |
| [`chat.html`](../prototypes/moodboard/chat.html) | Anchored conversation | Diff chat is ambient, anchored marginalia: a harness-aware conversation layer and disagreement verdict beside the code, never a detached chat product. |
| [`mobile.html`](../prototypes/moodboard/mobile.html) | Companion scope | On a phone, preserve the feed, the cards, and the preparation verb; remove multi-column desktop structure. The private backlight carries connection state. |

**No UI-touching issue closes without a side-by-side comparison against the matching prototype screen in prototypes/moodboard/.**

## What Rennet is—and is not

- **Local-first:** no Rennet backend and no telemetry. Selected harnesses/providers may receive explicitly assembled code and context; every run must disclose that egress and retain an inspectable manifest. Do not say that nothing ever leaves the machine.
- **Human-gated:** no auto-approve, auto-comment, source push, or external publication. The user must take a distinct, explicit action for anything another person can see.
- **Zero-config by default:** detect installed harnesses and repositories before asking for configuration. Never read a credential.
- **One engine, two sources:** v1 covers the developer's working-tree change and someone else's GitHub PR. Both become the same kind of immutable review.
- **One action model, two destinations:** a disposition is an `approve`, `request-change`, `comment`, or `question`; on another person's PR it becomes a batched review, and on the author's branch it becomes a handoff bundle for a coding harness.

Positioning: *You stopped writing the code. You still have to answer for it.* The first user is the agentic engineer who must honestly understand changes produced by coding agents.

## The product thesis

Rennet makes a large diff digestible through **roll-up + zoom + angles**:

1. **Aggressive roll-up is the default.** Group related work into logical cohorts; grouping is opinionated and hard-baked, not a per-project preference.
2. **Approve at any granularity.** A user can act on a roll-up, cohort, group, partial, or item. Decisions are never hidden or truncated; collapse and expansion manage attention without discarding information.
3. **Zoom is continuous.** Narrative, grouped summary, and raw diff are one altitude ladder. The raw diff is always one action away.
4. **The machine removes ceremony, not judgment.** Rennet can group, narrate, validate, and refine; it cannot spend the user's judgment for them.

Order is a comprehension tool: a deterministic dependency DAG supplies the floor, then an agent produces a high-level-to-bottom-up reading order. Danger, blast radius, and salience never order the review; blast radius is an overlay.

## Six angles, five canvases, one overlay

| Angle | Purpose |
|---|---|
| **Spec** | What the change was supposed to do, from committed requirements, PR/ticket context, or explicitly marked reconstruction. |
| **Sequence** | A comprehensible reading order through the change. |
| **Decisions** | Calls only the human can make, with a reconstructed, labelled why. |
| **Claims and evidence** | Requirement/claim/test mapping, including the unclaimed bucket. |
| **Blast radius** | Explainable risk paint: contracts, deletions, fan-in, irreversibility, and safety-net weakening. |
| **Noise** | The totality floor: mechanically classified or narrated residue that did not belong elsewhere. |

An **angle** is an analysis lens. A **canvas** is that angle's stateful per-review surface. Spec, sequence, decisions, claims, and noise are canvases; blast radius paints the other canvases and does not become a competing list. Subtraction is a finding family, not an angle.

## Review lifecycle

1. Capture an immutable patchset from the working tree or a pinned PR head.
2. Make the deterministic floor and generation process legible—never replace it with an empty spinner.
3. Read through the angles; the hunk under the cursor is the fixed point when the angle changes.
4. Dispose at the appropriate granularity. Read state is action-defined, never inferred from scrolling or dwell time.
5. Each disposition is immediately staged into the editable **collation draft canvas**. Raw wording may be refined through an anchored private thread; the user adjudicates the refined result.
6. Sign the draft into the opaque paper preview. On another person's PR it previews one batched review; on the author's branch it previews PR copy or a coding-harness handoff. Publish is all-or-nothing per signing act in v1.
7. A coding-harness handoff produces a successor patchset; Rennet re-reviews the delta. Exact unchanged material may carry forward; ambiguity fails closed.

## Interaction and intelligence

Canvases have four layers: deterministic substrate (L0), validator-admitted analysis (L1), user-sovereign dispositions (L2), and session-scoped orchestrator annotations (L3). Fleet agents emit structured documents; deterministic code validates and places them; the orchestrator may describe, focus, annotate, propose, and retrieve; only the user may make dispositions.

The orchestrator receives a small, versioned map of the review and retrieves details with `canvasOps@2`; it is deliberately under-informed rather than given a stale bulk dump. `context.ask` provides evidence-cited synthesis behind one tool boundary. The Model Council deterministically assigns model-facing work, permits cross-harness light-tier routing, and enforces the live invocation budget.

## Design and engineering boundaries

- Glass is chrome, code is opaque, paper is what leaves the machine. Backlight blue means private-to-reviewer; amber means blast radius or disagreement. See [DESIGN_DOCTRINE.md](./DESIGN_DOCTRINE.md).
- Reviews, patchsets, artifacts, snapshots, commands, privacy, and publication follow [ARCHITECTURE.md](./ARCHITECTURE.md).
- Binding decisions are condensed in [RULINGS_LEDGER.md](./RULINGS_LEDGER.md); supporting execution detail is in the secondary docs indexed by [README.md](./README.md).

## Source status

This document replaces the narrative portions of the former product vision, the former contracts-and-rulings overview, and the former product/design discovery documents. Historical reasoning remains under [`archive/`](./archive/); it is evidence, not implementation authority.
