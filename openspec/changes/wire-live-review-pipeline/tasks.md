## 1. Core: injected harness turn (TDD)

- [x] 1.1 `harness-run-turn.ts`: `createHarnessRunTurn(port, { docType, cwd, model?, signal? })` over the `HarnessPort` interface — read-only session, `outputSchema = bodyJsonSchema(docType)`, one turn, map `session.ended`

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. "Read-only session" is withdrawn from 1.1; the rest of the task stands.
- [x] 1.2 Tests over a fake `HarnessPort`: completed+structuredOutput → emitted; completed w/o structured → failed; failed/cancelled/error frame → failed; asserts the SessionSpec (readOnly, outputSchema, cwd); session always closed

## 2. Core: the live pipeline (TDD)

- [x] 2.1 `pipeline.ts`: `buildReviewCanvases(input)` — `decompose` → `buildRoutePlan` Brita gate → (angle → ordering) → `buildCanvas` per angle; defaults the contracts + provenance seed
- [x] 2.2 Test: real Patchset fixture + mock `runDecompositionTurn` (valid proposal) → five populated canvases derived from the diff; sequence canvas reflects the admitted proposal
- [x] 2.3 Test (Brita refuse): over-budget route plan → `runTurn` NEVER called; canvases still populated from the deterministic floor
- [x] 2.4 Test (Brita pass): within budget → `runTurn` IS called (both arms proven)
- [x] 2.5 Test: no `runDecompositionTurn` → deterministic floor canvases, no crash, sequence populated
- [x] 2.6 Test: `runOrderingTurn` reordering → the sequence canvas presents the comprehension order
- [x] 2.7 Export `buildReviewCanvases` + `createHarnessRunTurn` from `packages/core/src/index.ts`

## 3. Protocol: the canvases IPC command (TDD)

- [x] 3.1 Add `canvasSchema` / `canvasSetSchema` and the `review.canvases` command (`{commandId,reviewId,repoPath}` → `{canvases}`) to `packages/protocol/src/index.ts`
- [x] 3.2 Test: round-trips a real five-angle canvas set; rejects a malformed canvas (positive control)

## 4. Desktop: the electron-free router (TDD)

- [x] 4.1 `apps/desktop/src/main/dispatch.ts`: `createDispatch(deps)` — existing six MVP commands moved verbatim, injected effects, no electron import
- [x] 4.2 Route `review.canvases` + the six `canvas.*` commands (`canvas.disposition` → `ReviewService.setDisposition`; L3 ops ack)
- [x] 4.3 `dispatch.test.ts` (real `ReviewService` + in-memory store): `canvas.disposition` returns a real review (not undefined); the L3 ops return `{ok:true}`; `canvas.adjudicateProposal` returns `{review}`; `review.canvases` returns the injected canvases; a preserved MVP command (`app.bootstrap`/`review.setDisposition`) still works
- [x] 4.4 `index.ts`: build the deps (electron dialog → `chooseRepository`, watcher → `startWatching`/dirty, harness → `buildCanvases` via `createHarnessRunTurn` + `buildReviewCanvases`) and call `createDispatch`; no business logic left in the electron file

## 5. UI: render live canvases, keep the demo (TDD)

- [x] 5.1 `RennetApp` fetches `review.canvases` when a review exists + Canvases view open; renders the real set on success
- [x] 5.2 Fallback to `demoCanvases()` on no-review / fetch failure — the clickable demo never regresses (test both branches)

## 6. Gated manual real-turn (optional, skipped in CI)

- [x] 6.1 `packages/adapters/src/harness-run-turn.real.test.ts` gated by `RENNET_LIVE_HARNESS`: compose the real harness, drive one `createHarnessRunTurn` turn on the user's subscription (non-metered), assert an emitted body; skipped in the normal gate

## 7. Gate

- [x] 7.1 `pnpm check` green across all projects (format, architecture, licenses, lint, typecheck, test, build): zero errors + `Successfully ran target(s)`
