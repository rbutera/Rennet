# Design — add-server-package (#377)

## Context

Recon facts this design stands on (verified against `main`, pre-phase-1):

- `apps/desktop/src/main/` = 61 files, 17,421 lines. Only 3 modules touch Electron: `index.ts` (full API), `auto-update.ts` (`autoUpdater`), `menu.ts` (type-only `MenuItemConstructorOptions`).
- `dispatch.ts:497` exports the sole factory `createDispatch(deps: DispatchDeps)`; `DispatchContext` (`{emitProgress?, progressRecipientId?, emitAskStream?}`, dispatch.ts:463) is already the transport-agnostic push seam.
- `index.ts` concerns: module-level singletons at 210–643 (capture adapter, watcher, harness memoizers, GitHub token/publish wiring); `registerCommandHandler` at 1639 (wires `ipcMain.handle("rennet:invoke")` → builds emitProgress/emitAskStream over `event.sender.send` → calls `dispatch`); `whenReady` composition at 1768–2345 (stores, ~40 DispatchDeps suppliers); `before-quit` at 2348–2359 (`liveTurns.abortAll()` → `watcher.close()` → `rehydration?.closeAll()` → `store?.close()`).
- Electron leaks inside DispatchDeps suppliers — exactly four: `app.getPath("userData")` feeding `SqliteReviewStore`/`FileProjectStore` (index 1781–1782), `readUiEvidence`'s dir (index 2090), the `dialog.showOpenDialog` fallback inside `chooseRepository` (index 629, bypassed by `RENNET_TEST_REPO`), and the rehydration `narrate` broadcast (index 1798–1806). `app.getPath` also at 1413 (needs case-by-case look; likely logs/evidence path).
- Env reads in composition: `PATH` fix (221), `RENNET_USER_DATA` (269), `RENNET_CODEX_BIN` (388), `RENNET_OMP_BIN` (475), `RENNET_TEST_REPO` (630), `env: process.env` to the orchestrator runner.
- Architecture gate is TWO enforcers: `scripts/check-boundaries.mjs` (hard-coded allowed map over `packages/*` package.json deps, with an eslint positive control) and `@nx/enforce-module-boundaries` depConstraints keyed on `layer:*` tags. `apps/desktop` is `layer:app` (allowed to import everything).
- e2e drives the real Electron binary via Playwright `_electron.launch` with `RENNET_TEST_REPO` + `RENNET_USER_DATA` env (apps/desktop/e2e/harness.ts:118–130). It is the behavior-identity oracle for this phase.

## Goals / Non-Goals

**Goals:**

