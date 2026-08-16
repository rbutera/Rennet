# Add hunk-grain beyond-asks to the delta re-review account

## Why

The delta re-review account (issue #73) shipped at PATH grain — the honest ceiling of the substrate at the time: no returned-hunk→disposition trace existed and `PatchFile.patch` was treated as opaque text. Both blockers are gone. The handoff-bundle composition (#72) stamps every ask with a stable id and ships a `traceMap` whose spec of record says outright it is "the forward hook issue #73 consumes for delta re-review map-back" — and today nothing consumes it. The decomposition floor already parses every patch into structured hunks. So the account can now say *which hunks* the agent changed beyond the asks — including an unrequested hunk inside a file an ask targets, which path grain structurally cannot see (the file is "covered", so the extra change vanishes into "partially addressed"). That invisible case is exactly the change a tired reviewer skims past; narrating it truthfully is the accountability positioning, and it closes the last open remainder of #73 (delivery order, wave 3 item 3).

## What Changes

- The deterministic delta account gains hunk grain: a new pure computation diffs the prior and successor patchsets hunk-by-hunk (content identity over changed-line bytes, so pure line-number drift is not "change") and the account carries, alongside the existing path-grain `beyondAsks`, the exact beyond-ask hunks — each with its path, line range, and whether it landed in a file no ask targeted (loud) or in an asked file outside every asked span (narrated honestly, not flagged as a violation: the agent is allowed to work beyond the asks).
- The composed bundle's `traceMap` is finally consumed: `review.handoff.run` threads the verified bundle's ask-trace (ask ids + `traceMap` + preview titles) into the successor capture, and the account stamps each ask with the composed task that carried it, so the narration can say "ran as task 2 — 'Tighten the parser'". A plain regenerate (no handoff run) carries no trace and the account computes exactly as today, plus hunk grain.
- The account panel renders the beyond-ask hunks and anchors each to its exact span (today it navigates to the file); the M25 digest prompt gains the hunk-grain facts (still built from ONLY the structured account).
- All additions are optional fields on `DeltaAccount`/`DeltaAskAccount` and the `PatchsetActivated` event — every persisted snapshot and old account validates and renders unchanged.
- Explicitly OUT of scope: connecting the fuzzy sub-file lineage matcher to disposition carry. Neither #73 nor any spec asks for it; the carry stays the deterministic byte-verified one, for the recorded reason (a confident fuzzy `move` can point a human's approval at code they never read — issues #16/#254/#266 own that seam). Also out: any change to the shipped M25 prose seat beyond its prompt facts.

## Capabilities

### New Capabilities

- `delta-rereview-account`: the deterministic, model-free account of what a successor patchset did — per-ask status, path-grain beyond-asks, and now hunk-grain beyond-asks with handoff task attribution. The shipped behavior has no spec of record; this creates it and adds the hunk-grain requirements.

### Modified Capabilities

- `handoff-bundle-composition`: the traceMap requirement currently ends "this capability proves the hook is present and correct and consumes it nowhere". That changes: the run SHALL hand the verified bundle's ask-trace to the successor capture so the delta account can attribute asks to composed tasks.

## Impact

- `packages/types`: optional `beyondAskHunks` on `DeltaAccount`, optional handoff-task attribution on `DeltaAskAccount`, optional `handoff` trace on the `PatchsetActivated` event.
- `packages/core`: hunk-grain delta computation in `delta-account.ts` (reusing the decomposition floor's existing raw-hunk parser — no second diff parser); `foldReview(PatchsetActivated)` and `ReviewService.capture` thread the optional trace; `delta-digest.ts` prompt gains the hunk facts.
- `packages/protocol`: additive optional fields on the delta-account schemas inside `reviewSchema`.
- `apps/desktop`: the `review.handoff.run` handler passes the verified bundle's trace into `service.capture`.
- `packages/ui`: `delta-account-panel` renders hunk rows and anchors to spans.
- Docs, same change: delivery-order.md (wave-3 item delivered) and the agent-handoff concept page.
