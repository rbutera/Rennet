# detached-daemon Specification

## Purpose

The Rennet server runs as a detached daemon that outlives any client. The desktop app supervises it (probe, spawn, skew-restart) and connects as a client; a `rennet` CLI is the second client. Quitting the app never stops a running review.

## ADDED Requirements

### Requirement: The daemon outlives its clients

The server SHALL run as a detached process spawned by the desktop shell (or run in foreground by `rennet serve`), writing a discovery file (`daemon.json`: pid, port, protocolVersion, version, startedAt) under its data dir when healthy and removing it on clean shutdown. Quitting the desktop app SHALL NOT stop the daemon or abort in-flight turns; explicit stop (signal / `rennet stop`) SHALL shut down cleanly via the server's existing shutdown path.

#### Scenario: a review turn survives app quit

- **WHEN** a turn is running and the user quits the desktop app, then relaunches it against the same data dir
- **THEN** the relaunched app connects to the same daemon process (pid unchanged) and the turn's outcome is reachable (live if still running, persisted otherwise)

#### Scenario: explicit stop is clean

- **WHEN** the daemon receives SIGTERM (or `rennet stop`)
- **THEN** it runs shutdown (abort live turns, close watcher, rehydration, store, listener) and removes `daemon.json`

### Requirement: Probe-then-spawn supervision, no handover protocol

A launcher (app or CLI) SHALL treat `daemon.json` as a claim: verify liveness via an HTTP health endpoint on the daemon's listener and protocol compatibility via the phase-0 window check before connecting. A missing, stale (dead pid), or unhealthy claim SHALL lead to spawning a fresh daemon that overwrites the claim. On incompatible protocol skew the desktop shell SHALL restart the daemon without user ceremony; the CLI SHALL only report skew, never restart.

#### Scenario: healthy daemon is reused

- **WHEN** the app launches while a compatible daemon is running
- **THEN** it connects to the existing daemon and spawns nothing

#### Scenario: stale claim is replaced

- **WHEN** `daemon.json` names a dead pid or the probe fails
- **THEN** the launcher spawns a new daemon and the file reflects the new process

#### Scenario: skew restarts (shell) or reports (CLI)

- **WHEN** the probe reports a protocol version outside the launcher's compatibility window
- **THEN** the desktop shell stops the old daemon and spawns the bundled one, logging the restart
- **AND** `rennet status` in the same situation prints both versions and exits nonzero, restarting nothing

### Requirement: The CLI is a real client

`rennet` (serve / status / stop) SHALL ship as a bin of the server package. `status` SHALL report by reading the claim and probing health (honest exit codes). At least one CLI-driven command invocation SHALL travel the same WS wire and bridge the desktop uses.

#### Scenario: status from a terminal

- **WHEN** a daemon is running and `rennet status` runs against the same data dir
- **THEN** it prints pid, port, and versions and exits 0; with no daemon it says so and exits nonzero

#### Scenario: CLI invokes over the wire

- **WHEN** the CLI connects via the shared WS bridge and invokes a command
- **THEN** the daemon serves it identically to a desktop-originated invoke

### Requirement: The packaged app carries and spawns its own daemon

The packaged desktop app SHALL bundle the server entrypoint and spawn it without any system Node dependency; the packaged smoke check SHALL prove the spawned daemon reaches healthy. Data-dir isolation (env override) SHALL keep dev checkouts, agent worktrees, and e2e runs from ever attaching to the production daemon.

#### Scenario: packaged spawn reaches healthy

- **WHEN** the packaged app is launched by the smoke check
- **THEN** a daemon process spawns from the bundled entrypoint and its health endpoint answers with matching versions

#### Scenario: isolated data dirs, isolated daemons

- **WHEN** a process sets the data-dir override to a fresh directory
- **THEN** supervision reads and writes only that directory's claim, and the production daemon is untouched

### Requirement: Choosing a repository still works from a windowed client

With the dialog now unreachable from the daemon, `repository.choose` SHALL accept an optional explicit `path` (append-only input change); the desktop renderer SHALL obtain the path from the shell's native picker and forward it, preserving the existing grant flow. Headless clients SHALL pass `path` explicitly.

#### Scenario: desktop pick round-trips

- **WHEN** the user triggers repository choice in the desktop app
- **THEN** the native picker's selection reaches the daemon as the command's `path` input and the repository is granted exactly as before

#### Scenario: headless choice is explicit

- **WHEN** a client invokes `repository.choose` with a `path`
- **THEN** the daemon uses it without any dialog dependency
