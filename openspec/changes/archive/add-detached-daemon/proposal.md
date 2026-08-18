# Detached daemon: reviews survive app quit; rennet CLI (#379)

## Why

After phase 2, the runtime is one in-process server behind a real WS wire — but its lifetime is still the app's lifetime: quit the app mid-turn and `shutdown()` aborts the turn. The whole point of the daemon model is that the work outlives the window. This phase detaches the server into its own process: the desktop app becomes a supervisor + client, a `rennet` CLI becomes the second client (the cheapest proof the protocol is real — Paseo: "the CLI is just another client"), and quitting the app stops nothing.

## What Changes

- **Daemon entrypoint**: `packages/server` gains `src/daemon.ts` — resolve data dir → `createRennetServer` → write `<dataDir>/daemon.json` (`{pid, wsPort, protocolVersion, version, startedAt}`) → add `GET /healthz` to the phase-2 `node:http` server (returns the same identity) → on `SIGTERM`/`SIGINT`, `shutdown()` and remove `daemon.json`. Stdout/stderr to `<dataDir>/daemon.log` when detached.
- **Desktop app becomes supervisor + client**: on launch, read `daemon.json` → probe `/healthz` → if alive and protocol-compatible, use it; else spawn the daemon **detached** and wait for a healthy probe. The shell no longer calls `createRennetServer` in-process and `before-quit` no longer shuts the server down — app quit leaves the daemon (and any running turns) alive. On incompatible version skew the shell restarts the daemon (no dialog; in-flight turns from the old daemon fold to `interrupted` via the existing lazy recovery — a personal product updates the daemon with the app).
- **Supervision is pidfile + health probe, nothing fancier** (plan decision): Orca's socket-handover protocol cost them 23 documented defects because independent actors race for the endpoint; Rennet has two cooperating launchers (app, CLI). Probe-then-spawn; a stale `daemon.json` (dead pid / failed probe) is overwritten by the next launcher.
- **Spawn mechanics**: the daemon runs on the Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`, detached, stdio to the log file) so the packaged app needs no system Node. This requires flipping the `RunAsNode` fuse back on in `forge.config.cjs` (it currently disables it) and un-asaring the server bundle (`asarUnpack` for `dist/server/**`) so a plain Node process can load it. The server bundle is a 4th vite lib build in `apps/desktop` (same external-electron-and-builtins inlining as the main bundle, same `verify-desktop-main-chunks` guard).
- **The dialog residue**: a detached daemon cannot open a native directory picker. `repository.choose` gains an optional `path` input (append-only); the renderer composition wrapper intercepts `repository.choose`, obtains the path from a new preload `chooseDirectory()` (Electron-native residue, same family as menu/platform), and forwards it to the daemon so the grant/allowedRoots flow is unchanged. `packages/ui` untouched.
- **`rennet` CLI**: bin in `packages/server` (`node:util` `parseArgs` — no new dependency): `rennet serve` (foreground daemon), `rennet status` (read `daemon.json`, probe healthz, print version/port/pid or "not running"), `rennet stop` (SIGTERM the pid; daemon shuts down cleanly). No confirmation prompts anywhere — `rennet stop` just stops.
- **Isolation**: the pidfile/port file lives under the data dir, so `RENNET_USER_DATA` (already honored by the shell, now also by the daemon entry) isolates dev checkouts and e2e runs from the production daemon. Dev workflow: the `dev` target spawns the daemon with a per-checkout data dir, then the shell attaches; documented.
- **Docs same-change**: `architecture-overview.md` (daemon lifecycle diagram), `developing/guide/settings-and-setup.md` (daemon + CLI section), `using/concepts/product-and-vision.md` + `common-questions.md` ("no *hosted* backend" copy sharpening — the daemon is local; egress disclosure unchanged).

**Explicitly out of scope**: remote bind / pairing / device tokens (#380), any daemon self-updater (codex's hourly-updater complexity explicitly skipped), Linux packaging, serving the UI over HTTP (#381), multi-daemon orchestration.

## Capabilities

### New Capabilities

- `detached-daemon`: the daemon entrypoint with pidfile + healthz identity, detached spawn + probe-then-spawn supervision from the desktop shell, survive-app-quit turn lifetime, version-skew restart, per-data-dir isolation, and the `rennet` CLI (serve/status/stop) as the second client.

### Modified Capabilities

- `ws-transport`: the listener's http server gains `GET /healthz`; the server handle's identity (version/protocolVersion) is exposed there for probing.
- `server-package`: `createRennetServer` callers change — the desktop shell no longer embeds the server; the daemon entry does.

## Impact

- **`packages/server`** — `daemon.ts` (entry + pidfile + signals + log), `healthz` on the listener, CLI bin, tests (pidfile lifecycle, stale-pid takeover, healthz shape, CLI status/stop against a spawned daemon).
- **`apps/desktop`** — supervisor module in main (probe/spawn/skew-restart), 4th vite build for the server bundle, forge fuse + asarUnpack changes, preload gains `chooseDirectory`, renderer composition intercepts `repository.choose`, before-quit no longer touches the server.
- **`packages/protocol`** — `repository.choose` input gains optional `path` (append-only).
- **e2e** — the harness gains daemon teardown (kill the spawned daemon after each test's app closes; isolated by `RENNET_USER_DATA` + HOME override). This is a justified harness change (the lifecycle itself changed — the old "app quit kills everything" assumption is the thing this phase removes); the user-journey spec files stay untouched.
- **Acceptance ships**: quit the app mid-review-turn, reopen, the turn is still running and the UI reattaches; `rennet status` reports the daemon from a terminal; `pnpm check` green; e2e per #386 baseline.
