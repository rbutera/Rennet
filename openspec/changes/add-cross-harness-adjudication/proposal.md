# Cross-harness adjudication with seeded ground truth

Closes the live remainder of [#41](https://github.com/rbutera/rennet/issues/41).

## Why

Dual-harness review already runs (post #344 both seats are real): `resolveDualSeat` + `runDualFindingReview` generate findings independently on Claude and Codex in fresh sessions, and `reconcileFindings` folds them into concur/disagree rows by pure anchor-and-severity arithmetic — raw overlap. But when the seats *disagree*, Rennet today only shows the two verbatim answers side by side. Nobody ever asks the code who is right. The Model Council has carried an `adjudication` job (heavy tier, table entries under all three availability scenarios) since #89 with **zero consumers** — the seat exists, the turn never runs. And #41's acceptance criterion — on a seeded ground-truth corpus, explicit adjudication measurably beats raw overlap, table committed — has no corpus, no measurement, and no table.

The Rule Zero amendment on #41 (2026-08-11) struck the ship gate: calibration is *measured*, it never blocks a flare from rendering. The 2026-08-16 audit comment marked the issue blocked on #25; #25 delivered (PR #344, merge `37257f9`), so this is now buildable.

Already delivered by prior changes and **not rebuilt here** (order-of-evidence: live code):

- Independent fresh-session dual generation, graceful single-seat degradation, honest `DualReviewNote` — `packages/core/src/dual-seat.ts`, `dual-finding-review.ts`.
- Claim identity via anchor-proximity canonicalisation; silence surfaced as "no concern raised here" (a solo is a *disagreement*, never a rejection — the issue's `notEmittedBy` semantic) — `finding-reconcile.ts`.
- The structural evidence rule: `admitFindings` culls any finding whose anchor does not resolve to an offered hunk, so **no flare row exists without code evidence on at least one side** — `finding-generation.ts`.
- Reproduce-or-refute verification with a real shell — `finding-verification.ts`.

## What Changes

- **The adjudication turn finally runs.** A new pure-core pass (`finding-adjudication.ts`, model I/O injected, mirroring `finding-verification.ts`) takes every reconciled `disagree` row — divergence is the trigger, exactly the issue's "fires only as a trigger response to observed divergence" cost rule — and runs one turn on the council's `adjudication` seat per contested claim. The prompt states the claim with explicit polarity (seat A flags X at this anchor; seat B says "no concern" / says Y), the real code window around the anchor, and asks for `supported | contradicted | insufficient` plus one line of evidence.
- **The verdict informs, never gates (Rule Zero).** The verdict rides an additive-optional `adjudication` field on the disagree row. Verified rows cross the command boundary and render immediately; adjudication runs as concurrent post-hoc enrichment and reaches the renderer through a patchset-and-mode-keyed follow-up read. A failed, capped, or budget-exhausted turn is honest `insufficient` with its reason — never a drop, never a fabricated verdict. A slow or hung turn never delays the initial rows.
- **Seeded ground-truth corpus, synthetic only.** A small committed corpus of Rennet-authored synthetic diffs (planted bugs and clean-control items, each with a known per-claim verdict and a claim class). Never client repositories, code, or data (fixed boundary). A pure scorer compares raw overlap's answer vs explicit adjudication's answer against known truth, per class.
- **Calibration measured by real runs, committed as a table.** Default gate stays hermetic (the scorer and pass proven against fake seats; zero spend). A gated `.real` run — the #344 pattern — drives both installed harnesses' finding seats over the corpus, adjudicates the disagreements, and writes the committed per-class calibration table (`adjudication-calibration.json`, recorded from real runs, never hand-edited, mirroring `harness-tested-range.json`). The table is an informational quality signal.
- **Fresh-session independence asserted** as a named test invariant (no forked-session generation path), extending the existing dual-review tests.
- Flagged lens: the disagree flare gains the adjudication chip when the verdict is present.

Deliberately cut (Rule Zero / no live path):

- **N=3 same-model self-consistency.** Divergence only exists when two seats run; under one installed provider dual review degrades to a single seat and no contested rows exist, so the trigger structurally never fires. Add when a single-provider divergence source ships.
- **The struck ship gate.** No "adjudication must beat overlap before a flare renders". Measured, committed, disclosed — never blocking.
- New claim schemas beyond the shipped anchor canonicalisation.

## Capabilities

### New Capabilities

- `cross-harness-adjudication`: explicit per-claim adjudication of contested dual-review rows on the council's adjudication seat; the seeded synthetic ground-truth corpus; the real-run-recorded calibration table.

### Modified Capabilities

None. The `model-council` promoted spec already names `adjudication` as a heavy-tier catalogue job with table entries; this change consumes that seat without changing its requirements. The Flagged-lens flare rendering has no promoted spec.

## Impact

- `packages/types`: additive-optional `FindingAdjudication` on the `disagree` agreement variant.
- `packages/protocol`: the `finding` doc schema accepts the additive field.
- `packages/core`: new `finding-adjudication.ts` (pure pass + prompt assembly via `@rennet/instructions`), new `adjudication-corpus.ts` (synthetic fixtures) and pure scorer; the desktop live flagged flow wires the pass after verification as late enrichment, budget-shared and capped.
- `packages/adapters`: gated `adjudication-calibration.real.test.ts`; committed `adjudication-calibration.json`.
- `packages/ui`: disagree flare shows the adjudication chip.
- Docs: delivery-order wave entry, dual-review/flagged concept pages — same change.
- No new dependencies. No model spend in the default gate.
