# Design

Small change; two decisions worth recording. Everything else is mechanical.

## Decision 1: transport — ride `FlaggedReview`, no new command

`blockingStates` already exists end-to-end on the main-process side: `Decomposition.blockingStates` (packages/types/src/index.ts:837) is computed by the deterministic `decompose()` the flagged runner already calls (`runFlaggedReviewWithContextFeed`, apps/desktop/src/main/index.ts:977). The renderer cannot derive it itself (`@rennet/ui` imports only types + protocol, never core), so it must cross the `flagged.review` boundary.

It rides `FlaggedReview` as an additive optional field on **both** variants (`ok` and `failed`), stamped by one unconditional helper from the decomposition the runner already computed. Both variants also carry the command boundary's `patchsetId`, so the renderer rejects any stamped stale result after regenerate. Stamping `failed` too keeps the fact available even when the model runner died: blocked ingestion is deterministic, not a model result. No new command, no new pipeline, no extra decompose call.

App-side, the sheet reads it from the patchset-bound flagged result (`boundFlaggedReview`), so a regenerate-stale result can never disclose the wrong patchset's gaps. If the flagged fetch hasn't landed yet, the sheet shows nothing — acceptable: the disclosure arrives with the same fetch that could produce the "ran clean" claim, so the lie and its correction travel together.

## Decision 2: the sheet disclosure does NOT ride the degradation ledger

The PublishSheet already has a degradation ledger with an acknowledge-before-sign gate (#80). Routing blocking states into it would extend that gate to new content — a new consent ceremony, which Rule Zero forbids and which R18 explicitly does not ask for ("the user finishes and publishes anyway if they choose"). So the disclosure is a separate render-only block (like the shell honesty notice): a new optional `blockingStates` prop on `PublishSheet`, rendered before the sign control, never fed into `ledgerBlocksSign`/`resolveSign`. Absent or empty ⇒ nothing renders; the existing ledger and sign mechanics are untouched.

## Copy

Flagged empty state with blocking states, replacing the unconditional line:

> Nothing was flagged in what could be read — but some content was not ingested, so this is not a full all-clear.

followed by one line per state (`reason` label + `detail`). With findings present or the model review failed, the same per-state list renders as a compact note in the flagged canvas. The sheet uses the same per-state list under a short heading ("Not fully ingested"). Exact class names/styling follow the existing `flagged-failed` / sheet-notice patterns; copy above is normative in intent (qualified, honest), not byte-exact.
