## 1. Ledger gate (pure, TDD) — `canvas/destination.ts`

- [ ] 1.1 Add the UI-local `PublishLedger` / `LedgerEntry` view-model types (over `@rennet/types` primitives; no `@rennet/core` import)
- [ ] 1.2 `ledgerBlocksSign(ledger, acknowledged)`: true iff the ledger is present, has ≥1 entry, and is not acknowledged; false when absent, empty, or acknowledged
- [ ] 1.3 Unit tests for `ledgerBlocksSign` (present+unacked → blocks; present+acked → open; empty → open; undefined → open) — each red-provable

## 2. Publish sheet safety wiring (mounted DOM, TDD) — `components/publish-sheet.tsx` + `publish-safety.dom.test.tsx`

- [ ] 2.1 **Emit fidelity (MUT A):** a sufficient hold calls `onSign` with a string BYTE-EQUAL to `stagedPayload(batch)` (fake-timer the clock between mousedown/mouseup). RED-proof: emit a transform in `endHold`.
- [ ] 2.2 **Hold-gate wiring (MUT C):** a too-short hold does NOT call `onSign`; a sufficient hold does. RED-proof: make `endHold` sign unconditionally.
- [ ] 2.3 **Ledger gate:** with an unacknowledged `ledger`, a sufficient hold does NOT sign; after acknowledging, the same hold DOES sign; both emit byte-equal `stagedPayload`. RED-proof: sign on `resolveSign` alone, ignoring the block.
- [ ] 2.4 **Keyboard sign (a11y resolve):** Enter (and Space) on the focused sign control calls `onSign` with byte-equal `stagedPayload` at the default non-zero hold; and does NOT sign when the ledger is unacknowledged. RED-proof: remove the `onKeyDown` handler / emit a transform.
- [ ] 2.5 Wire the ledger acknowledge control into the sheet (lists the N entries; local `acknowledged` state); both sign paths gate on `ledgerBlocksSign`. Absent/clean ledger → behaviour unchanged.
- [ ] 2.6 Honesty affordance: a persistent "shell publishes nothing — real publishing lands in #21" notice on the sheet (present at render; aria-legible).

## 3. App-level clear-on-sign (mounted DOM, TDD) — `app.test.tsx`/`app.dom.test.tsx`

- [ ] 3.1 **App clear (MUT I):** mount `RennetApp` with a minimal fake `RennetBridge`; stage a disposition; open the sheet; complete a sign; assert the destination `data-staged-count` returns to `0` and the sheet closes. RED-proof: delete `setStaged([])` from the `onSign` handler.

## 4. Retire the vacuous gate

- [ ] 4.1 Replace `destination.test.tsx`'s hold-gate PRESENCE check (`data-hold-ms="800"`) so it is no longer the safety guarantee — the SSR render tests may remain as rendering coverage, but the hold/emit safety property is proven by the mounted tests in §2. Leave no presence check standing AS the gate.

## 5. Gate, red-proof, and verify

- [ ] 5.1 `pnpm check` green (typecheck via nx/real tsc, NOT bare `tsc`/tsgo; lint; all UI tests)
- [ ] 5.2 Hand-prove EACH safety test red (neuter invariant → named test reddens → restore byte-identical → full GREEN pass); record the mutation used per test in the PR body
- [ ] 5.3 Confirm `layer:ui` boundary intact (no `@rennet/core` import); no new dependency; `architecture`/`licenses` gates untouched
