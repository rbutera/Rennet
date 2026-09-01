## Why

The WSL-daemon spike proved the architecture end to end and PR #437 landed the load-bearing piece — resolving the distro's Node binary and building the byte-verbatim `wsl.exe … -e <node> <bundle> serve` launch descriptor. But that descriptor is not yet *invoked*: nothing delivers the daemon bundle into the distro, nothing manages its lifecycle over `wsl.exe`, and nothing routes a WSL-locus project to a distro-native daemon instead of the host daemon reaching across 9P. Until this lands, WSL projects still run on the Windows daemon over `\\wsl.localhost\…`, with the whole EISDIR/poll/threadpool-starvation/slow-git class the spike showed disappears when the daemon runs inside the distro. This change is the "Remaining" list in `developing/concepts/wsl-daemon.md`, made real.

## What Changes

- **Bundle delivery**: deliver the daemon bundle into the distro's native filesystem, copied once per version to `~/.rennet/server/<version>/rennet.cjs` and run from there — never executed back over the 9P view. A re-delivery is skipped when the versioned copy already exists.
- **Node resolution + launch**: use `resolveWslNode` (PR #437) to find the distro's Node, then spawn `buildWslDaemonLaunch(...)` detached; the daemon self-logs into its distro-native data dir.
- **Lifecycle over `wsl.exe`**: health is polled on the **port** (the daemon's `/healthz` reached over `localhost`), not by reading the claim file across 9P; a version-skew daemon is restarted; a daemon is stopped by pid inside the distro (`wsl.exe … -e kill`).
- **Per-distro routing**: the shell runs the host daemon plus **one daemon per WSL distro**, and routes each project to the daemon for its execution locus. Paths cross the boundary through `toDistroPath` / `toWindowsView` (already in `core`).
- **Distro-native secret store**: a WSL daemon's GitHub credential lives in its own distro-native data dir, so GitHub egress and the token both sit natively in the distro (no 9P, no cross-OS credential reach).

## Capabilities

### New Capabilities
- `wsl-daemon-runtime`: delivering, spawning, health-checking, and stopping a Rennet daemon inside a WSL distro, and routing WSL-locus projects to it — the production runtime for the daemon-in-distro model whose argv/path/Node primitives already exist in `core`.

### Modified Capabilities
<!-- None: no existing spec owns daemon spawn/lifecycle for WSL. The host daemon supervisor is code (apps/desktop) without a dedicated spec; this change adds the WSL runtime alongside it without changing host behavior. -->

## Impact

- `packages/core` — reuse `wsl-node.ts` (`resolveWslNode`, `buildWslDaemonLaunch`) and `locus.ts` (`locusCommand`, `toDistroPath`, `toWindowsView`, `detectLocus`) from PR #437; add small pure helpers as needed (distro data-dir path, versioned bundle path).
- `packages/server` — a WSL-aware spawn/health path: spawn the launch descriptor with stdio the daemon owns (it writes its own `daemon.log` in the distro), health via the port, stop by pid over `wsl.exe`.
- `apps/desktop/src/main/daemon-supervisor.ts` — select the launch by project locus, deliver the bundle once per version, keep and reach one daemon per distro, and route the renderer's bridge to the right daemon's port.
- A distro-native `SecretStore` data dir per WSL daemon (reusing the existing `createGitHubTokenStore`, pointed at the distro data dir).
- Depends on PR #437 being merged first. No change to host-locus behavior. No consent gates or read-only postures (Rule Zero) — the daemon must write and push exactly as the host daemon does.
