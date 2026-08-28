# Tasks — c17-host-tool-detection (C17, #485/#533/#534)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is
part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster;
one commit per checked task. Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless
stated; full gate `sh -c 'pnpm check'` at cluster 7.

**Reused surfaces (confirm on main at session start — do NOT re-implement):**
- `packages/adapters/src/harness-discovery.ts` — the per-host detection ENGINE model to mirror for the
  forge CLI (PATH harvest + curated dirs + `<path> --version` probe; never a shell `which`). `DiscoveryDeps`.
- `packages/server/src/dispatch/harness.ts` (`harness.detect` handler) + `runtime.ts` `detectHarnesses()`
  — the command-per-host detection pattern to mirror for `forge.detect`.
- `packages/server/src/supervise.ts` — `probeHealth` / `findHealthyDaemon` (return the daemon's `version`
  + protocol version), `spawnDaemon` / `waitForHealthy` — the reconnect + version primitives.
- `packages/server/src/settings.ts` — `daemonHosts` enumeration (the paired-host list to attach status to).
- `packages/adapters/src/github-forge.ts` `GitHubForgeAdapter` + `@rennet/core` `ForgePort` — the seam #484
  references (untouched here; detection is a sibling).
- `packages/app-ui/src/settings/data/projections.tsx` — `DetectedTool` / `ToolStatus` / `SettingsHost` /
  `DaemonInfo` shapes (already correct; C17 fills them, never re-shapes them).
- `packages/app-ui/src/settings/data/live-projection.tsx` — the ONE fold point (reconciliation 3).
- `packages/app-ui/src/settings/environments/{environments-page,host-card,source-control,agents,detection-row}.tsx`
  — the UI readers (rendered by tests today; C17 gives them a live backend).

**Session-start bearing:** confirm `harness.detect` binds `agentsByHost` local-only in `live-projection.tsx`;
confirm `sourceControlByHost` + remote `hosts` resolve empty; confirm host-card Reconnect / Update Daemon are
button-only with no `onClick` (`grep -n "Reconnect\|Update Daemon" packages/app-ui/src/settings/environments/host-card.tsx`).
Then `grep -rniE "forge.detect|forgeDetect|daemon.status|daemonStatus|device.reconnect|daemon.update" packages/protocol/src/commands packages/server/src/dispatch` — **none exist**, so clusters 1/2/5/6 add them.

## 1. Forge (source-control) CLI detection — the `gh` detection engine + seam (Objective: `sourceControlByHost` through the forge adapter seam; #484 boundary)

- [x] 1.1 `packages/adapters/src/forge-discovery.ts`: a **pure** forge-CLI detection engine mirroring
  `harness-discovery.ts` — for a registered forge (id `github`, binary `gh`), harvest PATH + curated dirs,
  probe `<gh> --version` for the version, and probe `gh auth status` for auth state; map to the
  `DetectedTool`-shaped result (version, `ToolStatus` = `available` when authed / `not-authenticated` when
  the CLI is present but unauthed / `not-installed` when the binary is absent, plus the one-line `detail`
  fix). A `ForgeDetector` **registry** with exactly ONE entry (`github`/`gh`) — shaped so a second forge
  could register (the #484 seam) but **none is built** (reconciliation 1). No shell `which`; no React; deps
  injected exactly like `DiscoveryDeps`.
- [x] 1.2 `packages/protocol/src/commands/…`: add the `forge.detect` command def — input `{}` (runs on the
  daemon it is dispatched to = that host), output `{ detected: DetectedForge[] }` where `DetectedForge`
  carries `{ id, version|null, status, detail }` (the wire shape the client maps to `DetectedTool`). Mirror
  `harness.detect`'s def exactly. Update `commands.test.ts`'s command roster.
- [x] 1.3 `packages/server/src/dispatch/forge.ts` (+ register in `dispatch/index.ts`): the `forge.detect`
  handler calling `deps.detectForges()` (add `detectForges(): Promise<DetectedForge[]>` to `DispatchRuntime`,
  composed over `forge-discovery.ts` with the real `gh` probes), mirroring `dispatch/harness.ts`.
- [x] 1.4 Unit + real tests: `forge-discovery.ts` returns `available` for a stubbed authed `gh`,
  `not-authenticated` for present-but-unauthed, and — **positive control (must fail if broken)** — with the
  `gh` binary absent from the injected PATH the forge is **`not-installed` / omitted, never a stale hit**
  (the rename-out-of-PATH invariant at unit scale). `commands.test.ts` sees `forge.detect`. Cluster gate green. Commit.

## 2. Per-host daemon status detection — `reachable` / `version` / `lastSeenVersion` / `updateAvailable` (Objective: host cards; unreachable invents nothing)

- [x] 2.1 A per-host daemon-status detection: for each paired host, ask THAT host's daemon (over its
  connection, via `supervise.ts`'s `probeHealth` / `findHealthyDaemon` which already return the running
  daemon `version`) for `reachable` + `version`. A host that does not answer ⇒ `reachable: false` and no
  `version` (never guessed). Expose it as a read the client can fold into `DaemonInfo` — either extend
  `settings.get.daemonHosts` entries with a `daemon: DaemonInfo` field, or add a sibling `daemon.status`
  command keyed by host; pick the one that reuses the existing enumeration and record which in the task note.
  **Chosen: a sibling `daemon.status` command**, served by `SettingsComposition.daemonStatus()` over the
  SAME `daemonHostSections` enumeration `settings.get` uses. Not a field on `settings.get` because probing
  costs a bounded round-trip per host and `settings.get` is re-read on every appearance edit and render.
  Probes: `local` → `findHealthyDaemon` (this daemon is answering, so reachable by construction; the claim's
  verified identity names the running version, falling back to this process's own); `wsl:<distro>` → the new
  `probeWslDaemon` (resolve `$HOME`, read the published port, health-check it — no spawn); `remote:<deviceId>`
  → unreachable, because a paired device dials US and there is no outbound connection to dial back.
- [x] 2.2 `lastSeenVersion` persistence (reconciliation 4): when a host answers, record its version as that
  host's last-seen (persisted alongside the paired-host / daemon-settings record); when it later goes dark,
  the status read carries `lastSeenVersion` from that record so the card reads "last seen running v…". A host
  that has **never** answered carries no `lastSeenVersion` (blank-but-honest, not fabricated).
- [x] 2.3 `updateAvailable`: compute it honestly from the host's running `version` vs the latest version this
  client knows for that host's platform (the app/server version the local daemon reports, or a real
  update-channel value where one exists). No update mechanism / unknown latest ⇒ `updateAvailable` absent
  (the button simply does not show), never a fake flag.