- One composition factory, `createRennetServer(options)`, owning everything Electron does not have to own. Kill module-level singletons: two servers in one process (tests) must not share state.
- Electron main becomes a shell that could be deleted and rewritten against the server handle (that is phase 2's browser/WS story).
- Byte-for-byte persistence continuity: same SQLite file, same config, same threads.

**Non-Goals:**

- No transport. The handle is called in-process. No serialization at this seam (phase 2 serializes).
- No API redesign of dispatch. `server.dispatch` IS `createDispatch`'s return, same signature.
- No move of `menu.ts`, `auto-update.ts`, `open-in-editor`'s Electron effects, `window-identity.ts`, preload, renderer, forge/vite configs.
- No new features, flags, or config surface beyond what composition already reads.

## Decisions

**D1 — `createRennetServer(options)` returns `{ dispatch, shutdown }` and nothing more.** `dispatch` is the function `createDispatch` already returns (name, rawInput, ctx?) — the push seam stays `DispatchContext`, so Electron's invoke handler keeps building emitProgress/emitAskStream closures exactly as today. No event-emitter abstraction is added; phase 2 adds transport on top of this same seam. *Alternative considered:* a richer handle with `onProgress`/`onAskStream` subscription methods (the phase-0 session frames) — rejected for this phase; nothing consumes it yet (YAGNI), and the wave plan puts serialization at phase 2.

**D2 — Options carry the four Electron leaks, everything else is internal.**
```ts
interface RennetServerOptions {
  dataDir: string;                       // was app.getPath("userData")
  env?: NodeJS.ProcessEnv;               // default process.env (RENNET_CODEX_BIN etc.)
  chooseRepositoryFallback?: () => Promise<string | null>; // was dialog.showOpenDialog; RENNET_TEST_REPO short-circuit moves INTO the server
  broadcastProgress?: (commandId: string, event: ProjectProcessEvent) => void; // was BrowserWindow.getAllWindows broadcast (rehydration narrate)
}
```
Electron main supplies all four from its own APIs. Tests supply stubs. Nothing else crosses.

**D3 — Modules move verbatim; only `index.ts` is dismantled.** The ~26 Electron-free modules and their tests move to `packages/server/src/` with import paths updated and zero body edits (mechanical `git mv`-style relocation, reviewable as renames). The composition code in `index.ts` (singletons 210–643 + whenReady 1768–2345 + the pure helpers 282–1637 they call) moves into `packages/server/src/` composition modules (`create-server.ts` + whatever file split keeps it readable — prefer preserving current function boundaries so diffs stay recognizable). `registerCommandHandler`/`registerMenuHandler`/`registerAppProtocol`/`createWindow`/before-quit stay in the shrunken `index.ts`.

**D4 — Singletons become instance state.** Every module-level `const`/`let` in index.ts's 210–643 range (watcher, capture, harness memo Maps, token resolvers, `liveTurns`, mutable `store`/`dispatch` bindings) becomes local to `createRennetServer`. The factory may be called more than once per process (tests); nothing static leaks between instances.

**D5 — `shutdown()` encodes today's before-quit order:** `liveTurns.abortAll()` → `watcher.close()` → `rehydration?.closeAll()` → `store?.close()`. Electron's `before-quit` calls `server.shutdown()`. Idempotent (second call is a no-op) because Electron can fire quit paths twice.

**D6 — Architecture edges: new tag `layer:server`.** check-boundaries.mjs allowed-map gains `@rennet/server → {types, protocol, instructions, core, adapters}`; eslint depConstraints gain `layer:server → [types, protocol, instructions, core, adapter, server]` and `layer:app` gains `layer:server`. `packages/server` project.json tags `["scope:rennet", "layer:server"]`. The existing positive control (ui importing core) still proves the eslint rule fires; no new control needed.

**D7 — `proactive-rehydration.ts` moves too.** It is Electron-free (imports only node:path, adapters, protocol types); its `narrate` callback is supplied by the server from `options.broadcastProgress` under `PROACTIVE_REHYDRATION_COMMAND_ID`, preserving today's broadcast-to-all-windows behavior via Electron's injected implementation.

**D8 — The e2e suite is the acceptance gate and must not change.** `add-project`, `local-review`, `review-canvases` drive the real app through the same env vars (`RENNET_TEST_REPO` handling moves into the server per D2 but reads the same variable from `options.env`). If any e2e spec needs editing to pass, the phase is not behavior-identical — stop and report, don't adapt the test.

## Risks / Trade-offs

- **Risk: the 2,100-line composition body hides an implicit ordering dependency** (e.g. `app.setPath("userData")` at line 269 must precede store construction). Mitigation: `RENNET_USER_DATA` handling stays in Electron main (it is Electron path plumbing); the server takes the RESOLVED `dataDir`. Order inside the factory preserves today's whenReady order.
- **Risk: pnpm/Nx module graph churn** (new package, ~30 file moves) makes the diff look bigger than it is. Mitigation: two commits — (1) scaffold + verbatim moves, (2) composition extraction — so review can diff the moves as renames.
- **Trade-off: `index.ts:1413`'s `app.getPath` use is not yet classified** (recon flagged 4 sites, one unmapped). Implementer must read it and either route it through `dataDir` or leave it in the shell with a stated reason.
