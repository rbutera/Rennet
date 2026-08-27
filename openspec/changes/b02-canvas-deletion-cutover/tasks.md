# Tasks — b02-canvas-deletion-cutover (B2, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first. One cluster per session. The proposal's verdict tables are the deletion authority — delete nothing that is not listed, and record any forced deviation by amending the table in the same commit (the positive control diffs table vs. git). Order is top-down (consumers before providers) so the repo compiles after every cluster: app-ui first, protocol last among the deletions. Wrap `git`/`pnpm`/`nx` in `sh -c '...'`.

## 1. app-ui: delete the canvas workspace surface

- [x] 1.1 Delete the 24 canvas-era components, their 38 component tests, and the 22 app-level `app.*.dom.test.tsx` files listed DELETE in the proposal's app-ui section (includes `collation-draft-canvas.tsx` and `workspace.tsx`/`lens.tsx`/`flat.tsx` + per-angle renderers). Plus 8 amended dying siblings the census missed (5 component tests, 3 app tests — see proposal amendments): 92 files total.
- [x] 1.2 Trim the keepers: `code-view.tsx` drops its `canvas/conversation` + `canvas/logic` wiring (windowRows/WindowRange INLINED — core rendering; discuss/dispose/spanSelect removed; two KEEP dom tests pass); `app/shell.tsx` gutted to the navigation shell + stub review render; `command/commands.ts` (+ `commands.test.ts` cascade) drop the canvas command surface; `index.ts` drops deleted-component re-exports (dying canvas MODULE re-exports kept — modules live until cluster 2, and apps/desktop consumes them; cluster 2 owns their removal). `app.tsx` unchanged (re-exports resolve). `app/review-workspace-route.tsx` is a placeholder stub. Cascade trims to two KEEP CSS-contract tests (`styles-contract.css.test.ts`, `focus-ring.css.test.ts`) that read now-deleted component source.
- [x] 1.3 `sh -c 'pnpm nx affected -t typecheck,test'` green (app-ui + desktop, 9 dep tasks). Commit.

## 2. app-ui canvas reduction + mobile stub

- [x] 2.1 Delete the 34 DELETE-verdict files in `packages/app-ui/src/canvas/` (everything except `registrar`, `read-state`, `symbol`, `collation`, `counterpart` and their tests).
- [x] 2.2 Trim the five survivors self-contained: `collation.ts` inlines the `DispositionType`/`DispositionBatch`/`anchorPathKey`/`DispositionWrite` shapes it used from `authoring.ts`/`logic.ts`; `counterpart.ts` replaces `Canvas`/`CanvasAngle`/`CANVAS_ANGLES` with a local five-value lens union (B3 owns the real `LensKind` home); `read-state.ts` replaces the `Disposition` import with a local shape. No behavior changes — tests still pass.
- [x] 2.3 Stub `apps/mobile/app/daemon/[daemonId]/review/[reviewId]/canvas.tsx` (route renders a placeholder, Q10); delete `apps/mobile/src/lib/canvas-rows.ts` + `.test.ts` and their call sites.
- [x] 2.4 `sh -c 'pnpm nx affected -t typecheck,test'` green. Commit.

## 3. server + adapters cutover

- [x] 3.1 Delete the adapters DELETE set: `canvas-ops-external`/`canvas-ops-server`/`canvas-ops-test-backend`/`canvas-ops-wired.test`, `adjudication-backend` + `adjudication-calibration.*` (incl. `.json`), `ui-verification-backend.*`, `orchestrator-turn.*`/`orchestrator-session-server.*`/`orchestrator-live.real.test`/`orchestrator-codex-live.real.test`, `decisions-fixture.*`/`flagged-fixture.ts`/`noise-fixture.*`. Trim `adapters/src/index.ts` and `codex-wsl-live.real.test.ts`.
- [ ] 3.2 Trim server: `create-server.ts` loses `buildCanvasesForReviewWithContextFeed`/`buildCanvasesForReview`, the `review.canvases` delivery, canvasOps@2 wiring, and every dead-pass call; `dispatch.ts` (+ test) drops `buildCanvases` from the seam; delete `orchestrator.ts` + `orchestrator.test.ts`; trim `review-intelligence-session.*` (hypothesis phase out, ask flow stays), `review-ask-live.*`, `live-review-backend.test.ts`, `delta-digest-live.*`, `projection.test.ts`. `projection.ts` untouched.
- [ ] 3.3 `sh -c 'pnpm nx affected -t typecheck,test'` green. Commit.

## 4. core cutover — the reconciliation executed

