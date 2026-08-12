# Tasks — delta-rereview-fix-accounting (N2 / #73)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof every fix with the prediction named first, then a full green pass. Assert the contract, never your own implementation. #254's carry is **already shipped** — read it, do not rebuild it.

## 1. Read the shipped substrate
- [ ] 1.1 Read the carry and its result fields: `carryDispositionsByLineage` (`packages/core/src/index.ts:613`), the `PatchsetActivated` fold, and `carriedForward`/`orphaned` on the handoff run result (`apps/desktop/src/main/dispatch.ts:1061`).
- [ ] 1.2 Find the disposition-id trace: how each staged ask in the handoff bundle carries a disposition id and how a returned-patchset hunk traces back to it (the handoff-composition path). Cite the symbols in a comment.
- [ ] 1.3 Confirm the Model Council M25 light seat (`packages/core/src/model-council.ts`) and how a light-tier narration job is routed + budget-gated.

## 2. Deterministic skeleton (core, model-free)
- [ ] 2.1 Build the trace-map arithmetic: for each staged disposition, classify its target as addressed / partially addressed / untouched from the trace + `carried`/`orphaned`.
- [ ] 2.2 Compute the beyond-asks set: returned-patchset hunks tracing to no staged disposition and net-new (not carried).
- [ ] 2.3 Assert the **total partition** invariant: every returned-patchset hunk is exactly one of addressed / beyond-asks / carried-unchanged. A hunk in none is a skeleton bug — fail the assertion, never drop silently.
- [ ] 2.4 Red-proof: revert the beyond-asks detection; the 3-ask fixture (2 addressed, 1 ignored, 1 unrequested) must fail to flag the unrequested change (name that test, watch it redden, restore).

## 3. Optional prose (M25 light seat)
- [ ] 3.1 Route a light-tier narration job over the structured account; budget-gated; bounded prompt (money ceiling).
- [ ] 3.2 Model-free proof: stub the M25 seat to throw and assert the full structured account (2 addressed, 1 untouched, 1 beyond-asks) still renders with no error. Name this test.

## 4. Render on the successor canvas (Zone A / ui)
- [ ] 4.1 Render the account at the top of the successor canvas (stage 7), above the diff.
- [ ] 4.2 Anchor each item: activating it scrolls the diff to the moved hunk(s) and pulses them (`canvas.focus`-style).
- [ ] 4.3 Verify against wireframes `06-review-heart` + `17-flow-overview`. If they place the account differently than "top of canvas", follow the frame and note it in the PR (wireframe wins).
- [ ] 4.4 Confirm the account blocks/gates nothing: re-review and sign proceed without dismissing it.

## 5. Prove it
- [ ] 5.1 Red-then-green: the 3-ask fixture yields all four facts; beyond-asks flagged; reverting detection reddens exactly the named test.
- [ ] 5.2 Full gate green. State the tip sha and the gate total reconciled against the `main` baseline.
