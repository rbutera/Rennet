## Why

The decomposition floor already emits `Decomposition.blockingStates` (R18: `truncated | binary | submodule` — content the floor could not ingest), and it reaches the `diff.structure` canvas op (#307/#308). But it never reaches the two surfaces a human actually reads: the Flagged lens renders the unconditional "Reviewed. Nothing was flagged — this angle ran clean, it was not skipped." even when ingestion was blocked, and the PublishSheet shows nothing about incomplete ingestion before signing. That is a UI lie — an absence of findings over content that was never ingested reads as an all-clear. Issue #309; delivery-order wave 2 names it the worst live UI lie.

## What Changes

- `FlaggedReview` (both `ok` and `failed` variants) gains an additive optional `blockingStates` field, stamped by the desktop `flagged.review` runner from the deterministic decomposition it already computes (`decompose(activePatchset)` — no new pipeline, no model spend).
- The protocol `flaggedReviewSchema` admits the new optional field so it crosses the command boundary.
- The Flagged lens renders a blocked-ingestion disclosure whenever `blockingStates` is non-empty, including beside a failed model review, and the unqualified "ran clean" copy becomes unreachable in that case — the empty state is qualified: nothing was flagged *in what could be read*.
- The PublishSheet renders the same disclosure before the sign control. It is honest copy only: it never feeds `ledgerBlocksSign`, `resolveSign`, or any acknowledgement — per R18 the user finishes and publishes anyway if they choose, and per Rule Zero no new gate or ceremony is added.
- A DOM test proves a review over a truncated/binary-only patch cannot display an unqualified "ran clean" state (fails if the disclosure is deleted).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `canvas-ui`: the Flagged lens's empty state must disclose blocked ingestion instead of claiming an unconditional clean run.
- `publish-safety-gate`: the publish sheet must disclose blocked ingestion before signing, as non-gating honest copy.

## Impact

- `packages/types/src/index.ts` — `FlaggedReview` gains optional `blockingStates` (reuses the existing `DecompositionBlockingState` type; additive, pre-#309 shapes unchanged).
- `packages/protocol/src/index.ts` — `flaggedReviewSchema` admits the field.
- `apps/desktop/src/main/index.ts` — the flagged runner attaches `decomposition.blockingStates` to its result (ok and failed).
- `packages/ui/src/canvas/flagged.ts` — `buildFlaggedIndex` carries `blockingStates` into `FlaggedIndex`.
- `packages/ui/src/components/flagged.tsx` — qualified empty-state copy + disclosure block.
- `packages/ui/src/components/publish-sheet.tsx` + `packages/ui/src/app.tsx` — new optional `blockingStates` prop, fed from the patchset-bound flagged result.
- Docs: `docs/src/content/docs/developing/reference/delivery-order.md` wave 2 entry (the claim "the disclosure does not reach flagged.tsx / publish-sheet.tsx" becomes wrong once this lands).