- [ ] 4.1 Delete the canvas trio: `canvas.ts`, `canvas-ops.ts`, `canvas-change-feed.ts` + tests — first inlining `compareCodeUnits` into `element-diffs.ts` (its one surviving consumer).
- [ ] 4.2 Delete the nine model-backed passes + tests (#464 dec. 2): `angle-generation`, `finding-generation`, `decision-generation`, `hypothesis-generation`, `finding-adjudication`, `adjudication-corpus`, `ui-verification`, `ordering-pass`, `rollup-narration`.
- [ ] 4.3 Delete the cascade: `orchestrator-primer.*`, `orchestrator-session.*`, `context-update-stream.*`, `dual-finding-review.*`, and the six dead-runner test files (`convention-injection`, `hypothesis-injection`, `budget-gate`, `pipeline-hypothesis`, `pipeline-review-intelligence`, `finding-verification-composition`).
- [ ] 4.4 Trim the survivors: `pipeline.ts` (+ test) loses the generation/placement phases and the `buildCanvas` call, keeping the deterministic spine `review-backend` needs; `dual-seat.ts` (+ test) drops `finding-generation` imports; `review-backend.ts` (+ test) drops canvas-ops/canvas types; `noise-generation.test.ts` drops its `angle-generation` imports; `index.ts` drops dead re-exports. The deterministic producers (`element-diffs`, `blast-radius`, `openspec-change`, `finding-reconcile`, `noise-generation`) keep passing their own tests.
- [ ] 4.5 `sh -c 'pnpm nx affected -t typecheck,test'` green. Commit.

## 5. protocol: delete the canvas.* surface and state model

- [ ] 5.1 In `index.ts`: delete `canvasSchema`, the five-angle `canvases` record, the `review.canvases` command, the six `canvas.*` commands, and the Canvas-family inferred-type exports. In `bodies.ts`: the `canvas.*` bodies. In `domain.ts`: the Canvas state model block (`Canvas` root, four layer types, `CanvasAngle`/`CANVAS_ANGLES`, `AnalysisElement`/`AnalysisCohort`, `Proposal*`, `BlastRadiusPaint`, `CanvasChangeNotification`, `Disposition`/`DispositionType`/`DispositionLayer`). Anchor/patchset types stay.
- [ ] 5.2 Delete `canvas-commands.test.ts`, `review-canvases.test.ts`; trim `session.ts`/`session.test.ts`/`rsp.ts`/`index.test.ts` of canvas and dead-pass references (RSP validators for surviving `noise-generation`/`finding-verification` stay).
- [ ] 5.3 Sweep every remaining workspace reference to a deleted protocol type (the survivor trims of clusters 1–4 should have left none; fix any straggler by trimming the caller, never by resurrecting the type).
- [ ] 5.4 `sh -c 'pnpm nx affected -t typecheck,test'` green. Commit.

## 6. instructions → prompts

- [ ] 6.1 Rename `packages/lens-instructions` → `packages/prompts`: directory, `package.json` name `@rennet/prompts`, `project.json` name `rennet-prompts`, tsconfig/workspace references; `sh -c 'pnpm install'` to refresh the lockfile.
- [ ] 6.2 Absorb the instruction survivors into `packages/prompts/src` verbatim (JSDoc intact): the `PromptContract` type + `renderBaseInstruction`, prompt-layer assembly (`renderLayer`, `PromptLayers`, `AssembleOptions`, `PROMPT_LAYER_ORDER`), `renderConventionLayer`, `NOISE_CONTRACT`, the decomposition contracts, `FINDING_VERIFICATION_CONTRACT` + verification prompt renderers/types, `CI_CLASSIFICATION_CONTRACT`/`CI_CLASSIFICATION_OUTPUT_SCHEMA`/`renderCiClassificationPrompt`. The dead-pass contracts (`FINDING_CONTRACT`, `DECISION_CONTRACT`, `ORDERING_CONTRACT`, `ROLLUP_NARRATION_CONTRACT`, `REVIEW_HYPOTHESIS_CONTRACT`, `FINDING_ADJUDICATION_CONTRACT`, `UI_VERIFICATION_CONTRACT` + renderers) are not carried. Delete `packages/instructions` entirely.
- [ ] 6.3 Re-point every surviving `@rennet/instructions` import to `@rennet/prompts` (`core`: `pipeline`, `finding-verification`, `ci-refinement`, `noise-generation`, `harness-run-turn`, `dual-seat`; `adapters`: `ci-refinement-backend`, `convention-catalogue-reader`, integration tests) and swap the `package.json` edges (`instructions` out, `prompts workspace:*` in).
- [ ] 6.4 Carry the B1-era boundary law: `eslint.config.mjs` — remove `layer:instructions` everywhere, rename `layer:lens-instructions` → `layer:prompts` and grant it `layer:protocol`; grant `layer:core`/`layer:adapters`/`layer:server` the `layer:prompts` edge that replaces `layer:instructions`. `scripts/check-boundaries.mjs` — remove the `@rennet/instructions` entry, rename `@rennet/lens-instructions` → `@rennet/prompts` → `{@rennet/protocol}`, swap `instructions` for `prompts` in the consumer edges. Rewrite the CLAUDE.md "Package boundaries" paragraph to the same law.
- [ ] 6.5 `sh -c 'pnpm nx affected -t typecheck,test'` green (architecture check included). Commit.

## 7. successor-account rename

- [ ] 7.1 Rename `packages/core/src/delta-account.ts` → `successor-account.ts` (+ test), and the exported symbols (`DeltaAccount`-family types in `protocol/src/domain.ts`/`index.ts`, `deltaAccount`/`delta account` identifiers and copy) to successor-account naming across `core`, `protocol`, `server` (`create-server`, `dispatch`, `delta-digest-live`), `app-ui` (`delta-account-panel.tsx` → `successor-account-panel.tsx` + its dom tests, `shell.tsx`, `context-manifest-panel.tsx`), and `apps/mobile` (`digest.tsx`, `delta-counts.*` references). Mechanical rename, zero behavior change; `delta-digest`/pipeline-Delta names are NOT in scope (the collision the rename ends is the re-review "delta" only).
- [ ] 7.2 `sh -c 'pnpm nx affected -t typecheck,test'` green. Commit.

## 8. Docs (same change, definition of done)

- [ ] 8.1 Delete `docs/developing/concepts/canvas-model.md` and remove/redirect its inbound links (`docs/README.md`, `doc-architecture.md`, sidebar config) — the Board replacement page is #490's scope, coordinated, not duplicated here.
- [ ] 8.2 Rename the re-review delta to successor account in `docs/developing/concepts/delta-rereview-and-lineage.md` (census: this page is part of the #457 rename) and in `agent-handoff.md`, `architecture-contracts.md`, `using/guides/getting-started.md` where they say "delta account".
- [ ] 8.3 Update the pages the deletions invalidate: `review-lenses.md` (canvas/angle framing → lens identity, pointing at `lens-pipeline.md`), `lens-pipeline.md` + `handoff-and-exits.md` (`lens-instructions` → `prompts`), `monorepo-map.md` (delete the `rennet-instructions` row, rename the `rennet-lens-instructions` row, fix every dependency column), `architecture-overview.md`, `surfacing-and-routing.md`, `repository-bootstrap.md`, `collation-and-publishing.md`, `code-intelligence.md`, `context-assembly.md`, `comment-refinement.md`, `design-doctrine.md`, `harness-adapters.md`, `contracts-and-rulings.md`, `doc-architecture.md`, `developing/index.md`, `docs/README.md`, `using/guides/getting-started.md`, `browser-rennet.md`, `windows-and-wsl.md`.
- [ ] 8.4 Re-grep `docs/` (excluding `docs/dist` and the plan doc, which narrates this rebuild deliberately) for `canvas`, `@rennet/instructions`, `lens-instructions`, `delta account` — fix stragglers so no reader is wrong after this change.
- [ ] 8.5 Commit.

## 9. Verification (packet)

- [ ] 9.1 `sh -c 'pnpm check'` green (exit 0, real target success — not a masked pipe status).
- [ ] 9.2 `grep -ri "CanvasAngle\|canvas\." packages/ --include="*.ts"` shows no survivors outside the KEEP verdicts (registrar/read-state/symbol/collation/counterpart and their tests are the only legitimate hits). Show the grep output.
- [ ] 9.3 Positive control: diff the proposal's verdict tables against `git log --diff-filter=D --name-only` for this change's commits — every DELETE-verdict file deleted, no unlisted deletion, amendments (if any) committed alongside their deviations. Show the diff.
- [ ] 9.4 Confirm `packages/instructions` gone and `rennet-prompts` present: `sh -c 'pnpm nx show projects'` lists no `rennet-instructions`/`rennet-lens-instructions`, lists `rennet-prompts`.
- [ ] 9.5 Second positive control (boundary law): temporarily add `import "@rennet/prompts"` to `packages/app-ui/src/index.ts` — architecture MUST fail (app-ui has no prompts edge). Show the failure, revert, re-run green.
- [ ] 9.6 Flip B2 in `BUILD-STATUS.json` and output the completion sigil `<promise>B02-COMPLETE</promise>`.
