# Context packet — C17 host-tool-detection

Read `openspec/BUILD-LOOP.md` first. Added 2026-08-28 under Rai's honest-present
ruling; not in the original 32. **Dispatched inside this build — not deferred.**

## Objective

The detection engine behind the Environments settings surface, so no host card
shows an honest-empty state it is structurally incapable of filling:

- **Host cards** (`SettingsProjection.hosts`): each paired host's daemon asked for
  `reachable`, `version`, `lastSeenVersion`, `updateAvailable`. An unreachable
  host invents no state.
- **Source-control detection** (`sourceControlByHost`): forge CLIs present on that
  host, with version and status, through the forge adapter seam.
- **Agent detection** (`agentsByHost`): the `claude` CLI and `codex-app-server` as
  detected on that host — official mark, version line, status chip, per-host
  enable toggle (`setToolEnabled`).
- **The two host-card actions**: Reconnect (#533) and Update Daemon (#534), wired
  to real daemon operations rather than dead buttons.

Detection runs over the daemon connection per host, never by assuming the local
machine's answers apply everywhere.

## Out of scope

Per-project preferences (folded into the C10 wiring ledger) and council mappings
(C16). Implementing GitLab/Bitbucket forges — #484 is a *planning* ticket and its
seam informs the shape here; building those forges is its own work.

## Blocked by

B10 (settings ladder + `settings.*`). C10 (the pages). Independent of C15/C16 —
footprints are disjoint, so it may run in parallel with them.

## Sources

- Spec + spike evidence: https://github.com/rbutera/rennet/issues/485
- Host-card actions: https://github.com/rbutera/rennet/issues/533 · https://github.com/rbutera/rennet/issues/534
- Forge adapter seam + per-host detection design: https://github.com/rbutera/rennet/issues/484
- Auth reality: `gh auth token` (enterprise orgs forbid OAuth-app installs) — https://github.com/rbutera/rennet/issues/483
- The seam this deletes: `packages/app-ui/src/settings/data/projections.tsx`
- Existing: `packages/adapters/src/github-*`, daemon host pairing in `packages/server`

## Verification

- `pnpm check` green. E2E: against this machine, detection finds the real `claude`
  CLI and forge CLI with true versions; an unreachable host renders unreachable
  with its last-seen version rather than blank chrome; Reconnect and Update Daemon
  perform real operations. Positive control: rename a detected binary out of PATH
  and the row honestly disappears rather than reporting a stale hit.

## Completion sigil

`<promise>C17-COMPLETE</promise>`
