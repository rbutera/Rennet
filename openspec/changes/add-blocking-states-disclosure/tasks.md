## 1. Carry blockingStates over the flagged.review boundary

- [x] 1.1 Add optional `blockingStates?: readonly DecompositionBlockingState[]` to BOTH `FlaggedReview` variants in `packages/types/src/index.ts` (additive; pre-change shapes unchanged), with a doc comment naming R18/#309.
- [x] 1.2 Extend `flaggedReviewSchema` in `packages/protocol/src/index.ts` so both branches admit the optional field (reason enum `truncated|binary|submodule`, nullable `path`, string `detail`); confirm `schema-coverage.test.ts` passes.
- [x] 1.3 In `runFlaggedReviewWithContextFeed` (`apps/desktop/src/main/index.ts`), spread `blockingStates: decomposition.blockingStates` onto the returned result — ok and failed alike — from the `decompose(patchset)` it already computes. No new decompose call, no new command.
- [x] 1.4 Test (positive control): a dispatch/runner test where the active patchset carries a binary or truncated file asserts the `flagged.review` output carries the matching `blockingStates`; it fails if the stamp is removed.

## 2. Flagged lens disclosure

- [x] 2.1 Carry `blockingStates` through `buildFlaggedIndex` into the `FlaggedIndex` ok variant (`packages/ui/src/canvas/flagged.ts`), with a unit test that it survives the fold.
- [x] 2.2 In `packages/ui/src/components/flagged.tsx`: when `blockingStates` is non-empty, render the disclosure block (one line per state: reason label + detail) and replace the unconditional "ran clean" empty-state copy with the qualified copy from design.md. Empty/absent states render exactly the pre-change copy. With findings present, the disclosure renders beside the rows.
- [x] 2.3 DOM test (the issue's required positive control) in `packages/ui/src/components/flagged.dom.test.tsx`: an ok/empty review WITH blocking states must NOT display the unqualified "ran clean" text and MUST display the disclosure with reason + detail; an ok/empty review WITHOUT them keeps the honest all-clear. Deleting the disclosure turns the test red.

## 3. Publish sheet disclosure

- [x] 3.1 Add an optional `blockingStates` prop to `PublishSheet` (`packages/ui/src/components/publish-sheet.tsx`); when non-empty, render the "Not fully ingested" block before the sign control. It must NOT feed `ledgerBlocksSign`, `resolveSign`, the ack state, or the ledger signature — render-only, per Rule Zero.
- [x] 3.2 In `packages/ui/src/app.tsx`, feed the prop from the patchset-bound flagged result (`boundFlaggedReview`), so a regenerate-stale result never discloses the wrong patchset's gaps.
- [x] 3.3 DOM tests: (a) sheet with blocking states shows the disclosure; (b) a sufficient hold still signs with the disclosure present (no new gate); (c) sheet without them renders no disclosure. (a) fails if the disclosure is deleted; (b) fails if anyone wires it into the gate.

## 4. Docs (same change — definition of done)

- [x] 4.1 Update `docs/src/content/docs/developing/reference/delivery-order.md`: the wave 2 / #309 entry stops describing the disclosure as missing and records it as delivered.
- [x] 4.2 Sweep docs for pages describing the Flagged empty state or PublishSheet contents (e.g. any "ran clean" description) and qualify them with the blocked-ingestion disclosure; add nothing speculative.

## 5. Gate

- [x] 5.1 Run `pnpm check` clean; confirm the new DOM tests were seen red first (comment out the disclosure once locally) so the positive control is real.
