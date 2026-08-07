## 1. Core: the Codex-port injected turn (TDD)

- [x] 1.1 `codex-run-turn.ts`: `createCodexRunTurn(port, { docType, patchset, manifest, model, effort, signal? })` over the `CodexUtilityPort` interface — one `port.complete({ maxRetries: 0 })` per turn, map admitted → emitted body, rejected/exec-failed → turn failure
- [x] 1.2 Tests over a fake `CodexUtilityPort`: admitted → emitted body (+ tokens); rejected → failed; exec-failed → failed; asserts `complete` called exactly once with `maxRetries: 0` and the seat's docType/model/effort/manifest/patchset
- [x] 1.3 Re-export `codex-run-turn` from `packages/core/src/index.ts`

## 2. Core: wire the council + executor selection into the pipeline (TDD)

- [x] 2.1 `pipeline.ts`: add `council?: CouncilResolveContext` (already present) + `codexPort?: CodexUtilityPort` to `ReviewPipelineInput`; per-seat resolve `{harness,model,effort,trace}`, stamp all four into the seat provenance seed (harness follows the resolved model), select the executor by resolved harness (Claude turn vs `createCodexRunTurn` over the port), gate the model phase on the decomposition seat having an executor
- [x] 2.2 Test (R39 cross-harness live, `both`): Claude turn + fake Codex port injected → proposal executes via the Claude turn, ordering executes via the Codex port (port `complete` called, Claude ordering turn NOT called); proposal harness = claude-code, ordering harness = codex
- [x] 2.3 Test (honest provenance): the cross-harness run stamps model+effort+harness+trace consistently per seat; a regression guard asserts NO seat pairs a Codex model with a Claude harness
- [x] 2.4 Test (shared budget, red): ceiling 5, Claude proposal seat always rejects + Codex ordering seat always rejects → exactly 5 combined turns across the two harnesses, 6th refused, both floor, canvases render
- [x] 2.5 Test (`claude-only`): both seats resolve to Claude, execute via Claude turns, Codex port never called
- [x] 2.6 Test (`codex-only`): both seats resolve to Codex, execute via the Codex port, no Claude turn called
- [x] 2.7 Update the existing acceptance-3 test to provide a fake Codex port (the live invariant) and assert the ordering seat executes via the port with honest codex harness
- [x] 2.8 Test (no council): caller-supplied provenance model stands, no trace (prior behaviour preserved)

## 3. Adapters: the Codex availability probe (TDD)

- [x] 3.1 `codex-exec.ts`: `discoverCodexAvailability(run?)` runs `codex --version` through an injected run seam → `{ available, version }`
- [x] 3.2 Tests over an injected run: exit 0 + version → available; non-zero / throw → unavailable
- [x] 3.3 Export `discoverCodexAvailability` from `packages/adapters/src/index.ts`

## 4. Desktop: composition root wiring

- [x] 4.1 `index.ts`: memoize the real `CodexUtilityPort` (`createCodexUtilityAdapter`) and the codex-availability probe alongside the Claude harness
- [x] 4.2 `buildCanvasesForReview`: compute `availability.installed` from the discovered Claude adapter + the codex probe (invariant: `codex` installed ⟺ the port is provided), pass `council: { availability }` + `codexPort` into `buildReviewCanvases`

## 5. Gate

- [x] 5.1 `pnpm check` green across all projects (format, architecture, licenses, lint, typecheck, test, build): zero errors + `Successfully ran target(s)`, real checker (tsc6, not tsgo)