- [x] 2.4 Tests: a reachable host yields `{ reachable: true, version }`; a host that stops answering yields
  `{ reachable: false, lastSeenVersion }` with **no** `version`; a never-seen host yields `{ reachable:
  false }` with neither. **Positive control:** flip the probe to fail and the status carries no fabricated
  version (the unreachable-invents-nothing invariant). Cluster gate green. Commit.

## 3. Per-host agents + a served enable toggle (Objective: `agentsByHost` per host, per-host enable toggle)

- [x] 3.1 **RULING AMENDMENT (orchestrator-settled 2026-08-28).** As originally written this task assumed the
  CLIENT fans harness detection out over one daemon connection per host. That premise is wrong: the client's
  `ConnectionSupervisor` connects to exactly ONE daemon (`ensureDaemonForProject` picks the locus daemon), by
  design — there is no second connection to dispatch to. **Re-ruled: per-host harness detection is
  SERVER-SIDE**, mirroring cluster 2's proven `daemon.status` pattern — the locus daemon asks each paired host
  the only way it CAN be asked and serves the per-host result, keyed by that host's `source`. So: a sibling
  `harness.hosts` command served by `SettingsComposition.harnessHosts()` over the SAME `daemonHostSections`
  enumeration `settings.get` / `daemon.status` use (local → detect directly; `wsl:<distro>` → the distro's own
  discovery deps over `wsl.exe`; `remote:<deviceId>` → cannot be asked). A host that cannot be asked reports
  **honest absence** (`asked: false`, no rows) — never the local set copied everywhere. No engine change —
  `harness-discovery.ts` already runs per-locus; this is the per-host routing + keying. `harness.detect`
  itself is untouched (the front door and mobile still read it).
- [x] 3.2 A served per-host enable store for `setToolEnabled` (closes the named gap): persist a host+tool
  enable/disable decision the way per-host facts persist (daemon-settings rung / a small settings key), so a
  ruled-out agent stays ruled out across reload — replacing the session-only `useState` set in
  `live-projection.tsx`. Add the read/write command(s) if none fits; keep the `setToolEnabled(hostId, toolId,
  enabled)` signature unchanged (reconciliation 3).
- [x] 3.3 Tests: two hosts each report their own detected harnesses (not the local set copied everywhere);
  toggling an agent off on one host persists (a re-read reflects it) and does not affect the other host.
  **Positive control:** with a harness binary absent from a host's injected PATH that agent row is **absent**
  for that host, never a stale hit. Cluster gate green. Commit.

## 4. Fold the three detections into the live projection (Objective: host cards / sourceControl / agents go live; reconciliation 3 — the seam is the only fold point)

- [x] 4.1 In `packages/app-ui/src/settings/data/live-projection.tsx`: bind `sourceControlByHost` to
  `forge.detect` per host (cluster 1) and `hosts` to the per-host daemon-status read (cluster 2), and extend
  the existing `agentsByHost` binding to all hosts (cluster 3). Map each wire result to the existing
  `DetectedTool` / `SettingsHost` / `DaemonInfo` shapes; an in-flight / rejected read ⇒ that field's honest
  fallback (empty rows / unreachable host), never a stub. Delete the now-obsolete "removed in v4.2" /
  "local-only" gap notes for these three fields and record the #483 reversal (reconciliation 2). `reviewRoles`
  and the per-project fields stay honest-empty (C16 / C10 own them).
