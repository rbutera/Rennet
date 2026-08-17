# Design — design-usability-pass (#85)

## 1. The ramp decision

### The finding, honestly stated

The impeccable design-lint reports every `font-size`/`border-radius` px literal in
`packages/ui/src` that is off the DESIGN.md ramp. But the DESIGN.md ramp is the
**marketing** scale (body 16px, label 13px, control radius 10px, surface 12px) —
DESIGN.md itself says "the desktop keeps a smaller, more spatially stable scale" and
never enumerates it. The canonical wireframes (`wireframes/src/kit.mjs`, the declared
design source of truth) use a dense desktop scale (11/11.5/12/12.5/13.5/14/15px type;
6/7/8/9/11/12/14px radii), and the live app converged on the same neighbourhood. So the
lint findings decompose into two honestly different classes:

1. **Load-bearing values the ramp never documented** — the dense scale itself.
2. **Drift around those values** — fractional half-steps and ±1px strays produced by
   many agents nudging between undocumented steps.

**Decision: both directions, split per value class.** DESIGN.md gains an explicit
desktop scale (the lint learns it via the regenerated `.impeccable/design.json`), and
every literal that is genuine drift migrates onto its ramp neighbour. No blanket
suppression, and no pretending 12.5px was ever a decision.

### The desktop type ramp

`10 / 11 / 12 / 13 / 14 / 16 / 19 / 22` px, plus the front-door display clamp
(`clamp(34px, 5vw, 56px)`), documented as the display role's desktop expression.
Fractional px sizes are banned outright: every one in the codebase exists as a
split-the-difference nudge between two undocumented steps.

Audit (styles.css + canvas.css combined, 277 font-size literals):

| Value | Count | Verdict | Migration |
|---|---|---|---|
| 12px | 84 | **ramp** — chrome standard | — |
| 13px | 64 | **ramp** — reading size | — |
| 11px | 58 | **ramp** — dense meta | — |
| 10px | 17 | **ramp** — micro caps floor | — |
| 14px | 15 | **ramp** — emphasis | — |
| 12.5px | 10 | drift | → 12 or 13, judged per use |
| 11.5px | 5 | drift | → 11 or 12, judged per use |
| 15px | 5 | drift | → 14 or 16, judged per use |
| 18px | 4 | drift | → 19 |
| 19px | 4 | **ramp** — section heading | — |
| 9px | 3 | drift (below the legibility floor) | → 10 |
| 16px | 3 | **ramp** — body (shared with marketing) | — |
| 20px | 2 | drift | → 19 or 22, judged per use |
| 22px | 1 | **ramp** — screen title | — |
| 13.5px | 1 | drift | → 13 |
| 10.5px | 1 | drift | → 10 |
| clamp(34px…) | 1 | display clamp, documented | — |

246 of 277 literals (≈89%) already sit on the ramp — the app was converging on it; the
pass documents the destination and collapses the 31 strays. "Judged per use" means the
implementer picks the neighbour that matches the wireframe frame for that surface, not
a mechanical round.

### The desktop radius scale

`4 / 6 / 8 / 12 / 16` px, plus two geometry exemptions that are shape rather than
scale: `999px` (the pill — chips and counts only; doctrine already forbids pill
*containers*) and `50%` (circles).

Audit (73 border-radius literals):

| Value | Count | Verdict | Migration |
|---|---|---|---|
| 8px | 19 | **ramp** — control | — |
| 999px | 11 | geometry — pill chips | — |
| 9px | 11 | drift | → 8 (includes the `--chip-radius` token, one edit) |
| 6px | 8 | **ramp** — small control / chip | — |
| 5px | 7 | drift | → 4 or 6, judged per use |
| 7px | 7 | drift | → 6 or 8, judged per use |
| 4px | 3 | **ramp** — micro | — |
| 14px | 2 | drift | → 12 or 16, judged per use |
| 10px | 1 | drift | → 8 or 12 |
| 11px | 1 | drift | → 12 |
| 15px | 1 | drift | → 16 |
| 2px | 1 | drift | → 4 |
| 3px | 1 | drift | → 4 |

The existing tokens already sit on the scale (`--radius: 12px`, `--win-radius: 16px`);
`--chip-radius` moves 9→8 (visually imperceptible at chip size). No new token layer for
sizes: the lint enforces on-ramp literals, on-ramp literals stay greppable, and a
`--fs-12` indirection would add a layer with no check behind it. (ponytail: the lint is
the enforcement; variables would be ceremony.)

### DESIGN.md and the lint

DESIGN.md gains a "Desktop scale" subsection under Typography and Shapes enumerating
both ramps and the two geometry exemptions, with one sentence each on when a step is
used. `.impeccable/design.json` (schemaVersion 2, generated from DESIGN.md) is
regenerated so the design-lint's ramp is the documented one. Acceptance is measurable
and gate-free: **the design-lint reports zero design-system-radius and
design-system-font-size findings over `packages/ui/src`**, and a grep for fractional px
font sizes returns nothing.

## 2. Per-surface intent

