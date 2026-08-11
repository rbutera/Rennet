## Why

The canvas UI (#11), the model pipeline (decomposition floor #7 → `runDecompositionAngle` #8 → ordering pass #9), the canvas placement engine (#10 `canvas.ts`), and the Claude harness composition root are all merged and tested — **but nothing introduces them to each other.** Two concrete gaps on `main`:

1. `apps/desktop/src/main/index.ts` `dispatch()` handles only the MVP loop and has **zero `canvas.*` cases** — the six canvas user commands are defined in `@rennet/protocol` but unrouted, so a renderer invoking them gets `undefined` (this is #49's IPC half).
2. `runDecompositionAngle` (#8) has **no caller outside its own module** — the capture→decompose→angles→ordering→placement chain is dead on the live path. The harness root in desktop main is present and memoized but never consulted.

So the #11 canvases render **fixtures**, not because the engine is missing anything, but because nothing produces real canvas state. This slice makes the pipeline real end to end: point Rennet at a real working-tree changeset and get **populated canvases** derived from that diff.

## What Changes

- Add `buildReviewCanvases` to `@rennet/core`: the live pipeline as one pure orchestration — `decompose` (#7) → **Brita budget gate** (`buildRoutePlan`, #8) → `runDecompositionAngle` (#8) → `runOrderingPass` (#9) → `buildCanvas` (#10) for each of the five angles. The Brita filter is wired **before any model runs**: a route plan over the `<5`-invocation ceiling refuses and the pipeline stands on the deterministic floor (real substrate + deterministic sequence, no spend). The decomposition angle is driven by an **injected** `runTurn` (mocked in CI, harness-backed in the app), so `runDecompositionAngle` gets its first real caller.
- Add `createHarnessRunTurn` to `@rennet/core`: a pure adapter over the `HarnessPort` interface that turns a harness session into the injected `runTurn` — creates a read-only session with the docType's output schema, drives one turn,

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. The session is not read-only; it carries the user's own harness capabilities. and maps the `session.ended` outcome's `structuredOutput` into an emitted body (or a turn failure). Node-free; drives the user's own installed `claude` (R2, subscription OAuth, no metered spend) when composed by desktop.
- Add `createDispatch` to `@rennet/core`: the electron-free command router, extracted from desktop `dispatch()` and given injected effects. It routes the existing six MVP commands **unchanged** plus the **six `canvas.*` user commands** (`canvas.disposition` maps onto the real `ReviewService.setDisposition`; the L3 ops acknowledge) and the new `review.canvases` command. `apps/desktop/src/main/index.ts` becomes the electron composition root that wires the dialog, the repo watcher, and the harness-backed `buildCanvases` into `createDispatch` — no business logic in the electron file.
- Add the `review.canvases` command + a `Canvas` output schema to `@rennet/protocol`: `{ commandId, reviewId, repoPath }` → `{ canvases }` (the five-angle canvas set), the IPC surface the renderer reads to get real canvas state.
- Wire `RennetApp` (`@rennet/ui`) to fetch real canvases via `review.canvases` when a real review exists, rendering them in the Canvases view; the clickable `demoCanvases()` fixtures remain the fallback when there is no review or the fetch fails, so the demo never regresses.
- Add a **gated manual** real-turn proof in `@rennet/adapters` (skipped unless `RENNET_LIVE_HARNESS` is set): composes the real Claude harness and drives one `createHarnessRunTurn` turn on the user's subscription (non-metered, never in the normal gate).

## Capabilities

### New Capabilities

- `live-review-pipeline`: capture a real changeset → decomposition → budget-gated agentic angle → ordering → populated five-angle canvas set, delivered over IPC to the canvas UI; the Brita budget filter enforced end to end before any model call; the six canvas user commands routed through desktop dispatch.

## Impact

- Adds `packages/core/src/pipeline.ts` and `packages/core/src/harness-run-turn.ts` and `packages/core/src/dispatcher.ts`; extends `packages/core/src/index.ts`. Adds `review.canvases` + a canvas output schema to `packages/protocol/src/index.ts`. Extracts `apps/desktop/src/main/dispatch.ts` (electron-free) and thins `apps/desktop/src/main/index.ts`. Extends `packages/ui/src/app.tsx`. Adds one gated adapters test.
- No new package, no new runtime dependency, no dependency-arrow change. `createHarnessRunTurn` depends only on the `HarnessPort` **interface** (`@rennet/core`), never on `@rennet/adapters`, so `core` does not import `adapters`. The architecture and licenses gates are untouched.
- `layer:ui` stays clean: the UI reads canvases over the `@rennet/protocol` bridge and never runs the projector.
- Absorbs #49 items 1–2 (dispatch wiring + command-shape alignment; the protocol already uses `path`/`disposition` so no rename is needed). #49 item 3 (canvasOps@2 registry-subset assertion) stays deferred to #13. The L3 canvas-op persistence store (adjudicate/pin/clear/cohort/select durability) is a follow-up (#13); those ops acknowledge but do not yet persist.
