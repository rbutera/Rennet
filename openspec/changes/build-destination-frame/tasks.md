## 1. Destination model (pure, TDD)

- [ ] 1.1 `DestinationMode` (`own-branch` / `other-pr`) + `destinationVariant(mode)` framing (title, summary, sign label, `BatchDestination` mapping) over the SAME staged data
- [ ] 1.2 `stagedItems(batch)` / `stagedPayload(batch)` re-express #17's batch view model + payload in the staged vocabulary (byte-identical to `batchPayload`)
- [ ] 1.3 `draftsFromWrites(writes)` — a host stages directly from the L2 writes it emits (dispose == staged)
- [ ] 1.4 `canSign(elapsedMs, holdToSignMs)` pure sign-gate; floor 0 signs immediately, never defaults to approve

## 2. Destination frame component (SSR-render, TDD)

- [ ] 2.1 Renders from review-open with an EMPTY staged set — present, not hidden/absent
- [ ] 2.2 Fills visibly as the staged set grows (count + item list)
- [ ] 2.3 Mode switches the variant (handoff bundle vs review to post) over the same staged data (assert both variants render distinct framing from one staged set)
- [ ] 2.4 Opens the publish sheet (callback wired)

## 3. Publish sheet shell (#22 core, SSR-render + pure, TDD)

- [ ] 3.1 Lists the staged items as exactly what will leave the machine; preview bytes == `stagedPayload(batch)` bytes (asserted, not eyeballed)
- [ ] 3.2 Hold-to-confirm gates the publish act (`holdToSignMs`, floor 0); never defaults to APPROVE
- [ ] 3.3 All-or-nothing per signing act for v1 (no partial selection; subset => withdraw first)
- [ ] 3.4 Documented seams: degradation ledger, three-phase idempotent publish, refined forms (#19), GitHub pipeline (#21) — deferred, zero Git/GitHub mutation

## 4. Staged rename (ruling)

- [ ] 4.1 Rename #17's batch view user-facing copy + aria to "staged"; `withdrawDraft` is the unstage act

## 5. Wire into RennetApp (additive chrome, TDD render-verify)

- [ ] 5.1 Staged state on RennetApp, driven by every disposition (canvas authoring + review mark-read == stage; mark-unread/withdraw == unstage)
- [ ] 5.2 Destination frame rendered as always-present chrome across Files and Canvases views
- [ ] 5.3 Publish sheet opened from the frame
- [ ] 5.4 Fixtures demo + Files/Canvases toggle preserved (no regression)

## 6. Gate

- [ ] 6.1 New pure exports on `packages/ui/src/index.ts`; CSS for the new surfaces
- [ ] 6.2 `pnpm check` green (real checker, not tsgo); every new test shown able to go red
