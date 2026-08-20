## 1. Distro paths and bundle delivery (pure + effectful)

- [x] 1.1 In `core`, add pure helpers: `wslServerBundlePath(version)` → `~/.rennet/server/<version>/rennet.cjs` (distro-native) and `wslDaemonDataDir()` → the distro-native data dir, alongside `wsl-node.ts`. Unit-test them.
- [x] 1.2 Add a delivery step (desktop/server side) that ensures the versioned bundle exists in the distro: check via `wsl.exe … -e test -f <path>`; when absent, `cp` the host bundle (translate the host path with `wslpath`) into the versioned dir. Skip when present. Inject the runner so it is testable.
- [x] 1.3 Test: delivery copies once when absent and is a no-op when the versioned path exists (fake runner asserts the command sequence).

## 2. WSL spawn + port-first health

- [x] 2.1 Add a WSL spawn path (`packages/server/src/wsl-daemon.ts`) that spawns `buildWslDaemonLaunch(...)` detached and `unref`'d, with stdio the daemon owns (daemon writes its own `daemon.log` in the distro data dir — the host opens no Windows-side log fd).
- [x] 2.2 Learn the port once (single `wsl.exe … -e cat <dataDir>/daemon.json` after spawn), then health-check `http://localhost:<port>/healthz`; treat an identity-matching 200 as healthy.
- [x] 2.3 Stop a WSL daemon by signalling its pid inside the distro (`wsl.exe … -e kill <pid>`). (Version-skew stop-then-respawn is composed in Wave 3's supervisor from this stop + the identity `probe`/`waitFor` return.)
- [x] 2.4 Tests: healthy-spawn resolves a port; stop-by-pid emits the right `kill`; port read returns null on missing/garbage JSON; health maps 200→identity / non-200→null; wait gives up at the deadline. (Version-skew respawn + no-Node-does-not-hang are exercised at the Wave 3 supervisor seam.)

## 3. Locus routing in the supervisor

- [x] 3.1 In `apps/desktop/src/main/daemon-supervisor.ts`, select the launch by project locus: host-locus keeps today's `execPath=process.execPath` path; wsl-locus resolves Node (`resolveWslNode`), delivers the bundle (task 1), and uses the WSL spawn/health path (task 2).
- [x] 3.2 Keep a `locus → daemon handle (port)` map; lazily spawn a distro's daemon on the first project for that distro; route the renderer's bridge to the correct port.
- [x] 3.3 Translate repo paths crossing the boundary with `toDistroPath` (spawn/cwd) and `toWindowsView` (any host-side read); a host-locus project's path handling is unchanged.
- [x] 3.4 Tests: a wsl-locus project routes to the distro daemon's port; a host-locus project is byte-identical to before (regression guard).

## 4. Distro-native secret store

- [x] 4.1 Point a WSL daemon's `createGitHubTokenStore(...)` at its distro-native data dir so the GitHub credential is stored inside the distro; the host daemon's store is unaffected.
- [x] 4.2 Test: a WSL daemon's credential path is under the distro data dir (not the host dir, not a 9P path).

## 5. Gate

- [ ] 5.1 Full `ASDF_NODEJS_VERSION=24.16.0 pnpm check` green (format, architecture, licenses, lint, typecheck, test, build). Host-locus behavior regression tests pass unchanged.

## 6. Field proof (lancelot, manual — deferred)

- [ ] 6.1 On lancelot: open a WSL-locus project; confirm the daemon runs inside the distro (native watcher, 0 EISDIR in `daemon.log`), GitHub egress works from the distro, and the shell routes to the distro daemon's port. Confirm a host-locus project is unaffected. Record the result before archiving.
