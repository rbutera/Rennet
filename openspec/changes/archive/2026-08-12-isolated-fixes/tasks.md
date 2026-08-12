# Tasks — isolated-fixes

Red-proof each fix with the failure prediction named before implementation. Run repository work through Nx, one invocation at a time. Do not touch the renderer or add an admission/consent/capability gate.

## 1. #94 — prove the narration payload is title-only

- [x] 1.1 Prediction: capture the assembled `runRollupNarration` prompt from a decomposition containing unique added/deleted/context sentinels; before the fix, none of those code sentinels appears because `renderPayload` emits only node titles and coverage titles.
- [x] 1.2 Add the red test in `packages/core/src/rollup-narration.test.ts`; assert the chunk id/title/files and all small-fixture hunk sentinels reach the payload, so deleting chunk-evidence serialisation makes the test fail.
- [x] 1.3 Add an oversized multi-chunk red case; assert the encoded excerpt sum is at most `NARRATION_CHUNK_EXCERPT_MAX_BYTES`, later chunks receive evidence, truncation is reported, and identical input produces byte-identical excerpts.

## 2. #94 — add bounded chunk evidence

- [x] 2.1 Add the total and per-chunk byte constants plus deterministic UTF-8-safe excerpt helpers in `packages/core/src/rollup-narration.ts`; preserve reading order, hunk order, file identity, and line-kind labels without claiming reconstructed unified-diff order.
- [x] 2.2 Extend `renderPayload` and its call site to include the decomposition chunk-evidence array alongside the byte-unchanged node array.
- [x] 2.3 Make the small and oversized prompt tests green. Add a regression proving an otherwise-valid uncited account still admits under the unchanged validator/coverage rules; do not add citation-count validation.

## 3. #224 — prove packaged lookup cannot resolve a bare CLI

- [x] 3.1 Prediction: model a packaged process with empty inherited/login-shell PATH and an executable Cursor bundle path; before the fix, the composition attempts bare `cursor`, so no absolute candidate is launched and the line-targeted open falls back.
- [x] 3.2 Add red resolver/launch tests in `apps/desktop/src/main/open-in-editor.test.ts` for the packaged Cursor bundle and for a `code` executable supplied by inherited or harvested PATH. Assert every spawned command is absolute and retains `-g <absolute-file>:<line>`.
- [x] 3.3 Add a red fallback-order case where the first resolved executable throws and the next succeeds; assert the OS fallback does not run. Add the no-candidate positive control where the existing OS fallback does run and no bare command is spawned.

## 4. #224 — resolve absolute editor executables

- [x] 4.1 Add injected, deterministic executable discovery beside `performOpenInEditor`: preserve `EDITOR_CLIS` order, de-duplicate inherited/login-shell PATH directories, add `/Applications` and `~/Applications` bundle candidates for the existing editor family, and executable-check every absolute candidate.
- [x] 4.2 Wire the desktop composition to lazily resolve and memoize the absolute candidate list, then pass only those paths to `execFileAsync` with the existing line-jump arguments. Keep `performOpenInEditor`, the protocol command, and `shell.openPath` fallback behaviour unchanged.
- [x] 4.3 Make the packaged, development-PATH, candidate-fallback, and no-candidate tests green. Read-verify that `apps/desktop/src/main/index.ts` no longer calls `execFileAsync` with a member of `EDITOR_CLIS` by bare name.

## 5. Focused proof and scope audit

- [x] 5.1 Run `pnpm nx test rennet-core` and confirm the #94 red controls now pass for the intended reason.
- [x] 5.2 Run `pnpm nx test rennet-desktop` and confirm the #224 red controls now pass for the intended reason.
- [x] 5.3 Run `pnpm nx run-many -t lint,typecheck -p rennet-core,rennet-desktop`; confirm no renderer, preload, protocol, settings, dependency, or output-admission files changed.

## 6. Gate

- [x] 6.1 `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`).
