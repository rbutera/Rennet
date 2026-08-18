# Design — add-detached-daemon (#379)

## Context

Recon facts (verified on main post-phase-1; phase 2 adds the WS listener — re-verify seams in the current tree):

- `createRennetServer(options)` is async post-phase-2, resolves after `listening`, handle `{dispatch, shutdown, wsPort}`; `startWsListener` exported. Options: `dataDir` (required), `env?`, `chooseRepositoryFallback?`, `openPath?`, `httpFetch?`, `serverVersion?` (broadcastProgress was absorbed by WS fan-out in phase 2).
- **Data is split across two roots**: `dataDir` (= `app.getPath("userData")`, overridable via `RENNET_USER_DATA`): `rennet.sqlite`, `projects.json`, `ui-evidence/`. `~/.rennet` (homedir, NOT dataDir): `threads/`, `config.json`, `projects/<repoKey>/` snapshots. e2e isolates both (RENNET_USER_DATA + HOME override). The pidfile goes under `dataDir` so existing isolation covers it. No consolidation this phase (scope).
- Crash recovery is LAZY, not boot-time: `FileThreadStore.loadThreads` folds `streaming` → `interrupted` on every read (`packages/adapters/src/file-thread-store.ts:57-69,112-114`). A daemon crash needs no startup reconcile pass; reattach reads recovered state. Daemon start need do nothing extra.
- Packaging: `forge.config.cjs` — `asar: true`, no `asarUnpack`; `packageAfterExtract` hook flips fuses, **`RunAsNode` currently OFF**; `HARNESS_SDK_FILE_EXCLUSIONS` strip rule exists (dormant). Main is a vite lib build (`vite.main.config.ts`, external = electron + builtins only, everything else inlined) verified by `scripts/verify-desktop-main-chunks.mjs`. `dev` target = full build + `electron .` (no HMR).
- No CLI/bin/arg-parsing precedent in the workspace; `node:util` `parseArgs` is stdlib. `execa` lives in adapters only; desktop/main uses `node:child_process`.
- No logging-to-file convention exists anywhere.
- Auto-update: `update-electron-app`, packaged-only, updates the whole asar — the daemon bundle updates with the app; no separate channel.
- e2e boots the real app via `_electron.launch` with `RENNET_TEST_REPO`, `RENNET_USER_DATA`, HOME override.

## Goals / Non-Goals

**Goals:**

- App quit stops nothing. Daemon lifetime is explicit (`rennet stop`, machine shutdown, skew-restart) — never implicit.
- Two cooperating launchers (app, CLI), one supervision primitive (pidfile + health probe). No handover protocol.
- The CLI is a real client over the same wire (WsRennetBridge in Node — global WebSocket exists in Node ≥22).

**Non-Goals:**

- No socket-handover/endpoint-racing protocol (Orca's 23-defect lesson; we don't have their problem).
- No daemon self-updater; the app updates the bundle, skew-restart applies it.
- No data-root consolidation (`~/.rennet` vs dataDir split stays; noted for a later cleanup).
- No new logging framework — one `createWriteStream` append to `daemon.log`, that's it.
- No remote bind, no auth (phase 4).

## Decisions

**D1 — `daemon.json` is the single discovery artifact.** Written atomically (temp+rename, the FileThreadStore pattern) to `<dataDir>/daemon.json` after `listening`: `{pid, wsPort, protocolVersion, version, startedAt}`. Removed on clean shutdown. A reader treats it as a CLAIM to verify (probe), never truth: stale file (dead pid or failed/incompatible probe) is overwritten by the next spawn. Zod schema for it lives in `packages/server` (it never crosses to browsers; not protocol surface).

**D2 — `/healthz` on the existing listener's http server**, returning the same identity JSON. Probe = HTTP GET with short timeout (~500ms), no WS session needed. Health probe asks "is the thing at this port a Rennet daemon I can speak to" — port + pid + protocolVersion answer it.

