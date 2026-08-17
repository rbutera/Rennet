# Extract packages/server: the composition root leaves Electron (#377)

## Why

The app server wave (#376–#383) makes Rennet's runtime a daemon that desktop, browser, CLI, and mobile clients all speak to. Phase 0 (#376, merged) gave the protocol a session layer. This phase relocates the brain: today the entire composition root lives in `apps/desktop/src/main/index.ts` (2,359 lines) inside Electron, even though recon shows only **three** of the 29 main-process source modules touch Electron at all — `index.ts` itself, `auto-update.ts` (`autoUpdater`), and `menu.ts` (a type-only import). Everything else — `dispatch.ts` (1,742 lines, 49-command router, "extracted from the electron main so it can be unit-tested without an Electron runtime"), the `*-live.ts` turn runners, the orchestrator, the pipeline modules — is already Electron-free and unit-tested off-Electron.

This is codex-app-server's `in_process.rs` move: the same runtime behind an in-process transport now, socket transports later (phase 2) — one contract, no process-boundary tax on day one. The app must behave identically after this phase; the only thing that changes is where the code lives and how it is constructed.

## What Changes

A new `packages/server` owns composition and command routing. Electron main shrinks to a shell: create the server in-process, forward `rennet:invoke` to it, keep window/menu/auto-update/protocol registration.

- **`packages/server` scaffolded** (Nx library conventions matching `packages/adapters`: `@rennet/server`, tag `layer:server`), with the new import edges declared in BOTH architecture enforcers (`scripts/check-boundaries.mjs` allowed-map and the `@nx/enforce-module-boundaries` depConstraints in `eslint.config.mjs`): server → {types, protocol, instructions, core, adapters}.
- **Moves, verbatim where possible**: `dispatch.ts` + its 3,854-line test, `live-turn-registry.ts`, `orchestrator.ts`, `publish-consent-authority.ts`, `review-intelligence-session.ts`, `settings.ts`, `live-review-backend.ts`, the `*-live.ts` runners (review-ask, refine-comment, draft-pr-body, handoff-compose, delta-digest, symbol-lookup), `process-project.ts`, `review-pipeline-input.ts`, `review-context-feed.ts`, `ci-signal.ts`, the `flagged-*` modules, `review-ownership.ts`, `proactive-rehydration.ts` — all Electron-free today, each with its tests.
- **`createRennetServer(options)`**: a factory in `packages/server` that performs the composition `index.ts`'s module-level singletons and `whenReady` body do today (stores, adapters, harness memoization, dispatch construction, LiveTurnRegistry, rehydration), returning a handle: `{ dispatch, shutdown }` where `dispatch(name, input, ctx)` is the existing dispatch signature (`DispatchContext` already carries `emitProgress`/`emitAskStream` — the push seam is unchanged). Module-level singletons become instance state of the factory.
- **Electron-owned effects become injected options**: `chooseRepositoryDialog` (the `dialog.showOpenDialog` fallback), `readUiEvidenceDir`/`dataDir` (today `app.getPath("userData")`), and the rehydration `narrate` broadcast (today `BrowserWindow.getAllWindows()` + `webContents.send`). The server resolves paths from a `dataDir` option; Electron passes its `userData` path explicitly, so `rennet.sqlite`, config, threads, and project stores carry over byte-for-byte.
- **Electron main keeps**: `createWindow`, app protocol registration, menu (`menu.ts`), `auto-update.ts`, `open-in-editor` invocation effects, preload/renderer, the IPC channel names, and `before-quit` — which now calls `server.shutdown()` (abort live turns, close watcher, close rehydration, close store) instead of touching internals.
- **IPC surface unchanged**: `ipcMain.handle("rennet:invoke")` still exists in Electron main; its body forwards to `server.dispatch` with the same emitProgress/emitAskStream closures over `event.sender.send`. Renderer and preload untouched.

**Explicitly out of scope**: any socket/WS transport (phase 2 #378); any daemon process (phase 3 #379); changing any command's behavior; renaming IPC channels; touching `packages/ui` or preload.

## Capabilities

### New Capabilities

- `server-package`: the `@rennet/server` package — `createRennetServer(options)` composition factory, the relocated dispatch/orchestration/persistence-wiring modules with their tests, injected Electron-owned effects, a `shutdown()` that quiesces live turns and closes stores, and the architecture-gate edges that admit the new package.

### Modified Capabilities

<!-- None. Behavior is identical; this is relocation + parameterization. -->

## Impact

- **`packages/server`** — new; receives ~26 modules + tests from `apps/desktop/src/main/`.
- **`apps/desktop/src/main/index.ts`** — shrinks to shell concerns; imports `createRennetServer` from `@rennet/server`.
- **`apps/desktop` package.json / project.json** — dependency on `@rennet/server`.
- **`scripts/check-boundaries.mjs` + `eslint.config.mjs`** — new `layer:server` edges (also `layer:app` gains `layer:server`).
- **e2e** (`add-project`, `local-review`, `review-canvases`) — must pass UNTOUCHED; they drive the real Electron app and are the behavior-identity proof.
- **Docs same-change** — `developing/concepts/architecture-overview.md` (composition root now `packages/server`), `harness-adapters.md` if it names main-process homes; `app-server-plan.md` phase 1 row link if needed.
