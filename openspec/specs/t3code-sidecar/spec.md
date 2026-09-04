# t3code-sidecar Specification

## Purpose
The Rennet daemon runs a T3 Code server, built from the vendored snapshot, as an owned sidecar under a private base directory so interactive coding sessions get T3's session model without Rennet re-implementing it or touching the user's own T3 install.
## Requirements
### Requirement: The daemon owns exactly one sidecar per data directory

The daemon SHALL spawn one T3 Code server per Rennet data directory when the chat engine setting selects it, and SHALL reuse a verified healthy sidecar instead of spawning a second. The sidecar's base directory SHALL be inside the Rennet data directory, never the user's `~/.t3`. The sidecar's pid, port and vendored base commit SHALL be recorded in a claim file beside the daemon claim. A claim SHALL be treated as a claim to verify: a health probe MUST confirm the process at that pid and port is the daemon's sidecar before the claim is trusted, and a stale claim SHALL be removed, never signalled.

#### Scenario: second daemon start finds the sidecar alive
- **WHEN** the daemon restarts while a healthy sidecar it previously spawned is still running
- **THEN** the daemon adopts it without spawning another and the claim file is unchanged

#### Scenario: stale claim after a crash
- **WHEN** the claim file names a pid that no longer answers the sidecar health probe
- **THEN** the claim is removed and a fresh sidecar is spawned

#### Scenario: user's own T3 install is untouched
- **WHEN** the sidecar runs with a standalone T3 Code install present on the machine
- **THEN** nothing under `~/.t3` is read or written by the sidecar

### Requirement: The sidecar binds loopback and authenticates by bootstrap credential

The sidecar SHALL bind to loopback only. The daemon SHALL pass a one-time bootstrap credential to the sidecar over a file descriptor, never on argv or in the environment, and SHALL exchange it for a scoped session token that it stores in the data directory with owner-only permissions. Clients SHALL obtain sidecar access from the daemon, never by reading the token file directly.

#### Scenario: credential is not visible in the process table
- **WHEN** the sidecar is running
- **THEN** its argv and environment contain no bootstrap credential or session token

### Requirement: Provider binaries are seeded from Rennet's discovery

At spawn the daemon SHALL write the sidecar's provider settings with the absolute paths of the `claude` and `codex` binaries Rennet's own discovery resolved, so the sidecar never depends on the daemon's PATH. Home paths SHALL stay empty so the harness uses the user's normal login and settings.

#### Scenario: GUI launch with a minimal PATH
- **WHEN** the daemon was launched by the desktop app with launchd's PATH and Rennet discovered `claude` under `~/.local/bin`
- **THEN** the sidecar's Claude provider reports ready with that absolute path

### Requirement: Nothing leaves the machine through the sidecar except harness traffic

The daemon SHALL start the sidecar with T3 telemetry disabled and with no T3 Connect, relay or cloud configuration. The daemon's health report SHALL name the sidecar as an owned process and SHALL state that its only egress is the coding harness's own provider traffic. This is disclosure, not a consent step: no dialog is shown.

#### Scenario: telemetry stays off across restart
- **WHEN** the sidecar is spawned, stopped and spawned again
- **THEN** each spawn carries the telemetry-off setting and the health report shows telemetry off

#### Scenario: outbound connections during a turn
- **WHEN** a thread turn runs on the sidecar with network observation enabled
- **THEN** the only remote endpoints contacted are the harness provider's and any MCP servers the user configured

### Requirement: Stopping the daemon stops the sidecar

`rennet stop` and the tray Quit SHALL send SIGTERM to the owned sidecar after the daemon has interrupted its own turns, wait a bounded time, and clear the sidecar claim. A sidecar that does not exit within the bound SHALL be logged and left for the next start to reap; the daemon SHALL still exit.

#### Scenario: quit with a T3 turn streaming
- **WHEN** Quit is chosen while a thread turn is streaming on the sidecar
- **THEN** the sidecar receives SIGTERM, T3 persists the turn as interrupted, the claim clears, and the app exits without a dialog

### Requirement: The sidecar is built from the vendored snapshot and its contract is proven at boot

The daemon SHALL spawn the server bundle built from the vendored snapshot, never a separately installed T3 Code. At startup it SHALL verify the sidecar answers its RPC handshake and exposes the thread and turn methods this change depends on, and SHALL report `degraded` with the mismatch named when it does not.

#### Scenario: fold drops a method
- **WHEN** a fold removes a method the daemon calls and the sidecar starts
- **THEN** the chat engine reports degraded with the method named and the Rennet orchestrator remains selectable

### Requirement: Every thread is created in the session's bound workspace

Every sidecar thread Rennet creates for a session — the session's chat thread, each lens seat thread, and the handoff thread — SHALL be created with the session's bound workspace as its worktree, never the project root alone. The sidecar's per-turn checkpoints on those threads SHALL be the receipts Rennet reads for a round's commits. A thread created for a session whose bound workspace no longer exists SHALL fail with a message naming the missing path.

#### Scenario: Seat threads share the bound worktree
- **WHEN** a generation starts for a session bound to a worktree
- **THEN** each seat thread's worktree is that path and every seat's tools run there

#### Scenario: Round receipt is a checkpoint
- **WHEN** a round turn on the session's thread completes with commits
- **THEN** the thread's checkpoint for that turn names the commit the round account records

### Requirement: A coding round runs on its own thread, never the session's

Rennet SHALL create a distinct sidecar thread for each coding round, bound to that round's identity — the session and the round's operation — never to the session's key. The thread SHALL be created with the session's bound workspace as its worktree and the same model selection the review handoff uses, and titled so a reviewer can tell which branch and which round it holds. The round's work order SHALL run as one turn on that thread, and the round's receipt SHALL be that thread's checkpoint for that turn. The session's chat and handoff thread SHALL receive no round turn. Archiving the session SHALL delete its round threads with its other threads.

#### Scenario: A round binds its own thread

- **WHEN** a round is dispatched for a session
- **THEN** a thread bound to that round's identity is created in the session's bound workspace and the work order is sent to it

#### Scenario: The chat thread stays a conversation

- **WHEN** a round runs on a session whose chat thread carries the reviewer's conversation
- **THEN** no turn from that round appears on the chat thread

#### Scenario: The receipt is read from the round's thread

- **WHEN** the daemon restarts while a round's turn is running and then reads the round's receipt
- **THEN** it reads the checkpoint from the round's own thread, and a checkpoint left by any other turn of the session cannot be adopted as this round's

#### Scenario: Archive removes the round threads

- **WHEN** a session with two landed rounds is archived
- **THEN** both round threads are deleted along with the session's chat and seat threads

