# Tasks — delta-account-digest (#73 M25 half)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof every fix with the prediction named first, then a full green pass. Assert the contract, never your own implementation. Strictly additive over N2 — do not touch `delta-account.ts` or the fold.

## 1. Read the shipped substrate
- [ ] 1.1 Read the delta account: `DeltaAccount`/`DeltaAskAccount` (`packages/types`), `buildDeltaAccount` (`packages/core/src/delta-account.ts`), and `DeltaAccountPanel` (`packages/ui/src/components/delta-account-panel.tsx`).
- [ ] 1.2 Read the light-producer pattern to mirror: `rollup-narration.ts` (budget gate + fail-closed floor), `draft-pr-body-live.ts` + the `review.draftPrBody` command + its dispatch dep + its `packages/core` producer. Cite the seat: `delta-rereview-summary` in `model-council.ts`.

## 2. Core producer (model-free floor built in)
- [ ] 2.1 `buildDeltaDigest(account, deps)` in `packages/core`: resolve the `delta-rereview-summary` seat via `resolveAssignment`; a deterministic resolution ⇒ `unavailable` with no turn. Build a BOUNDED prompt from ONLY the account (per-ask path+status+summary, beyond-asks paths) — no repo/diff content, so the model cannot invent a fact.
- [ ] 2.2 Budget gate: `budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose)`; a refusal ⇒ `unavailable` (never a fabricated digest). Run ONE light turn; an empty/whitespace or thrown result ⇒ `unavailable`. Success ⇒ `{ status: "drafted", text, model }`.
- [ ] 2.3 Red-proof (model-free floor): with the seat/runner stubbed to throw, `buildDeltaDigest` returns `unavailable` and never throws. Name the test.
- [ ] 2.4 Red-proof (grounding): the prompt input carries only the account's facts (assert the built prompt contains the ask paths/statuses and NOT any diff/repo text); a digest is a rephrasing, structurally unable to add a fact.

## 3. Protocol command
- [ ] 3.1 `review.deltaDigest`: input `{ commandId, reviewId }`; output the discriminated `{ status: "drafted", text } | { status: "unavailable", reason }` (mirror `review.draftPrBody`). Named in the schema so it survives IPC.

## 4. Dispatch + root composition
- [ ] 4.1 Optional `draftDeltaDigest?` dep on `DispatchDeps`; a `case "review.deltaDigest"` handler that resolves the latest review, reads its `deltaAccount` (absent ⇒ `unavailable`, honest reason), and calls the dep; no dep ⇒ `unavailable` (never throws).
- [ ] 4.2 Compose `draftDeltaDigest` in `apps/desktop/src/main/index.ts` over the live council light runner (a `delta-digest-live.ts` wrapper mirroring `draft-pr-body-live.ts`). Shared file — coordinate via the merge lock at merge time.
- [ ] 4.3 Dispatch tests: `drafted` happy path; `unavailable` when the review has no `deltaAccount`; `unavailable` (honest, no throw) when the dep is absent.

## 5. Render on top of the facts (Zone A / ui)
- [ ] 5.1 Add an optional `digest?: string` prop to `DeltaAccountPanel`; render it as the headline ABOVE the asks with the "written from the facts below · light model" marker. Absent ⇒ no headline, facts unchanged.
- [ ] 5.2 In `app.tsx`: when `review.deltaAccount` is present, render the panel immediately (facts now) and fire `review.deltaDigest` ONCE per (review, deltaAccount); slot a `drafted` result into the panel; `unavailable`/error ⇒ no headline. A re-render must not re-request; a new re-review requests afresh.
- [ ] 5.3 DOM tests: the panel renders every fact with NO digest prop (the model-free floor at the UI); with a digest prop it shows the headline above the facts; the request fires at most once per account.

## 6. Prove it
- [ ] 6.1 Model-free floor end-to-end: a fixture where the seat throws ⇒ the command answers `unavailable` and the panel renders all facts, no headline, no error. Name the test.
- [ ] 6.2 Full gate green. State the tip sha and the gate total reconciled against the `main` baseline. Confirm `delta-account.ts` + the fold are byte-unchanged (additive-only).
