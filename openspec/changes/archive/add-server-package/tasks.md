# Tasks — add-server-package (#377)

## 1. Scaffold + gate edges

- [x] 1.1 Scaffold `packages/server` matching `packages/adapters` conventions: package.json (`@rennet/server`, `"exports": "./src/index.ts"`, deps `@rennet/{types,protocol,instructions,core,adapters} workspace:*` + whatever the moved modules need), project.json (tags `["scope:rennet","layer:server"]`, targets build/lint/typecheck/test like adapters), tsconfig extending base.
- [x] 1.2 Architecture edges in BOTH enforcers: `scripts/check-boundaries.mjs` allowed-map entry for `@rennet/server`; `eslint.config.mjs` depConstraints `layer:server → [types, protocol, instructions, core, adapter, server]` and add `layer:server` to `layer:app`'s allow list.

## 2. Verbatim moves (commit 1 — reviewable as renames)

- [x] 2.1 Move from `apps/desktop/src/main/` to `packages/server/src/`, bodies unchanged, imports updated: `dispatch.ts` (+ dispatch.test.ts), `live-turn-registry.ts`, `orchestrator.ts`, `publish-consent-authority.ts`, `review-intelligence-session.ts`, `settings.ts`, `live-review-backend.ts`, `review-ask-live.ts`, `refine-comment-live.ts`, `draft-pr-body-live.ts`, `handoff-compose-live.ts`, `delta-digest-live.ts`, `symbol-lookup-live.ts`, `process-project.ts`, `review-pipeline-input.ts`, `review-context-feed.ts`, `ci-signal.ts`, `flagged-late-enrichment.ts`, `flagged-ui-verification.ts`, `flagged-review-verification.ts`, `flagged-blocking-states.ts`, `review-ownership.ts`, `proactive-rehydration.ts` — each with its sibling `.test.ts`.
- [x] 2.2 `apps/desktop` keeps: `menu.ts`, `window-identity.ts`, `auto-update.ts`, `open-in-editor.ts` (see note), preload, renderer, forge/vite configs. Note: `open-in-editor.ts` recon says Electron-free and invoked from dispatch deps — if moving it drags no Electron import, move it; otherwise leave and inject. State the call made.
- [x] 2.3 Moved tests pass in the new package: `pnpm nx test rennet-server`.

## 3. Composition extraction (commit 2)

- [x] 3.1 `packages/server/src/create-server.ts`: `createRennetServer(options: RennetServerOptions): { dispatch, shutdown }` per design D1/D2. Move index.ts's module-level singletons (210–643) and the whenReady composition (1768–2345) plus the pure helpers they call (282–1637) into the server package, preserving construction order. All singletons become instance state (D4).
- [x] 3.2 The four Electron leaks route through options: `dataDir` (stores at index 1781–1782, ui-evidence at 2090; classify index:1413 and route or leave with stated reason), `chooseRepositoryFallback` (dialog at 629; `RENNET_TEST_REPO` short-circuit moves into the server reading `options.env`), `broadcastProgress` (rehydration narrate at 1798–1806), `env` (CODEX/OMP bin overrides, orchestrator env).
- [x] 3.3 `shutdown()` per D5 (today's before-quit order, idempotent).
- [x] 3.4 `apps/desktop/src/main/index.ts` shrinks to shell: `RENNET_USER_DATA`/`app.setPath` handling, `createRennetServer({dataDir: app.getPath("userData"), env: process.env, chooseRepositoryFallback: <dialog>, broadcastProgress: <getAllWindows broadcast>})`, `registerCommandHandler` forwarding to `server.dispatch` with the same emitProgress/emitAskStream closures, menu/protocol/window/auto-update registration, `before-quit` → `server.shutdown()`.
- [x] 3.5 Unit test in `packages/server`: two `createRennetServer` instances in one process do not share state (e.g. distinct allowedRoots/liveTurns) — pins D4. A `shutdown()` idempotence test.

## 4. Proof of behavior identity

- [x] 4.1 `NX_DAEMON=false pnpm check` green (exit 0 + "Successfully ran target").
- [~] 4.2 e2e UNTOUCHED (zero e2e edits); NOT fully green — the same 3 specs (local-review, review-canvases ×2) fail identically at commit 1 (pure moves = base behavior) and commit 2, and 1 (add-project) passes both. Pre-existing on base b4c2c75, not a phase-1 regression; per D8 the e2e files were not edited. See finding. Original text: `sh -c 'pnpm nx e2e rennet-desktop'` (or the repo's e2e target name — check `pnpm nx show project rennet-desktop`). If an e2e spec would need editing, STOP and report per design D8.

## 5. Docs (same change)

- [x] 5.1 `developing/concepts/architecture-overview.md`: composition root now `packages/server`; desktop is a shell + client.
- [x] 5.2 `developing/concepts/harness-adapters.md`: update any "main process" homes that moved.
- [x] 5.3 `developing/reference/app-server-plan.md`: phase 1 marked delivered wording only if the page tracks status (follow its existing style).
