## Context

PR #437 (`packages/core/src/wsl-node.ts`) resolves a distro's Node and builds the `wsl.exe … -e <node> <bundle> serve --data-dir <dir>` descriptor; `locus.ts` provides byte-verbatim argv (`locusCommand`), path translation (`toDistroPath`/`toWindowsView`), and locus detection (`detectLocus`). The host daemon supervisor (`apps/desktop/src/main/daemon-supervisor.ts` + `packages/server/src/supervise.ts`) spawns ONE daemon for a data dir, health-checks it via the claim file + `/healthz`, restarts on version skew, and stops it by pid. The spike proved a WSL daemon binds a loopback port reachable from Windows over `localhost` (NAT mode, zero config), a macOS-built bundle runs unchanged on the distro's Node, and the native watcher has zero EISDIR.

The gap is the runtime: deliver the bundle into the distro, spawn/health/stop it over `wsl.exe`, run one per distro, and route by locus.

## Goals / Non-Goals

**Goals:**
- Run the daemon inside the distro for WSL-locus projects, deleting the 9P bug class in production.
- Reuse the existing supervisor shape and the #437 primitives; add a WSL variant, don't fork the world.
- Keep host-locus behavior byte-identical.

**Non-Goals:**
- Shipping our own Node into the distro (use the distro's; a no-Node distro surfaces plainly — a shipped-Node fallback is a later change).
- Multi-distro fan-out beyond "one daemon per distro actually in use".
- Any change to the review/publish pipeline, or any consent gate / read-only posture (Rule Zero).
- The token-refresh work (separate change `github-token-refresh-reliability`).

## Decisions

**1. Delivery is copy-once-per-version into the distro's native fs.** Path: `~/.rennet/server/<version>/rennet.cjs`, resolved distro-native. Copy via `wsl.exe … -e cp <wslpath-of-host-bundle> <target>` (or a stream) exactly once when the versioned path is absent; a version bump lands in a new dir so old daemons keep their bundle. Rationale: mirrors `~/.vscode-server`; running from native fs is the whole point (running the bundle over 9P would reintroduce the tax). Alternative (run the bundle from its `\\wsl.localhost` path) rejected — it defeats the architecture.

**2. Health is port-first, not claim-file-first.** The host supervisor reads `daemon.json` from the data dir; for a WSL daemon that dir is distro-native and reading it from Windows means 9P. Instead the shell learns the port once (from the spawn's first `daemon.json` read, or a one-shot `wsl.exe cat`) and thereafter health-checks `http://localhost:<port>/healthz`. Rationale: the port path is 9P-free and is exactly what the spike used. The claim file remains the daemon's own liveness record inside the distro.

**3. Reuse `ensureDaemon`'s shape with a locus-selected launch.** Factor the spawn descriptor behind the existing injectable `spawn`/`execPath`/`entryPath` seam: a host launch stays `execPath=process.execPath`; a WSL launch becomes `execPath=wsl.exe`, args from `buildWslDaemonLaunch`, stdio the daemon owns (it writes its own `daemon.log` in the distro, so the host does not open a Windows-side log fd). Rationale: minimal new surface; the supervisor's verify/restart/stop logic is reused, only the launch and the health transport differ.

**4. One daemon per distro, routed by locus; the shell holds a map.** `detectLocus(projectPath)` already yields `{kind:"wsl",distro}`; the shell keeps a `locus → daemon handle (port)` map, lazily spawning a distro's daemon on the first project for it, and routes the renderer's bridge to the right port. Path args cross via `toDistroPath`. Rationale: the routing key already exists; lazy spawn avoids starting daemons for distros never used.

**5. The WSL secret store is the existing store pointed at the distro data dir.** `createGitHubTokenStore(distroDataDir)` unchanged — it just writes under the distro-native dir the WSL daemon owns. Rationale: no new store; egress + token both native is a free win.

## Risks / Trade-offs

- **A WSL distro with no Node** → surfaced plainly per the spec (not a hang); a shipped-Node fallback is deferred, not silently required.
- **`wsl.exe` process lifetime / distro auto-termination** → the detached daemon process keeps the distro instance alive while it runs; verify the daemon is `unref`'d and survives the spawning `wsl.exe` returning (the spike's detached run persisted).
- **Reading the port initially may still touch the claim file once** → a single `wsl.exe cat daemon.json` at spawn is acceptable (one small read, not a per-tick 9P poll); steady-state health is port-only.
- **Depends on #437** → this change rebases onto main once #437 merges; its tasks reference `wsl-node.ts` symbols that land with #437.

## Migration Plan

Ship behind locus detection: host projects are untouched; a WSL project transparently gets a distro daemon on next open. Rollback is reverting this change — host behavior is unchanged and the WSL daemon is additive. No data migration; a WSL daemon's data dir is created on first use.

## Open Questions

- Bundle delivery transport: `wsl.exe cp` from the translated host path vs streaming the bytes over stdin. Prefer `cp` from the `wslpath`-translated host bundle for simplicity; revisit if the host bundle path is not reachable from the distro.
- Where the host bundle lives for translation (packaged `.unpacked` path) — resolve with the existing `resolveServerBundle()` then `wslpath` it.
