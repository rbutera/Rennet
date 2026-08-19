# ADR 0001 — Tray Quit owns the daemon; window close never does

- **Status**: Accepted
- **Date**: 2026-08-19
- **Context**: tray-presence (desktop ambient presence)

## Context

Issue #379 made the review daemon outlive the app: the desktop shell became a
supervisor + client, and app quit was deliberately stripped of its implicit
teardown — no `before-quit` shutdown, closing the window stops nothing. That is
the invariant the streaming-in-the-background feature rests on.

tray-presence adds a tray with a "Quit completely" that must, per Rai's grill
session, *completely exit* Rennet — app plus the daemon it owns. That reintroduces
a teardown path #379 removed. This ADR records why that is safe and how it is
scoped so it does not erode the #379 invariant.

## Decision

The tray's Quit is the **one** explicit, scoped teardown:

- It stops **only the owned daemon** — the one claimed by `daemon.json` in the
  app's own data directory, regardless of who spawned it — via the same graceful
  path as `rennet stop` (SIGTERM → the daemon settles in-flight turns as
  persisted, resumable `interrupted` state → the claim clears). Then the app exits.
- The claim is **health-verified before any signal**. `daemon.json` is a claim to
  verify, never truth: Quit probes `/healthz` and signals only a pid whose identity
  and port the probe confirmed. A stale claim — a dead pid, or one the OS reused for
  an unrelated process — is removed, never killed, so tray Quit can never take down
  someone else's process.
- It exits even if the daemon does not confirm death within a bounded wait,
  reporting that truthfully in the log, exactly as `rennet stop` does. The
  claim-file protocol keeps the next launch honest either way.
- **Window close still stops nothing.** Closing the last window keeps the shell
  tray-resident; the daemon and every stream are untouched. Only the explicit
  Quit tears down.
- An **attached** remote daemon is never signalled. A daemon running on another
  host belongs to that host.

## Alternatives considered

- **No daemon stop (CLI-only teardown).** Rejected: the ask was a *complete* exit
  from the tray. Forcing the user to the CLI to stop the daemon fails the
  feature's whole point.
- **Kill every reachable daemon.** Rejected: a remote/attached daemon belongs to
  its own machine; stopping it from a client that merely connected to it would be
  wrong and surprising.

## Consequences

- There is exactly one teardown path, and it is explicit and user-chosen. The
  #379 invariant (background survival) is intact for every other exit.
- The Quit label is truthful: "Quit Rennet and stop daemon" only when an owned
  local daemon is running, "Quit Rennet" otherwise.
- No confirmation prompt — the label states the consequence; the action is the
  user's, taken deliberately from the tray.
