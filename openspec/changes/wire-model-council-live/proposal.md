## Why

The Model Council (#69, `resolveAssignment` + the live `invocation-budget`) and the CodexUtilityPort (#66, `codex exec`) are both merged and tested in isolation — **but on the live path the council is dormant and its provenance is a lie.** Two concrete gaps on `main`:

1. `buildCanvasesForReview` (`apps/desktop/src/main/index.ts`) passes **no council context** to `buildReviewCanvases`, so `resolveAssignment` never runs in production. Provenance stamps `model: "unknown"` (the `DEFAULT_PROVENANCE_SEED`), even though the council knows exactly which mind should run each seat.
2. When a council context **is** supplied (the acceptance-3 pipeline test), the pipeline stamps `model`, `effort`, and `resolutionTrace` but **not `harness`** — so a seat the council resolves to a Codex model (e.g. ordering → `gpt-5.6-terra` under `both`) records `model=gpt-5.6-terra` with `harness=claude-code`: a **contradictory ledger**, and the Codex model never actually runs. The injected `runTurn` is always the Claude harness turn regardless of the resolved harness.

So the R39 cross-harness routing — the whole point of the council, running the cheap light-tier volume on the Codex seat at $0 while the heavy review sessions stay on Claude — is unreachable in the app, and the provenance that is supposed to make model selection honest instead misreports it.

## What Changes

- Add `createCodexRunTurn` to `@rennet/core`: a pure adapter over the `CodexUtilityPort` **interface** (this package) that turns a resolved Codex seat into the injected `runTurn` used by `runDecompositionAngle`/`runOrderingPass` — mirroring `createHarnessRunTurn` for the Claude seat. It runs **one** `port.complete({ maxRetries: 0 })` per turn so the runner's shared budget and retry loop stay the single authority, and maps the port result: an admitted document → an emitted body; a rejection or exec failure → a turn failure so the deterministic floor stands. Depends only on the port **interface**, never on `@rennet/adapters`, so `core` stays node-free.
- Thread a **council context** and an injected `CodexUtilityPort` through `buildReviewCanvases`. Per model-facing seat (`decomposition-proposal`, `comprehension-ordering`) the pipeline resolves `{ harness, model, effort, trace }`, stamps **all four** into that seat's provenance seed (fixing the `harness`/`model` contradiction — harness now follows the resolved model), and selects the executor by the resolved harness: a `claude-code` seat runs the injected Claude turn, a `codex` seat runs the injected port via `createCodexRunTurn`. The model phase runs whenever the decomposition seat has an executor (so a Codex-resolved seat runs, not just a Claude one). Absent a council context, prior behaviour is unchanged.
- Keep the shared **invocation budget** the single money gate across whatever mix of seats runs: it is created once per review and threaded into both runners unchanged, so a turn over the ceiling — on the Claude seat OR the Codex seat, first attempt or retry — is refused at runtime, and a refusal falls to the deterministic floor (R10).
- Add `discoverCodexAvailability` to `@rennet/adapters`: a probe next to the `codex exec` executor that runs `codex --version` through an injected run seam and returns `{ available, version }`, so the composition root can determine `codex` availability honestly and testably (mirroring how the Claude harness discovery gates `claude-code`).
- Wire the composition root (`apps/desktop/src/main/index.ts`): memoize the real `CodexUtilityPort` (`createCodexUtilityAdapter`) and the codex-availability probe alongside the Claude harness, compute `availability.installed` from which harnesses are actually installed (`claude-code` ⟺ a discovered Claude adapter; `codex` ⟺ the probe), and pass `council: { availability }` plus the port into `buildReviewCanvases`. The invariant the root enforces — `codex` in `installed` ⟺ the port is provided — is what makes a Codex resolution always executable on the live path.
- Model calls stay **mocked in CI**: both the Claude turn and the Codex port are faked in every pipeline test; no test spawns a real `claude` or `codex` or spends metered tokens.

## Capabilities

### New Capabilities

- `model-council-live`: the Model Council resolver drives the live review pipeline — each model-facing seat is resolved to a mind, executed on the resolved harness (Claude turn or Codex port), stamped with honest provenance (model, effort, harness, and trace all agree), and gated by one shared invocation budget across every seat.

## Impact

- Adds `packages/core/src/codex-run-turn.ts`; extends `packages/core/src/pipeline.ts` (per-seat resolve + executor selection + honest harness stamping) and re-exports the new module from `packages/core/src/index.ts`. Adds `discoverCodexAvailability` to `packages/adapters/src/codex-exec.ts`. Extends `apps/desktop/src/main/index.ts` (composition root: memoized port + availability, council context).
- No new package, no new runtime dependency, no dependency-arrow change. `createCodexRunTurn` depends only on the `CodexUtilityPort` interface in `@rennet/core`, never on `@rennet/adapters`, so `core` does not import `adapters`. The architecture and licenses gates are untouched.
- The pre-existing acceptance-3 pipeline test (council resolves the two seats to different harnesses) is updated to provide the now-required fake Codex port, so the Codex-resolved seat actually executes via the port and the test asserts honest per-seat harness — strengthening, not weakening, its intent.
- Deferred (documented, not regressions): the seat provenance still carries placeholder `harnessVersion`/`adapterVersion`/`capability` from the pipeline seed (the Claude live path already does — enriching these per-seat from discovery is a follow-up); and the Codex port's own `maxRetries` report-feedback across retries is not chained through the runner (the runner owns retries so the shared budget counts them).