**D3 — Probe-then-spawn supervision (both launchers, same helper in `packages/server`):**
1. Read `daemon.json`; missing → spawn.
2. Probe `/healthz`; dead/timeout → spawn (overwrite).
3. Compatible (`checkProtocolCompatibility` on the probe's protocolVersion) → connect.
4. Incompatible → the SHELL restarts the daemon: SIGTERM old pid, wait for exit (bounded), spawn new. No dialog (Rule Zero; a personal product updates the daemon with the app). The CLI never auto-restarts on skew — it reports (`rennet status` prints the mismatch); restart policy belongs to the app that owns the newer bundle.
The window between probe and connect can race a dying daemon; the connect failure falls back to spawn once. No lock files, no leader election — two cooperating launchers converging on one healthy daemon is enough.

**D4 — Spawn mechanics.** Desktop shell spawns `process.execPath` (Electron binary) with `ELECTRON_RUN_AS_NODE=1`, args `[serverBundlePath]`, `detached: true`, `stdio: ["ignore", logFd, logFd]`, `unref()`. Requires in `forge.config.cjs`: `RunAsNode` fuse → enabled (the daemon IS the product's capability — flipping this fuse back is the cost of the feature, not a hardening regression), and `asarUnpack: ["dist/server/**"]` so plain Node loads the bundle from a real path (`app.getAppPath()` + `.unpacked` resolution). Dev (unpackaged): same spawn, fuses don't apply. The CLI (`rennet serve`) runs the same entry in FOREGROUND on system Node — it's a dev/power tool; the packaged app never depends on system Node.

**D5 — Server bundle = 4th vite lib build in apps/desktop** (`vite.server.config.ts`: entry `@rennet/server` daemon entry, out `dist/server/index.cjs`, external electron+builtins, chunks `.cjs`, the same `import.meta.url` define as main). Extend `verify-desktop-main-chunks.mjs` to cover `dist/server`. The dormant `HARNESS_SDK_FILE_EXCLUSIONS` rule stays (SDK vendor executables must never ship).

**D6 — Shell becomes supervisor + client; `before-quit` narrows.** The shell deletes its `createRennetServer` call; a new `daemon-supervisor.ts` (in apps/desktop main) does D3 and hands `wsPort` to the preload exactly as phase 2 does. `before-quit` keeps ONLY window/app concerns (no shutdown call — that's the feature). The old shutdown path survives inside the daemon entry (signals). Menu, auto-update, protocol registration unchanged.

**D7 — The dialog seam: `repository.choose` gains optional `path` (append-only).** Preload gains `chooseDirectory(): Promise<string | null>` (dialog via a main IPC channel, Electron-native residue like menu). The renderer's bridge composition wraps `invoke`: `repository.choose` with no path → call `chooseDirectory()` → forward `{path}` to the daemon (grant/allowedRoots flow unchanged, dispatch untouched except reading the new optional input). Headless/CLI/browser clients pass `path` explicitly or rely on `RENNET_TEST_REPO`. `packages/ui` untouched.

**D8 — CLI: `packages/server/bin` (`rennet`), stdlib `parseArgs`, three subcommands.**
- `serve`: foreground daemon (same entry), honors `--data-dir` / `RENNET_USER_DATA`.
- `status`: read `daemon.json` → probe → print `running (pid …, port …, v…)` / `stale pidfile (pid … dead)` / `not running`. Exit 0/1 honestly.
- `stop`: SIGTERM the pid, wait bounded for `daemon.json` removal, report. No prompts.
Registered as `"bin"` in packages/server/package.json; runnable via `pnpm rennet …` from the repo. No commander/yargs (Dependency Standard: stdlib covers it).

**D9 — e2e teardown is a harness change, justified and minimal.** The lifecycle change is the feature, so the harness (not the specs) gains: after each app close, `rennet stop`-equivalent against the test's isolated dataDir (read daemon.json, SIGTERM, bounded wait). Spec files untouched; the #386 baseline still applies. `package-smoke` extends to assert the packaged app spawns a healthy daemon (bundled-daemon proof).

**D10 — Version skew surfaces once, honestly.** After connect, the client already has `serverInfo`; the shell logs (not dialogs) a skew restart when it happens. `rennet status` prints both versions. Nothing else — feature flags carry future divergence per the protocol-compatibility page.

## Risks / Trade-offs

- **Risk: RunAsNode fuse re-enabled** widens what the packaged binary can be used for. Accepted deliberately: the daemon is the product; Rule Zero forbids trading the capability away for hardening. (The OnlyLoadAppFromAsar fuse and friends stay as-is.)
- **Risk: `ELECTRON_RUN_AS_NODE` + unpacked bundle path resolution differs packaged vs dev.** Mitigation: one `resolveServerBundle()` helper with both branches + the package-smoke assertion actually spawning it packaged.
- **Risk: orphaned daemons in dev/agent worktrees.** Each checkout's dataDir isolates its daemon; `rennet stop` and the e2e teardown are the reclaim paths. A daemon idles cheaply (watcher + sqlite handle); acceptable for a personal product.
- **Trade-off: `~/.rennet` stores are shared between daemon and any stray dev daemon** (pre-existing split). Unchanged this phase; noted in the docs page so nobody is surprised.
