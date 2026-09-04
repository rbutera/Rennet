---
title: ADR 0001 - Tray quit owns the daemon
description: Why explicit tray Quit stops the owned daemon while closing a window leaves it running.
---

- **Status**: Accepted
- **Date**: 2026-08-19
- **Scope**: desktop process ownership

## Context

The desktop app can own its local daemon or attach to a daemon owned elsewhere. Window lifetime and daemon lifetime are separate, so closing a window must not interrupt reviews or streams.

## Decision

The tray's Quit action is the only desktop action that stops a daemon:

- It stops only the owned daemon: the process claimed by `daemon.json` in the app data directory, regardless of whether the app or CLI spawned it. The graceful path — the same one `rennet stop` takes — asks the daemon to shut down over its own wire (`POST /shutdown`), records in-flight turns as `interrupted`, and clears the claim before the app exits. SIGTERM and then SIGKILL are bounded fallbacks for a daemon that will not answer.
- The claim is **health-verified before any command**. `daemon.json` is a claim to
  verify, never proof: Quit probes `/healthz` and commands only a PID whose identity
  and port the probe confirmed. A stale claim for a dead or unrelated process is removed without sending anything, so tray Quit cannot take down
  someone else's process.
- It waits for the process to be **gone**, not merely for a pid probe to fail: the
  spawned child's own `exit` when this instance spawned the daemon, and otherwise
  the claim clearing plus a pid that is not in a running state. An exited-but-unreaped
  process is gone; it holds no port and no app bundle.
- It exits even if the daemon does not confirm death within the bounded ladder,
  recording what it actually found in the log. The next launch verifies the claim again.
- **Window close still stops nothing.** Closing the last window keeps the shell
  tray-resident; the daemon and every stream are untouched. Only the explicit
  Quit tears down.
- An **attached** remote daemon is never signalled. A daemon running on another
  host belongs to that host.

## Consequences

- There is one desktop teardown path. Background work survives window close.
- The Quit label reads "Quit Rennet and stop daemon" only when an owned
  local daemon is running, "Quit Rennet" otherwise.
- The action runs directly without a confirmation prompt.
