## Why

Rai's articulation of what Rennet IS (voice, 2026-08-07, issue #64): in the prototype it is obvious that everything leads UP TO one of two destinations in the top-right — the **PR submission** (your own branch) or the **PR review document** (someone else's PR). Rennet is fundamentally about **STAGING things for an action** — "like staging things for a commit, but you're staging for a PR or staging for a PR review." That journey is NOT currently communicated in the UI: #17 shipped the staged list as a hidden dock section, not as the visible NORTH the whole review builds toward.

This change makes the destination the visible north. It reframes #17's batch view + the #22 publish sheet as a persistent, always-present target the user is provably staging toward, and ships the #22 publish-sheet SHELL (preview + hold-to-confirm) so the journey ends somewhere solid.

Ratified rulings encoded here (Rai, 2026-08-07): **dispose == staged** (a disposition IS staged the moment it is made; there is no separate staging act); **withdraw == unstage** (and #17's "batch view" is renamed the **staged** view); **publish is all-or-nothing per signing act for v1** (shipping a subset means withdraw first, then sign).

## What Changes

- Add the **destination model** (`canvas/destination.ts`, pure): a `DestinationMode` (`own-branch` → the handoff / PR-submission bundle; `other-pr` → the review you'll post) and `destinationVariant(mode)` that frames the SAME staged data two ways. The staged set is the #17 batch; `stagedItems` / `stagedPayload` re-express it in the "staged" vocabulary, and `draftsFromWrites(writes)` lets a host stage directly from the dispositions it already emits (dispose == staged). The pure sign-gate `canSign(elapsedMs, holdToSignMs)` gates the publish act (accessibility floor 0 signs immediately).
- Add the **destination frame** (`components/destination-frame.tsx`): a persistent top-right target that renders from review-open EMPTY, shows the variant heading + summary by mode, and visibly fills with the staged set as dispositions are made. It is the always-present chrome that names WHAT the user is staging toward, and opens the publish sheet.
- Add the **publish sheet shell** (`components/publish-sheet.tsx`, #22 core): the staged items listed as exactly what will leave the machine (preview bytes == the staged payload bytes, asserted), a **hold-to-confirm** publish affordance (`holdToSignMs`, floor 0, never defaults to APPROVE), and the all-or-nothing signing act. The degradation ledger, three-phase idempotent publish, refined-comment forms (#19), and the #21 GitHub pipeline are documented seams, deferred.
- Rename #17's batch view to the **staged** view (user-facing copy + aria), per the ruling. `withdrawDraft` is the unstage act.
- Wire it into `RennetApp`: staged state driven by every disposition (canvas authoring and the review mark-read/unread), the destination frame rendered as always-present chrome across both the Files and Canvases views, and the publish sheet opened from it. The fixtures demo and the Files/Canvases toggle are preserved unchanged — the destination is additive chrome.

## Capabilities

### New Capabilities

- `destination-frame`: a persistent, always-present destination that names the two variants (own-branch handoff bundle / other-PR review) over one staged set, fills as dispositions are made (dispose == staged), unstages on withdraw, and ends in an all-or-nothing hold-to-confirm publish sheet whose preview bytes equal the staged payload bytes.

## Impact

- Adds `packages/ui/src/canvas/destination.ts`, `packages/ui/src/components/destination-frame.tsx`, `packages/ui/src/components/publish-sheet.tsx` and their tests; extends `packages/ui/src/app.tsx` (staged state + always-present chrome, additive), `packages/ui/src/components/batch-view.tsx` (staged rename), `packages/ui/src/index.ts` (new pure exports), and the stylesheet. No new package, no new runtime dependency, no dependency-arrow change: the `architecture` and `licenses` gates are untouched.
- `layer:ui` stays clean: the new logic consumes `Disposition` types from `@rennet/types` and the #17 `authoring.ts` batch functions; it never imports `@rennet/core`. The staged payload is the #17 `batchPayload`, so "preview bytes == staged payload bytes" holds by construction.
- Deferred with documented seams: the degradation ledger + read-vs-attested honesty (#22), three-phase idempotent publish (#22/R17), refined-comment preview forms (#19), and the actual GitHub publish pipeline (#21). This slice ships the frame + preview + hold-to-confirm; nothing here performs any Git or GitHub mutation.
