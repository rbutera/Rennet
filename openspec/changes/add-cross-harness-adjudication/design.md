# Design: cross-harness adjudication with seeded ground truth

## Context

See proposal.md — Why. The load-bearing existing pieces:

- `packages/core/src/dual-seat.ts` + `dual-finding-review.ts`: two fresh independent seats, honest degradation, one shared `InvocationBudget`.
- `packages/core/src/finding-reconcile.ts`: pure anchor-proximity arithmetic → `FindingAgreement` (`concur` | `disagree`); a solo's absent side is `NO_CONCERN_ANSWER`.
- `packages/core/src/finding-verification.ts`: the pattern to copy — deterministic selection + pure orchestration in core, model turn and file reader injected, per-review cap, asymmetric honest degradation, `guardSeatTurn` on every turn.
- `packages/core/src/model-council.ts`: the `adjudication` catalogue job (heavy, per-call) with table entries under `both` / `claude-only` / `codex-only` — currently consumer-less.
- `packages/adapters/src/harness-tested-range.{ts,json}` + `harness-conformance.real.test.ts` (#344): the committed-artifact-from-real-runs pattern and the `.real` env-gated test pattern.
- Pipeline order in `packages/core/src/pipeline.ts`: generate (dual) → reconcile → verification → cross-checks → canvases.

## Goals / Non-Goals

**Goals:** consume the adjudication seat for contested rows; stamp an additive-optional informational verdict; commit a synthetic corpus, a pure scorer, and a real-run-recorded calibration table; assert fresh-session independence.

**Non-Goals:** N=3 self-consistency (no single-provider divergence source exists — dual review under one provider degrades to a single seat and produces zero contested rows); any gate keyed on the verdict or the table (Rule Zero); changing reconcile arithmetic or the verification pass's semantics; new claim schemas; app-server transport.

## Decisions

### D1 — Adjudication is its own pass after verification, not a re-skin of verification

Verification (reproduce-or-refute) already runs on non-obvious findings, but it is severity-gated (`classifyNonObvious`), knows nothing of the disagreement (its prompt carries one claim, not two labelled answers with polarity), and its `refuted → drop` asymmetry is exactly wrong for a contested row: dropping a disagree row hides the flare the dual machinery exists to surface. So `runFindingAdjudication` is a sibling pass in `packages/core/src/finding-adjudication.ts`:

- Selection is `agreement.kind === "disagree"` — divergence is the trigger, severity is irrelevant (a low-severity solo is still a disagreement worth one cheap look). This is the issue's "self-consistency fires only as a trigger response to observed divergence" cost rule, realised cross-harness.
- Verdict vocabulary is the issue's own: `supported | contradicted | insufficient` (deliberately NOT reusing `FindingVerdict` — reproduced/refuted carries the drop semantic; a distinct type keeps the no-drop rule structural).
- Prompt (new contract in `@rennet/instructions`, alongside `FINDING_VERIFICATION_CONTRACT`): the contested claim with explicit polarity — "<seat A label> flags: <summary> at <anchor>; <seat B label> answers: <answer>" — plus the real file window via the existing `VerificationFileReader` seam (reused as-is; no second reader abstraction).
- Runs after verification: pipeline order generate → reconcile → verify → **adjudicate** → cross-checks. A row verification already refuted is gone before adjudication and spends nothing (the anti-hallucination cull stays upstream); a row verification kept still shows its contested state adjudicated.
- Turn plumbing copies verification exactly: injected `AdjudicationTurn`, `guardSeatTurn`, the shared `InvocationBudget`, `DEFAULT_MAX_ADJUDICATIONS = 4` (contested rows are rare; measured spend, adjustable constant). Cap/budget/failed turns stamp `insufficient` with the reason string — never omit, never drop.

**Alternative considered:** extend `runFindingVerification` with a disagreement mode. Rejected: it would fork the drop semantic on a flag and gate contested rows behind `classifyNonObvious`, both wrong for flares; two small honest passes beat one bimodal one.

### D2 — The verdict lives on the `disagree` variant, additive-optional

`FindingAgreement`'s disagree arm gains `adjudication?: FindingAdjudication` (`{ verdict, evidence, adjudicatedBy }` — `adjudicatedBy` is the resolved seat label, honest provenance like every other seat stamp). Types in `packages/types`, schema additive in `packages/protocol` — an old `finding` doc validates unchanged, an old renderer ignores the field. The Flagged lens (`packages/ui/src/components/flagged.tsx` + `canvas/flagged.ts`) renders it as a chip on the disagree flare ("code supports Claude", "code contradicts this flag", "could not adjudicate: <reason>"). No renderer branch may hide a row on any verdict — asserted by a DOM test.

### D3 — Adjudicator seat comes from the council's `adjudication` job

`resolveDualSeat`'s sibling logic is unnecessary: adjudication is ONE seat per review, resolved through the existing `resolveAssignment("adjudication", ctx)` and executed via the same run-turn plumbing the pipeline's `resolveSeat` uses (harness follows the model — providerHarness — so provenance cannot lie). Under `both`, the table already pairs it against the primary reviewer (fresh session, different model family); under a single provider it resolves to that provider's entry with the honest degraded trace that already exists. First real consumer of the catalogue row; zero new resolution machinery.

### D4 — Corpus items are `OfferedManifest`-shaped synthetic fixtures

`packages/core/src/adjudication-corpus.ts` exports ~10 committed items: `{ id, claimClass, truth: "planted-bug" | "clean", manifest, plantedSummary?, plantedAnchor? }`, with the synthetic diff content inline (the shape `lineage-matcher-fixtures.ts` already uses for committed fixtures). Claim classes: a handful that map to real disagreement kinds (behavioural off-by-one, null/undefined deref, resource leak, mechanical nit, clean control). All authored for this repo, from scratch — the fixed boundary (never client data) is restated in the module docstring and enforced by construction (the diffs are invented code).

The scorer `scoreAdjudicationCalibration(items, perItemOutcomes)` is pure: per item, raw overlap's answer (concur/solo arithmetic — did overlap alone flag the truth?) vs the adjudicated answer, folded to per-class accuracy. Exhaustively unit-tested with synthetic outcomes in the default gate — zero spend, and the scorer's correctness is what the hermetic gate proves.

### D5 — The calibration table is a real-run artifact, `harness-tested-range.json` pattern

`packages/adapters/src/adjudication-calibration.real.test.ts` (env-gated like the other `.real` suites) runs both installed harnesses' finding seats over each corpus item via the live adapters, reconciles, adjudicates contested rows on the resolved seat, scores, and writes `packages/adapters/src/adjudication-calibration.json` (per class: overlap accuracy, adjudication accuracy, item count, binary versions, run date). A loader asserts the committed file parses and originates from the recorder (no hand edit path); nothing consumes it as a gate — it is the committed table #41's acceptance criterion asks for, and a docs page cites it. Until the first real run lands, the artifact is the empty recorded shape (mirroring Codex's absent tested-range seed) — honest absence, not invented numbers.

### D6 — Independence is asserted, not re-architected

Fresh-session independence already holds by construction (each seat's `runTurn` is its own spawn/session; no fork API exists on the path). Add the named assertions: a dual-review test that fails if either seat's prompt contains the other seat's findings, and an adjudication test that the adjudicator's turn is a fresh injected turn, not either seat's `runTurn`. Red-first like everything else.

## Risks / Trade-offs

- [Adjudication spends turns on flaky solo noise] → capped at `DEFAULT_MAX_ADJUDICATIONS`, ordered by severity, on the shared budget; overflow rows surface unadjudicated with the cap named.
- [A ~10-item corpus is too small for statistical claims] → the table reports raw counts per class, no percentages dressed as significance; growing the corpus is a data edit, not a code change.
- [Hermetic gate can't prove adjudication *beats* overlap] → by design: the gate proves the machinery; the committed table from real runs carries the measurement. Same posture as testedRange.
- [Verdict could read as authority over the human] → copy renders it as the third opinion it is ("code supports X"), beside both verbatim answers, never replacing them.

## Migration Plan

Additive-only: old persisted reviews validate and render unchanged (no `adjudication` field). No config, no schema version bump beyond the additive protocol acceptance. Rollback is deleting the pass call; nothing downstream requires the field.

## Open Questions

None that change specs or tasks. (Corpus growth cadence and whether the calibration table later informs seat selection are explicitly future, post-measurement questions.)