**Verify-ui strip (#352, `.ui-verification*` — currently zero CSS).** Joins the
chrome-verdict chip language already established by `.flag-verification` and
`.flag-adjudication` in canvas.css: a terse bordered strip on the flagged surface,
label + reason in `--text-soft`, `ran` state carrying the count and a horizontal
screenshot row (`.ui-verification-shots`, thumbnails on the opaque code surface),
`pending` quiet, `unavailable` honest and unpanicked (no amber — unavailability is not
disagreement). Chrome copy stays ≤4 words (R41); the strip's existing DOM statuses
(`data-status`) are the styling hooks, so no behavior change.

**Handoff paper (#72, `.handoff-paper*` — currently zero CSS).** The paper material,
R40: warm opaque sheet (`--sheet-bg`/`--sheet-text`/`--sheet-soft`/`--sheet-hairline`,
`--sheet-glow`), one deeper corner (16px, on-ramp), the composed work order reading as
a document. The un-composed mechanical-floor state stays visibly a list, never dressed
as authored prose (the component already renders it distinctly; the styling must keep
that distinction legible, e.g. plain rules vs. the authored heading). Run outcome
states style honestly: refusal/failure in plain words on the sheet, never disguised;
the Run action is one button, no ceremony.

**In-rail conversation alignment (#36 deferred → spec delta).** The rail keeps its
sibling-column structure (the no-reflow guarantee is structural and stays). Panels
already carry `data-anchor-key`; the positioning pass reads the rendered anchor row's
offset from the windowed CodeView and applies a transform/offset to the panel when the
row is rendered, falling back to stacked order when it is not. Scroll/virtualization
churn is absorbed by only ever *offsetting within the rail*, never repositioning the
rail or the diff. DOM-testable: aligned panel carries a data attribute / style offset
derived from the row; off-screen anchor yields the stacked default.

**Wordmark (#43 deferred).** `RennetMark` in `icons.tsx` swaps the placeholder mono
"R" for the split-disc glyph paths from `site/brand/rennet-glyph.svg`, rendered
`fill="var(--mark-ink)"` / `stroke="var(--private)"` exactly as the site masthead
already does. Token-driven, so legend coverage holds genuinely rather than
incidentally.

**Partially-styled surfaces.** The delta re-review panel (`.delta-account*`, 25 rules)
and settings Keyboard section (`.settings-key*`) get spacing/typography aligned to the
ramp and the frames (15-settings, 06a-delta-rereview); the adjudication chip
(`.flag-adjudication*`) and title-bar context (`.navigation-mode-pill`,
`.navigation-patchset-chip`) get the same treatment against frames 09 and 18. This is
alignment, not redesign: existing DOM contracts and tests stay green.

**Doctrine sweep (deletion-first).** R41: audit chrome strings, cut to four words or
fewer (LLM canvas content exempt). R42: every glyph rendered in chrome has a legend
entry (the icons.tsx registry is the enforcement point; the existing legend-coverage
test is the check). No-mono-chrome: `--code` usage audited to genuine code/technical
values only (`--mono` already aliases `--sans`; the patchset chip's `<code>` shows an
exact technical value and stays). R44: no viewport cramming — screens scroll; remove
any `overflow: hidden` that truncates a stage. Narrow widths: the app stays readable
and vertically scrollable at narrow window widths; no horizontal scroll of the shell.

**canvas.css specificity.** A real bug, fixed: the base `.conversation-host` block
(line ~2744) is declared after its own `.review-heart-split > .conversation-host`
override (~2433). Reorder so the base precedes the override; biome's
`noDescendingSpecificity` over canvas.css goes to zero warnings. Recorded here because
it was explicitly parked for this pass.

## 3. Wireframe (v4.0) deltas — adopted vs rejected

**Adopted:**
- The dense desktop scale (this is what the ramp decision ratifies).
- The chrome-verdict chip language for verification/adjudication strips (frames 09/10).
- The paper material for the handoff/collation surfaces (frames 12/13).
- In-rail thread alignment against the line (frame 06), with the honest off-screen
  fallback.
- The real wordmark in chrome (frame 00's brand row).
- Terse chrome, legend-covered icons, vertical scroll (R41/R42/R44 — already ratified
  doctrine; the pass is the conformance sweep).

**Rejected for this pass, with reasons:**
- **Frame 18's navigation model as a restructure.** The spine is already live
  (breadcrumb + NavRail + command palette + patchset chip in `app.tsx`); this pass
  aligns presentation only. Any structural nav change is its own future change.
- **An execution-mode glyph backed by a new mode capability.** The resteer's
  title-bar mode glyph presumes an execution-mode state the product does not have.
  The existing pill shows the real mode axis (Quick/Dual review) honestly. Building an
  execution-mode system is a feature decision, out of scope for a design pass.
- **Pixel-perfect alignment for off-screen anchors.** The diff is windowed; an
  off-screen row has no rendered position. Faking one would be a lie in the UI; the
  fallback is stacked order, disclosed in the spec delta.
- **Monospace texture anywhere in chrome** (the wireframe kit itself uses `--mono`
  pills as texture; the resteer overrides the kit here — kit frames predate fresh
  update 2).