- [ ] 4.2 `packages/app-ui/src/settings/environments/environments-page.tsx`: when the projection carries
  hosts, render them (it already prefers `projection.hosts`); the local-only bridge synthesis becomes the
  fallback for the zero-projection case only. Confirm remote cards render their real `DaemonInfo` line and
  their Source Control + Agents sections from the folded detection.
- [ ] 4.3 DOM tests over a projection whose reads are backed by fake bridge handlers: the local card shows
  the real detected `claude`/`gh` rows with versions; a second (remote) host shows ITS own detected rows and
  daemon line; an unreachable host shows "last seen running v…"; the source-control section is populated (not
  empty). **Positive control:** a rejected `forge.detect` read leaves the Source Control section honestly
  empty rather than showing a stale/fake row. Cluster gate green. Commit.

## 5. Reconnect (#533) — wire the button to a real re-handshake

- [ ] 5.1 A reconnect operation exposed to the settings surface: a command (or a supervisor call the seam
  resolves) that re-attempts the handshake to a host's daemon through the ConnectionSupervisor
  (`spawnDaemon`/`waitForHealthy`/`findHealthyDaemon` as appropriate for local vs remote), returning an
  honest reachable/failed result that refreshes that host's `DaemonInfo`.
- [ ] 5.2 `packages/app-ui/src/settings/environments/host-card.tsx`: give the Reconnect button its `onClick`
  — dispatch the reconnect, show "Connecting…" in-flight (disabled while pending), and on resolution either
  the card flips to reachable (success) or shows an honest failure state (still unreachable, an error line).
  No pretend animation (reconciliation 5). Thread the action through the projection seam, not `bridge.invoke`
  in the page.
- [ ] 5.3 DOM test: clicking Reconnect on an unreachable host shows "Connecting…", then on a **failing**
  reconnect the card stays unreachable with an honest error (the positive control — a reconnect that does not
  succeed must not read green); on a succeeding reconnect the card becomes reachable with its version. Cluster
  gate green. Commit.

## 6. Update Daemon (#534) — wire the button to a real update

- [ ] 6.1 A daemon self-update operation + the real update-available detection that gates the button (cluster
  2.3 feeds `updateAvailable`). A command that triggers the daemon's update mechanism (or surfaces the real
  one) and returns an honest outcome. Where no update mechanism exists for a host, the button does not show
  (cluster 2.3 already withholds the flag) — never a dead "Updating…" that lies.
- [ ] 6.2 `host-card.tsx`: give the Update Daemon button its `onClick` — dispatch the update, show "Updating
  the daemon…" in-flight (disabled while pending), and on resolution show the honest outcome (updated to v…,
  or a failure line). Threaded through the projection seam.
- [ ] 6.3 DOM test: with `updateAvailable` set, clicking Update Daemon shows "Updating the daemon…" then the
  honest outcome; **positive control:** a failing update shows a failure line, not a fake success; a host with
  no update mechanism shows no button at all. Cluster gate green. Commit.

## 7. Packet verification — E2E + positive controls + docs, full gate

- [ ] 7.1 E2E against this machine (drive the real app / real daemon, evidence shown, not asserted):
  detection finds the real `claude` CLI and the real `gh` forge CLI with their **true** versions; an
  unreachable host renders unreachable with its last-seen version rather than blank chrome; Reconnect and
  Update Daemon perform real operations with honest in-flight + outcome states.
- [ ] 7.2 The packet positive control (must be able to fail): **rename a detected binary out of `PATH`** (e.g.
  `gh` or `claude`) and its row **honestly disappears** rather than reporting a stale hit; restore it and the
  row returns. Run it, see the row vanish, revert. Plus the per-cluster controls: forge `not-installed` on
  absent binary (1.4), unreachable-invents-no-version (2.4), per-host agent absence (3.3), rejected-read
  empty section (4.3), reconnect-failure-not-green (5.3), update-failure-not-green (6.3) — confirm each
  genuinely fails when its invariant is broken (flip once, see red, revert).
- [ ] 7.3 Docs (definition of done): update `docs/developing/guides/settings-and-setup.md` (and any
  Environments / host-detection page — grep `docs/` excl. `docs/dist`) with the per-host detection model
  (host cards, source-control via the forge seam, agents + per-host toggle) and the live Reconnect / Update
  Daemon actions. State the **#484 planning boundary** where forges are named: GitHub / `gh` is the only forge
  built; GitLab / Bitbucket are planned, not shipped. Do not narrate the v4.2 removal history (reader-facing
  docs describe current Rennet).
- [ ] 7.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — confirm **zero new
  packages**, not assume — lint, typecheck, test, build). Commit. Output the completion sigil
  `<promise>C17-COMPLETE</promise>`. **BUILD-STATUS.json is flipped by `main`, not this agent** (per dispatch).
