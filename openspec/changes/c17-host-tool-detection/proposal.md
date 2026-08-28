# C17 — Host & tool detection: the engine behind the Environments surface (#485, #533, #534)

## Why

The Environments settings surface (C10 §3–5) is drawn but hollow. `LiveSettingsProjectionProvider`
binds exactly one field — `agentsByHost` for the **local** host, from `harness.detect` (B7). Every
other detection is honest-empty *because the backend does not exist yet*, not because there is nothing
to detect:

- **Host cards** synthesise the local machine from the bridge (`reachable: true`, `version`), and every
  remote/paired host resolves to nothing — no per-host daemon `reachable` / `version` /
  `lastSeenVersion` / `updateAvailable`. `settings.get.daemonHosts` *enumerates* the paired hosts but
  carries no per-host daemon state to render.
- **`sourceControlByHost`** is empty: the gh/glab CLI-detection model was removed in v4.2 when GitHub
  briefly went pure-OAuth. #483 **reversed** that — `gh` rides again (enterprise orgs forbid OAuth-app
  installs; auth is `gh auth token`). So forge-CLI detection is wanted again, now through a forge
  adapter seam.
- **`agentsByHost`** runs only against the local machine, and its per-host enable toggle
  (`setToolEnabled`) has no served store — enablement resets on reload (named gap).
- The two host-card actions **Reconnect** (#533) and **Update Daemon** (#534) are visible but inert —
  button-only, no `onClick`, no daemon operation, no feedback. That is the one place the surface *looks*
  live but is not, breaking the honest-empty discipline.

C17 is the detection engine that fills every one of those, so no host card shows a state it is
structurally incapable of filling. Detection runs **over the daemon connection per host** — each paired
host's own daemon is asked; the local machine's answers are never assumed to hold everywhere. Rule Zero:
this is real capability going live, never a gate — and an unreachable host or an absent binary invents
**nothing** (no fake host, no guessed version, no stale hit).

## What Changes

1. **Forge (source-control) detection** — a `forge.detect` command mirroring `harness.detect`, running
   `gh --version` + `gh auth status` on the target host's daemon and returning the existing `DetectedTool`
   row shape (id / label / version / status / detail / enabled). Reached through a small forge-detection
   seam so a second forge *could* register later; only GitHub / `gh` is built (the `#484` boundary below).
   Feeds `sourceControlByHost`.
2. **Per-host daemon status detection** — a per-host daemon-status read that asks each paired host's
   daemon for `reachable` + running `version` (reusing the ConnectionSupervisor's `probeHealth` /
   `findHealthyDaemon`, which already return the daemon's version), persists `lastSeenVersion` for a host
   that answered before and is now dark, and computes `updateAvailable`. Feeds the host cards' `DaemonInfo`.
3. **Per-host agents + a served enable toggle** — run `harness.detect` per host (not local-only), and give
   `setToolEnabled` a real persistence store so per-host enablement survives reload (closes the named gap).
   Feeds `agentsByHost` for every host.
4. **Fold into the live projection** — bind `hosts`, `sourceControlByHost`, and `agentsByHost` in
   `LiveSettingsProjectionProvider` to the three reads above; the projection seam is the only place the
   binding changes (the pages and `DetectedTool` / `DaemonInfo` shapes are untouched). The Environments
   page stops being local-only and renders real per-host cards.
5. **Reconnect (#533)** — a reconnect command that re-handshakes a host's daemon through the
   ConnectionSupervisor; the host-card Reconnect button gets its `onClick`, "Connecting…" in-flight state,
   and an honest success/failure outcome.
6. **Update Daemon (#534)** — a daemon self-update command + the real update-available detection that gates
   the button; the Update Daemon button gets its `onClick`, "Updating the daemon…" in-flight state, and an
   honest outcome.

## Out of scope — the #484 boundary (confirmed)

**#484 stays a PLANNING ticket.** Its forge-adapter seam *informs the shape* here — forge detection is
reached through a seam general enough that GitLab (`glab`) or Bitbucket could register later — but
**building GitLab / Bitbucket forges is NOT in C17.** GitHub / `gh` is the sole reference implementation
this change ships; the seam has exactly one registered forge. No `glab`/Bitbucket detection, no
forge-neutral vocabulary audit, no second `ForgePort` implementation.

Also out: per-project preferences (folded into the C10 wiring ledger), Model Council / review-role mappings
(C16 owns `reviewRoles`), and the doctrine ruling #485 §"what needs deciding" parks (review-mode vocabulary,
council job ids). C17 ships detection + honest state only.

## Objective clause → cluster map (every packet clause lands a task)

| Packet clause | Cluster |
|---|---|
| Host cards: `reachable` / `version` / `lastSeenVersion` / `updateAvailable`, unreachable invents nothing | 2, 4 |
| `sourceControlByHost` — forge CLIs per host, version + status, through the forge adapter seam | 1, 4 |
| `agentsByHost` — `claude` / `codex` per host, per-host enable toggle (`setToolEnabled`) | 3, 4 |
| Reconnect (#533) wired to a real daemon operation | 5 |
| Update Daemon (#534) wired to a real daemon operation | 6 |
| Detection runs over the daemon connection per host, never assuming local answers | 1, 2, 3 |
| #484 is planning-only — seam shape only, no GitLab/Bitbucket built | 1 (+ Out of scope) |
| E2E + positive control (rename a detected binary out of PATH ⇒ row honestly disappears) | 7 |
| Docs updated in the same change | 7 |

## Reconciliations (part of the spec — hold these, do not re-open)

1. **The forge seam is detection-only and singleton.** C17 adds forge *CLI detection* (version + auth
   state), not a second `ForgePort` review implementation. The existing `GitHubForgeAdapter` (PR/diff/CI)
   is untouched; the detection seam is a sibling shaped for #484's future, with `gh` its only entry.
2. **`sourceControlByHost` is restored, not invented.** The v4.2 removal comment in `live-projection.tsx`
   is superseded by #483 (gh rides again). This change deletes that gap note for the three fields it binds
   and records the reversal, so a reviewer does not read the stale comment as current doctrine.
3. **The projection seam is the only fold point.** Binding `hosts` / `sourceControlByHost` /
   `agentsByHost` changes `live-projection.tsx` (and its detection-read helpers) only — the pages,
   `host-card.tsx` shapes, `DetectedTool`, `DaemonInfo`, and `setToolEnabled` signature do not change
   (Reconnect/Update-Daemon `onClick` wiring in clusters 5–6 is additive, not a shape change).
4. **`lastSeenVersion` needs a persistence.** A host's last-answered daemon version is remembered so a
   now-dark host reads "last seen running v…" instead of blank chrome. Persisted the way per-host facts
   already persist (daemon-settings / pairing store); never fabricated for a host that never answered.
5. **Reconnect / Update-Daemon outcomes are honest.** A reconnect to a truly-down host reports failure,
   not a fake "Connecting…" that resolves green (the spike's pretend animation is discarded). An update
   with no mechanism available discloses that, rather than a fake "Updating…".

## Verification (packet)

`pnpm check` green. E2E against this machine: detection finds the real `claude` CLI and the real `gh`
forge CLI with their true versions; an unreachable host renders unreachable with its last-seen version
rather than blank chrome; Reconnect and Update Daemon perform real operations. **Positive control (must be
able to fail):** rename a detected binary out of `PATH` and its row honestly disappears rather than
reporting a stale hit.

## Completion sigil

`<promise>C17-COMPLETE</promise>`
