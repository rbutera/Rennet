# Tasks — add-detached-daemon (#379)

## 1. Daemon entry + identity

- [x] 1.1 `packages/server/src/daemon.ts`: resolve dataDir (`--data-dir` arg > `RENNET_USER_DATA` > platform default matching Electron's userData path) → `await createRennetServer` → write `<dataDir>/daemon.json` atomically (`{pid, wsPort, protocolVersion, version, startedAt}`, Zod schema in server) → SIGTERM/SIGINT → `shutdown()` + remove daemon.json. When detached, stdout/stderr append to `<dataDir>/daemon.log` (one createWriteStream, no framework).
- [x] 1.2 `GET /healthz` on the phase-2 listener's http server returning the identity JSON.
- [x] 1.3 Tests: daemon.json write/remove lifecycle; healthz shape; stale-file overwrite (dead pid → next start rewrites).

## 2. Supervision helper (shared by shell + CLI)

- [x] 2.1 `packages/server/src/supervise.ts` per design D3: `findHealthyDaemon(dataDir)` (read → probe → compat check → verdict) and `spawnDaemon({dataDir, execPath, entryPath, env})` (detached, unref, log fd). Probe timeout ~500ms.
- [x] 2.2 Tests: probe against a live listener; dead-pid staleness; incompatible-protocol verdict (stub healthz).

## 3. Desktop shell: supervisor + client

- [x] 3.1 `apps/desktop/src/main/daemon-supervisor.ts`: D3 flow; on incompatible skew SIGTERM-wait-respawn (log, no dialog); hand the daemon's `wsPort` to the preload exactly as phase 2 did with the in-process port.
- [x] 3.2 Delete the shell's `createRennetServer` usage; `before-quit` no longer calls shutdown (app quit leaves the daemon running — the feature).
- [x] 3.3 `resolveServerBundle()`: packaged (asarUnpack path) vs dev (`dist/server/index.cjs`) branches.
- [x] 3.4 Preload: add `chooseDirectory()` (main IPC → `dialog.showOpenDialog`, Electron-native residue). Renderer composition wraps `invoke` to satisfy `repository.choose` per design D7. `packages/ui` untouched.
- [x] 3.5 Protocol: `repository.choose` input gains optional `path` (append-only; tolerant decoders make this safe); dispatch uses it when present, falls back to `chooseRepositoryFallback` otherwise.

## 4. Packaging + dev

- [x] 4.1 `vite.server.config.ts` (4th lib build → `dist/server/index.cjs`), wired into the desktop build target; extend `verify-desktop-main-chunks.mjs` to `dist/server`.
- [x] 4.2 `forge.config.cjs`: enable `RunAsNode` fuse (design D4 — the daemon is the product's capability); `asarUnpack: ["dist/server/**"]`. HARNESS_SDK_FILE_EXCLUSIONS unchanged.
- [x] 4.3 `package-smoke` extended: packaged app spawns a healthy daemon (probe healthz from the smoke script).
- [x] 4.4 `dev` target documented: build → shell launch → shell spawns daemon from dist (same path as prod, minus fuses).

## 5. rennet CLI

- [x] 5.1 `packages/server` bin `rennet` (`node:util` parseArgs): `serve` (foreground daemon), `status` (read+probe+print, honest exit codes), `stop` (SIGTERM pid, bounded wait for daemon.json removal). No prompts.
- [x] 5.2 CLI test: spawn `serve` on an isolated dataDir → `status` reports running → invoke one command over WsRennetBridge (CLI-as-client proof) → `stop` → `status` reports not running.

## 6. e2e + proof

- [x] 6.1 Harness-only e2e change (design D9): after app close, stop the test's isolated daemon (read daemon.json under the test userData, SIGTERM, bounded wait). Spec files untouched.
- [x] 6.2 The acceptance journey as a test where feasible: start a long-running command, quit the app (close window/app), relaunch against the same dataDir, verify the daemon pid is unchanged and the client reattaches (this may live in the CLI/contract test layer rather than Playwright if the Playwright double-launch is flaky — state the call made).
- [x] 6.3 `NX_DAEMON=false pnpm check` green; e2e per #386 baseline (local-review preload assertion now expects the phase-2 keys).

## 7. Docs (same change)

- [x] 7.1 `architecture-overview.md`: daemon lifecycle mermaid (spawn/probe/skew/stop), shell = supervisor + client.
- [x] 7.2 `developing/guide/settings-and-setup.md`: daemon + CLI section (serve/status/stop, data dir isolation, daemon.log).
- [x] 7.3 `using/concepts/product-and-vision.md` + `common-questions.md`: "no *hosted* backend" copy sharpening — the daemon is local; harness/provider egress disclosure unchanged.
