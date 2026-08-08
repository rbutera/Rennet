---
tags: [rennet, design, ux]
categories: [reference]
status: active
created: 2026-08-08
updated: 2026-08-08
related: ["[[Rennet User Journey]]", "[[Rennet Design Doctrine]]", "[[Rennet Contracts and Rulings]]", "[[Rennet Product and Vision]]", "[[Rennet Canvas Paradigm]]"]
source: Rai correction, voice, 2026-08-08 (GitHub issue #99); Accepted 2026-08-08 (Rai blessed)
---

# Rennet Collation Draft Canvas

> **Status: ACTIVE. Accepted 2026-08-08 (Rai blessed** — "Blessed. Proceed as you deem appropriate."**).** This document canonizes the missing middle layer named in issue #99. It refines a frozen ruling (R36 → R40) and reshapes several open issues. The tension with R36 is surfaced explicitly in §4 and resolved by R40 (see [[Rennet Contracts and Rulings]]).

## The skew this corrects (issue #99, verbatim source)

The elegant glass/paper language drifted from what the tool is *for*. As built, the **paper reads as final / set-in-stone**, so the felt model collapsed to two layers:

- lenses / canvases = the draft
- paper = the preview of the output

Rai's correct model has a **missing middle layer**. In his words: *"the canvases are the staging for the real draft; the real draft is where all the stuff is collated together and it's still modifiable, a canvas of its own, and THEN that gets handed off to the paper."*

The current code makes the skew literal (verified 2026-08-08):

- `app.tsx` wires **`DestinationFrame` → `PublishSheet` directly** (`onOpenPublish`). There is no surface between staging and paper.
- `PublishSheet` (the paper, #22) carries an inline **`onWithdraw`** and shows raw bodies — i.e. **the paper is editable**. That is the exact conflation #99 names: the modifiable collation draft has been merged into the final paper.
- `BatchView` (the editable "staged view", #17) already exists and is genuinely modifiable (edit body, edit type, withdraw) — but it lives off to the side in `workspace.tsx`, **not in the destination flow**. The editable surface exists; it is just not where the journey routes, and it is not treated as a canvas.

So the fix is not "build an editor from scratch." It is **promote the editable staged view into a first-class canvas, route the journey through it, and strip editing off the paper.**

## 1. The three-layer spine

```
  ┌─────────────┐    dispose == staged    ┌──────────────────────┐   sign (freeze)   ┌──────────┐
  │  LENSES /   │  ───────────────────▶   │  COLLATION DRAFT      │  ─────────────▶   │  PAPER   │
  │  CANVASES   │                         │  CANVAS               │                   │          │
  │  (STAGING)  │  ◀───────────────────   │  (THE REAL DRAFT)     │  ◀── back ──────  │ (FROZEN) │
  └─────────────┘   click an item →       └──────────────────────┘                   └──────────┘
   dispositions      jump to its anchor      editable · glass · yours                  opaque · signed · leaves
   made at anchors   (fixed-point rule)      collate / reword / reorder /
                                             merge / split / withdraw
```

| Layer | What it is | Material | Editable? | Where it lives |
|---|---|---|---|---|
| **1. Lenses / canvases** | Where individual dispositions are *made*, at their code anchors (six angles, five canvases + blast overlay). Projections over **code**. | Glass chrome around **opaque code** | You dispose here; the code is read-only | `#11` canvas UI (merged) |
| **2. Collation draft canvas** | Where every disposition from every lens *gathers into one coherent, still-modifiable working draft* of the outbound artifact. A projection over the **disposition set** (L2), across all angles. **This is the actual working draft — it is NOT the paper.** | **Glass** (working state, translucent, yours) | **Fully editable** — this is the whole point | **NEW surface** (seed: `#17` staged view) |
| **3. The paper** | The final committed handoff/output — exactly what leaves. Set-in-stone is correct *here*, at the very end. | **Opaque paper** (the one solid object) | **No** — sign or go back | `#22` publish sheet (narrowed) |

The one-line mental model: **you dispose on the lenses; it collates onto the draft, still yours; you sign the draft into the paper, and only then does it leave.**

## 2. What the collation draft canvas *is*, concretely

It is a canvas whose **substrate is the L2 disposition set**, not code. This is the inversion that makes it "a canvas of its own":

- On a **lens canvas** you look at *the code, annotated by your judgment* — dispositions live at their code anchors (Design Doctrine §3.5, "marks live at their anchors").
- On the **collation draft canvas** you look at *your judgment, collated into a draft* — the dispositions are lifted out of the code and arranged as the document-in-formation, because that document is the thing being built. The code becomes reference, reachable by one click back to its anchor (fixed-point rule), rather than the figure.

Same canvas DNA as the lenses ([[Rennet Canvas Paradigm]]: event-sourced, layered, addressable, rebuildable from the event store) — but where a lens is scoped `(reviewId, patchsetId, angle)` over code, the collation canvas is scoped `(reviewId, patchsetId)` over the **whole disposition set across all angles**. It is the one canvas where L2 is the entire figure rather than one layer among four.

### What you can DO on it

Everything the paper must *not* let you do:

- **See everything together** — every disposition from every lens in one place, the first time the whole account is visible as one object.
- **Reword** each disposition's body (raw → your edit), and **watch the refiner** turn raw notes into cleaned, investigated forms in the background (§2.5 loop; you see `raw` and the arriving `refined`).
- **Retype** a disposition (approve / request-change / comment / question).
- **Reorder** them — how they will read in the output (the review's comment order; the handoff bundle's task order).
- **Merge** two dispositions into one (two adjacent comments → one), and **split** one into two.
- **Withdraw** (unstage, R37) — remove with zero residue.
- **Ask the orchestrator** questions about the forming draft (it may *propose* edits on L3, which you accept into L2 — it never writes the draft itself; the safety line holds, [[Rennet Canvas Paradigm]] §L2).
- **Read the totality/residue guarantee** — what have I not looked at — because done/sign still blocks on incomplete ingestion (Design Doctrine §3.2).

Nothing here has left the machine. It is all working state, all reversible, all yours.

### Why glass, not paper, not backlight

The materiality resolves cleanly and *strengthens* the doctrine rather than bending it:

- The collation draft is **working state you are still forming → glass** (translucent, mutable, yours). It is not code, so "glass is chrome never code" is respected — this is chrome, the account you are composing.
- **Signing is a phase transition: glass crystallises into paper.** The draft is translucent working glass; the sign act freezes it into the one opaque solid object. The materiality inversion (Design Doctrine §1.2: "the thing you sign is the only solid object") is *preserved and sharpened* — the draft is deliberately not-yet-solid, and solidity is what signing confers.
- It is **not backlight**. Backlight is reserved for the set that *never* publishes (coverage, pace, chat, dismissals, the stays-panel). The collation draft is precisely the set that *will* publish once signed. "Ink is what travels; blue is what stays" — the collation draft is **ink-in-formation**. It stays glass only until you sign.

## 3. The two modes

Both modes flow **lenses → collation draft → paper**. The collation-draft *machinery* is identical across modes (it is the disposition set, collated + editable — exactly the existing mode-agnostic `stagedItems` / `stagedPayload` data). Only the *framing* and the *shape of the paper* differ, precisely mirroring the existing `DestinationVariant`:

| | **own-branch (handoff)** | **other-PR (publish)** |
|---|---|---|
| The collation draft collates dispositions into… | one coherent **task narrative** for a coding harness | one coherent **review to post** |
| What editing earns its place | **compose N dispositions into ONE instruction bundle** — reorder / merge / reword into a coherent set of asks (this is where `#72` handoff-bundle composition lives) | **per-item refinement** — refine comment wording, group related comments, drop the ones you've decided against (this is where `#19` comment refinement lives) |
| The paper (frozen) | the **handoff bundle** / PR-submission preview (title/body/draft, zero Git mutation, R33) | the **GitHub review** preview: line items in refined form, the degradation ledger, the travels-vs-stays split, ONE batched review event (R33) |
| Sign = | hand off to the harness (or draft the PR) | post one batched review (R33) |

The collation canvas is therefore the natural, single **home for both `#72` and `#19`** — they are the same surface doing mode-specific work, not two separate features. The own-branch mode leans composition-heavy (merge/reorder into a coherent bundle); the other-PR mode leans per-item-refinement-heavy. Same canvas, same machinery, mode-framed labels — the minimal-churn path the existing `DestinationVariant` already anticipates.

## 4. Reconciling ruling R36 (the tension, surfaced)

**R36 as ratified** (2026-08-07): *"Dispose == staged. A disposition IS staged the moment it is made — it lands, visibly, in the forming destination (**the paper**, User Journey stage 5–6). There is no separate `git add`-style staging act…"*

**The tension.** R36 identifies "the forming destination" with **the paper**. Issue #99 says the forming destination is the **editable collation canvas**, and the paper is downstream of it (a later, deliberate sign). These conflict on one clause: *what the forming destination IS.*

**Recommendation — REFINE R36, do not overturn it.** R36's substance is untouched: there is still no separate staging act; disposing *is* staging. What drifted is the parenthetical identification of the forming destination with the paper. The precise refinement introduces a **three-state model** where R36 implicitly had two:

> **unstaged** → (dispose) → **staged-in-draft** (in the collation draft canvas; editable, still yours) → (sign, R38 all-or-nothing) → **signed-on-paper** (frozen, leaves the machine).

**Refined R36 wording, now ratified as R40** (2026-08-08, Rai blessed — see [[Rennet Contracts and Rulings]]):

> *Dispose == staged. A disposition IS staged the moment it is made — it lands, visibly, in the **collation draft canvas** (the forming destination, editable). There is no separate staging act. **Signing** is a distinct, later, deliberate act that freezes the collation draft into the paper (R38, all-or-nothing) — that is the one solid object, and it is what leaves.*

- **R37 (withdraw == unstage)** survives unchanged in substance; it now clearly operates *on the collation draft canvas*. The `#17` "staged view" IS the seed of the collation canvas.
- **R38 (all-or-nothing per signing act)** survives unchanged; it is now clearly the **glass→paper freeze**: the paper is the frozen crystallisation of the *whole* collation draft. "What you see is what leaves" (`resolveSign`) is preserved — it just previews the collated/refined draft's bytes, not the raw staged list.
- **The one behavioural change:** editing (reword, retype, reorder, merge, split, withdraw) moves *off the paper* and *onto the collation draft*. In code, `PublishSheet`'s `onWithdraw` is removed (or becomes "← back to the draft"); the paper's only actions are **sign** and **back**.

**Filed as R40** (a new ruling refining R36/R37/R38 — "the collation draft canvas is the forming destination; the paper is the frozen sign"), rather than editing R36 in place — R36 stays as the historical record of the 2026-08-07 ratification, and R40 records Rai's 2026-08-08 sharpening of his own model. That keeps the rulings ledger honest about the sequence.

## 5. Dark paper (the token work)

**The bug, verified in `packages/ui/src/tokens.css`:** the `--sheet-*` paper tokens (`--sheet-bg: #f7f5ef` warm cream, `--sheet-text: #23211c`, …) are defined **once** in `.canvas-app` (the dark default scheme) and are **not** re-themed in `.canvas-app[data-scheme="light"]` (only `--sheet-glow` is overridden there). So the paper is warm cream in **both** schemes. In the dark default (bioluminescent twilight), that is a light cream sheet on a near-black app — exactly the "light paper in dark mode" #99 names.

**The fix — paper materiality must theme, baked into the tokens (not a light sheet on a dark app):**

The principle: **paper is the one OPAQUE SOLID object in *both* schemes.** What makes it read as *paper* is **warmth** (a material tone, against the cool teal/blue glass); what makes it belong in dark mode is **darkness**; what makes it solid is **opacity**. So dark paper = a **warm-dark material** (deep umber / espresso), not a "dark panel" and not an inverted cream.

Concrete token restructuring (indicative values — tune against `prototypes/moodboard/`):

- **`.canvas-app` (dark default) → dark paper:** `--sheet-bg: #1c1712` (warm espresso, opaque), `--sheet-text: #efe7db` (warm off-white ink), `--sheet-soft: #b6ab99`, `--sheet-hairline: #322a20`, and a warm `--sheet-glow` (keep the depth shadow; warm the inner tint). Warm, dark, opaque, solid.
- **`.canvas-app[data-scheme="light"]` (bright room) → cream paper:** move the *current* cream values (`#f7f5ef`, `#23211c`, …) *here*, where they belong. Bright room keeps warm cream.
- The **collation draft is glass**, so it themes for free with the existing two schemes and needs no new material tokens. Only the **paper** needs the dark variant.
- The serif document voice, hold-to-sign, and the sheet-glow all stay; only the base material colours theme. Add a line to **Design Doctrine §1.2**: *"Paper is the one opaque solid object in every scheme — warm-dark in dark, cream in bright; it is materiality (warmth + opacity), never a fixed light colour."*

## 6. What this reshapes

| Artifact | Reshape |
|---|---|
| **`#22` publish sheet** | **Narrows** to the frozen paper + sign only. Editing (`onWithdraw`, edit body/type) moves off it. The paper's actions become **sign** and **back-to-draft**. Dark-paper theming lands here. |
| **`#64` / `#76` destination frame** | The frame stops *being* the paper. It becomes the persistent progress indicator that opens the **collation draft canvas** (not the sheet). "STAGING TOWARD" copy stays; the empty-state copy "The paper is blank" is wrong and changes to "The draft is empty." Flow becomes frame → draft → paper (two surfaces), not frame → paper. |
| **`#17` staged view** | **Promoted** into the collation draft canvas (its editable list is the seed). Renamed conceptually from "staged view" (a panel) to the collation draft (a canvas). |
| **`#19` comment refinement · `#72` handoff composition** | Re-homed: both live *on* the collation draft canvas (other-PR refinement / own-branch composition). Not separate surfaces. |
| **User Journey stages 6–7** | Stage 6 ("The destination: the paper") **splits**: new **Stage 6 = the collation draft canvas** (collate, edit, refine — editable), **Stage 7 = the paper** (sign, frozen), old Stage 7 (delta re-review) becomes **Stage 8**. The one-line summary gains a beat: *"…dispose (= stage into the draft) → collate & refine the draft → sign the paper → [delta loop]."* |
| **Contracts R36 / R37 / R38** | Refined per §4: file **R40** naming the collation draft canvas as the forming destination and the paper as the frozen sign; R36's "the paper" parenthetical superseded. |
| **Design Doctrine §1.2** | Add the **glass→paper phase-transition** framing and the **dark-paper theming** rule (§5). |
| **[[Rennet Canvas Paradigm]]** | Add a note: the collation draft canvas is a new canvas type whose substrate is the L2 disposition set (not code+angle) — the one canvas where L2 is the whole figure. (Doc addition, non-blocking.) |
| **NEW owner issue** | **Yes** — file *"The collation draft canvas"* as its own owner issue, between `#17` (seed) and `#22` (paper). Scope: promote the editable staged view into a first-class canvas; add reorder / merge / split / reword; mode-frame it (handoff composition vs review refinement); route the destination frame through it; strip editing off the paper. It absorbs the composition/refinement homes for `#72`/`#19`. |

---

*Proposal written 2026-08-08 from issue #99 (Rai, voice) over the ratified [[Rennet User Journey]], [[Rennet Design Doctrine]], [[Rennet Contracts and Rulings]] (R33/R36/R37/R38), [[Rennet Canvas Paradigm]] (the L0–L3 layer model), and the current `packages/ui/src` destination code (`canvas/destination.ts`, `components/destination-frame.tsx`, `components/publish-sheet.tsx`, `components/batch-view.tsx`, `app.tsx`, `tokens.css`). Nothing built; the contribution is the missing middle layer and the R36 reconciliation. Accepted 2026-08-08 (Rai blessed); the reconciliation is ratified as R40.*
