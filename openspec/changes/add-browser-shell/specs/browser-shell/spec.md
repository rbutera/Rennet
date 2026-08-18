# browser-shell Specification

## Purpose

Rennet runs full-fat in a browser tab served by the daemon itself, as a peer of the desktop app. Both shells mount the same UI and the same connections surface; either can attach to the local daemon or a paired remote one. No feature exists only in one shell; no read-only mode exists.

## ADDED Requirements

### Requirement: The daemon serves the browser client

When a UI bundle directory is available, the daemon SHALL serve it over its existing HTTP port (index at `/`, assets by path, path-traversal attempts refused); without one it SHALL run headless exactly as before. `rennet serve` SHALL locate the bundle by convention beside the server bundle, overridable by flag; the packaged app SHALL ship the bundle so its spawned daemon serves it too.

#### Scenario: a tab gets the app

- **WHEN** a browser navigates to the daemon's HTTP origin
- **THEN** the Rennet UI loads and connects over WS to the same origin

#### Scenario: traversal is refused

- **WHEN** a request path escapes the bundle root
- **THEN** the daemon answers 404 and serves nothing outside the root

### Requirement: One UI, two shells, no forks

The browser shell SHALL be a composition entry over the same `packages/ui` the desktop renderer mounts — no duplicated components. Bridge members the browser lacks (native menu, directory picker) SHALL degrade per the existing optional-member contract: menus are simply absent; `repository.choose` is satisfied by an explicit path prompt so the command remains functional everywhere.

#### Scenario: full journey in a tab

- **WHEN** the browser client drives the local-review happy path against a loopback daemon
- **THEN** the journey completes end to end with no Electron involved

#### Scenario: parity is inventoried, not asserted

- **WHEN** the parity test enumerates every wire command
- **THEN** each command is reachable through the browser shell's bridge path, and every shell-level interception appears on an explicit allowlist with an asserted justification

### Requirement: The connections surface owns daemon attachment

Both shells SHALL mount a shared connections surface showing the attached daemon, offering the localhost default and saved remote daemons (host + device token, added via the pairing-code flow), persisting the list client-side, and switching by remounting the app against the chosen daemon. The desktop app attaching to a remote daemon SHALL NOT spawn or disturb its local one.

#### Scenario: attach to a remote daemon

- **WHEN** a user adds a remote daemon by host and pairing code and selects it
- **THEN** the app remounts attached to that daemon with its reviews and full capability (as projected per R19), and the indicator names it

#### Scenario: desktop stays supervisor of its own daemon only

- **WHEN** the desktop app switches to a remote daemon and back
- **THEN** the local daemon's lifecycle is unaffected throughout

### Requirement: Affordances key on server locus, never client type

Machine-bound actions SHALL resolve against the daemon's machine (editor opens happen where the daemon runs; an absent capability reports itself honestly rather than breaking). No command SHALL be gated on which shell invoked it.

#### Scenario: editor opens on the daemon host

- **WHEN** open-in-editor is invoked from any shell against a loopback daemon
- **THEN** the file opens in an editor on that machine at the right line
- **AND** against a daemon with no editor capability the result is an honest failure, not a crash
