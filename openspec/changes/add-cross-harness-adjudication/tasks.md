# Tasks: cross-harness adjudication with seeded ground truth

Red-first throughout: each numbered group starts with the failing test that proves the behavior, then the code that turns it green. Wrap `git`/`gh`/`pnpm` in `sh -c '...'`; the default gate must stay at zero model spend.

## 1. Types and protocol (additive verdict)

- [x] 1.1 RED: protocol test — a `finding` doc whose disagree agreement carries `adjudication: { verdict: "contradicted", evidence, adjudicatedBy }` validates; an old doc without the field still validates; a bad verdict string is rejected.
- [x] 1.2 Add `FindingAdjudication` (`verdict: "supported" | "contradicted" | "insufficient"`, `evidence`, `adjudicatedBy`) to `packages/types` and the optional `adjudication` field on the `disagree` arm of `FindingAgreement`; accept it additively in the `packages/protocol` finding schema. Green.

## 2. The adjudication pass (core, pure, injected I/O)

- [x] 2.1 RED: `finding-adjudication.test.ts` — selection: only `disagree` rows are eligible; all-`concur` input runs zero turns; rows are taken in severity order up to `DEFAULT_MAX_ADJUDICATIONS`.
- [x] 2.2 RED: prompt content — the assembled adjudication prompt carries both labelled answers with explicit polarity (flagging seat's summary at its anchor; other seat's answer, including `NO_CONCERN_ANSWER` for a solo) and the real file window from the injected reader, not only the hunk.
- [x] 2.3 RED: honesty asymmetry — a thrown/guarded turn, the per-review cap, and an exhausted budget each stamp `insufficient` with the honest reason; no code path drops or omits a contested row; a `contradicted` verdict leaves the row present with both verbatim answers intact.
- [x] 2.4 Add the adjudication prompt contract to `@rennet/instructions` (sibling of `FINDING_VERIFICATION_CONTRACT`) and implement `runFindingAdjudication` in `packages/core/src/finding-adjudication.ts` (injected `AdjudicationTurn` + `VerificationFileReader`, `guardSeatTurn`, shared `InvocationBudget`, `DEFAULT_MAX_ADJUDICATIONS = 4`). Green on 2.1–2.3.

## 3. Pipeline and seat wiring

- [x] 3.1 RED: pipeline test — with two fake seats disagreeing, the flagged result's disagree rows carry adjudication verdicts produced on the seat resolved for the council `adjudication` job (provenance label matches the resolved model's harness); with the adjudication seat unavailable, rows surface unadjudicated and the review still completes.
- [x] 3.2 RED: ordering — a row refuted (dropped) by verification is never adjudicated; adjudication runs after verification on the surviving set.
- [x] 3.3 Wire the pass into `packages/core/src/pipeline.ts` after verification, resolving the turn via `resolveAssignment("adjudication", ...)` through the existing seat-execution plumbing. Green on 3.1–3.2.
- [x] 3.4 RED then green: fresh-session independence asserted — dual-review test fails if either seat's prompt contains the other seat's findings; adjudication test asserts the adjudicator turn is a fresh injected turn, not either generating seat's `runTurn`.

## 4. Seeded corpus and pure scorer

- [x] 4.1 RED: corpus shape test — every item names `claimClass`, `truth`, and an offered-manifest-shaped synthetic diff; planted items carry the planted anchor/summary; at least one clean control exists per released class set.
- [x] 4.2 Author `packages/core/src/adjudication-corpus.ts`: ~10 Rennet-authored synthetic items across the classes in design D4. Module docstring restates the fixed boundary: synthetic only, never client data. Green.
- [x] 4.3 RED: scorer tests — `scoreAdjudicationCalibration` is pure; per-class accuracy for raw overlap vs adjudication against known truth on synthetic outcomes, including the case where adjudication corrects a wrong solo (beats overlap) and the case where it doesn't.
- [x] 4.4 Implement the scorer in core. Green. Confirm the whole of groups 2–4 spawns no process and spends no token in the default gate (positive control: the `.real` env flag off).

## 5. Gated real calibration run and the committed table

- [ ] 5.1 Add `packages/adapters/src/adjudication-calibration.real.test.ts` (env-gated like `harness-conformance.real.test.ts`): drive both installed adapters' finding seats over the corpus, reconcile, adjudicate contested rows on the resolved seat, score, and record `packages/adapters/src/adjudication-calibration.json` (per class: overlap accuracy, adjudication accuracy, counts, binary versions, date).
- [ ] 5.2 RED then green: loader/recorder test — the committed artifact parses, only the recorder writes it, and nothing consumes it as a gate; until a real run lands it holds the honest empty recorded shape (no invented numbers).
- [ ] 5.3 Run the real calibration once locally (both harnesses installed) and commit the recorded table. If a harness is unavailable at implementation time, commit the empty shape and say so in the PR — the table lands from the first genuine run, never by hand.

## 6. Flagged lens chip

- [ ] 6.1 RED: DOM tests — a disagree flare with a verdict shows the adjudication chip ("code supports <seat>" / "code contradicts this flag" / honest could-not-adjudicate reason) beside both verbatim answers; a row with no verdict renders exactly as today; NO verdict value hides or drops a row (structural no-gate assertion).
- [ ] 6.2 Render the chip in `packages/ui` (`canvas/flagged.ts` + `components/flagged.tsx`). Green.

## 7. Docs and delivery (same change — definition of done)

- [ ] 7.1 Update the dual-review/flagged docs pages (Using: what the adjudication chip means, the third-opinion framing; Developing: the pass, the corpus, the calibration artifact and its real-run-only provenance).
- [ ] 7.2 Update `docs/src/content/docs/developing/reference/delivery-order.md`: mark the #41 entry in wave 10 delivered with the honest one-paragraph account (what shipped, what was deliberately cut and why — N=3, the struck ship gate).
- [ ] 7.3 Full gate `sh -c 'pnpm check'` green with a positive control; verify zero spend in the gate; stage `openspec/` with `git add -f`.
- [ ] 7.4 PR closes #41; the closing note records the committed calibration table location and the deliberate cuts.
