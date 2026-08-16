# Tasks: add-handoff-delta-rereview

Red-first discipline: every group's first task writes the failing test that proves the behavior is missing today (the positive control), then makes it pass. `pnpm check` is the gate before every push.

## 1. Types and hunk substrate

- [x] 1.1 RED: unit test in `packages/core` asserting that an unrequested hunk inside an asked file surfaces in the account with its line range (the case path grain cannot see — today `buildDeltaAccount` reports only `partially-addressed` and the test fails).
- [x] 1.2 Add the additive-optional types in `@rennet/types` (design D4): `DeltaBeyondHunk`, `DeltaAskAccount.handoffTask?`, `DeltaAccount.beyondAskHunks?`, and the optional `handoff` trace field on the `PatchsetActivated` event.
- [x] 1.3 Export the decomposition floor's raw-hunk parser from `packages/core/src/decomposition.ts` (or lift it to a shared module) and reuse it from `delta-account.ts` — do NOT write a second diff parser (design D2).

## 2. Core: hunk-grain account

- [x] 2.1 Implement `newHunksBetween(prior, successor)` in `delta-account.ts`: content-identity over added+deleted line bytes, multiset matching, rename-source aware, per-file truncation fallback (design D1, D6). Unit tests: line-number drift yields nothing; a genuinely new hunk is found; a truncated file yields no hunk claims.
- [x] 2.2 Extend `buildDeltaAccount` to classify new hunks against ask coverage (path-grain ask, or side-aware span intersection at the carried path) and emit `beyondAskHunks` with the two buckets; `beyondAsks` path list unchanged (design D3, D4). Turns test 1.1 green; add the unasked-file bucket and the four-fact fixture (3 asks: 2 addressed, 1 untouched, 1 unrequested change → all four facts stated) at hunk grain.
- [x] 2.3 Fold + capture threading (design D5): `ReviewService.capture` takes the optional handoff trace projection, includes it in the idempotency digest, stamps it on `PatchsetActivated`; the fold matches bundle asks to dispositions by anchor identity and stamps `handoffTask` attribution. Fold tests: attribution present on a traced activation, absent on a regenerate, unmatched ask degrades to no attribution.

## 3. Protocol and dispatch

- [x] 3.1 RED: protocol round-trip test for an account carrying `beyondAskHunks` and `handoffTask` (fails until the schemas exist); then add the additive-optional fields to `deltaAskAccountSchema`/`deltaAccountSchema` and assert a legacy account (fields absent) still parses.
- [x] 3.2 `review.handoff.run` in `apps/desktop/src/main/dispatch.ts` passes the verified bundle's trace projection (id-stamped ask anchors, `traceMap`, task titles — no prompts/bodies) into `service.capture`. Dispatch test: a run's captured review carries task attribution; the R28 immutability assertion still holds.

## 4. UI and digest prose

- [x] 4.1 RED: DOM test — the panel renders beyond-ask hunk rows with bucket labels and activating one calls navigation with the hunk's span (fails today: `onAnchor` is path-only); then widen `onAnchor(path, span?, side?)` in `delta-account-panel.tsx`, render `beyondAskHunks` (loud unasked-file bucket keeps `role="alert"`; asked-file bucket labeled as narration), render per-ask "task N — title" when attributed, and route span navigation in `app.tsx` (design D7). Legacy-account fallback test: no hunk fields ⇒ today's path-grain rendering, unchanged.
- [x] 4.2 `buildDeltaDigestPrompt` gains the hunk-grain facts (path, range, bucket; enumeration capped with an honest "and N more") built from ONLY the account; test asserts the prompt contains the hunk facts and nothing outside the account, and that an account without hunk fields produces today's prompt.

## 5. Docs (same change — definition of done) and gate

- [x] 5.1 Update `docs/src/content/docs/developing/reference/delivery-order.md`: move wave-3 item 3 (#73 hunk-grain beyond-asks) into "what works now"; correct the "fuzzy sub-file matcher … not connected to disposition carry" line to state it remains deliberately unconnected (design non-goal, issues #16/#254/#266).
- [x] 5.2 Update the agent-handoff concept page (`docs/src/content/docs/developing/concepts/agent-handoff.md`) to describe the hunk-grain account and the traceMap attribution; update the stale "consumes it nowhere" language anywhere it appears (spec of record is updated by archive; check code comments in `delta-account.ts`, `handoff-compose.ts`, `types` doc comments).
- [ ] 5.3 Close-out: `pnpm check` green with the new tests as positive controls; update the #73 issue comment trail (the "STILL OPEN: true hunk-grain" remainder is now delivered) when the PR lands.
