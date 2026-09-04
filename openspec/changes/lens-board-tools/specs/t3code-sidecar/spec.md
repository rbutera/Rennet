## ADDED Requirements

### Requirement: A thread carries the MCP servers its creator gives it

A sidecar turn SHALL be able to carry a set of named MCP servers, given by the caller that started it, for both the Claude and the Codex provider. Those servers SHALL be merged with whatever the sidecar configures for the thread itself and with the user's own configured servers, never substituted for either; a name the sidecar owns SHALL win a collision. The servers SHALL be a property of the provider session the thread's first turn opens, and a later turn on that thread asking for a different set SHALL be refused by name rather than served with the wrong one.

A server's credential SHALL reach the provider child by header or by named environment variable, never on an argument list.

This SHALL be implemented as an upstreamable change to the vendored server, on the same seam and in the same shape as the turn's output-schema field, with a ledger row for every vendored file it touches.

#### Scenario: A seat thread gets its board server

- **WHEN** a lens seat's thread starts its first turn with one named MCP server
- **THEN** the provider session for that thread exposes that server's tools alongside the user's own configured servers

#### Scenario: The sidecar's own server keeps its name

- **WHEN** a caller supplies a server under a name the sidecar itself uses
- **THEN** the sidecar's own server is the one bound to that name

#### Scenario: A later turn asks for different servers

- **WHEN** a second turn on a thread declares a different set of servers than the session was opened with
- **THEN** the turn is refused with the mismatch named, rather than running against the session's existing set

#### Scenario: No credential on the argument list

- **WHEN** a Codex seat runs with a caller-supplied server
- **THEN** its app-server arguments name the environment variable holding the credential, and the credential itself is not among them

#### Scenario: A caller-supplied server does not claim the sidecar's own tools

- **WHEN** a Codex session carries a caller-supplied server and no sidecar browser server
- **THEN** the turn's prompt does not describe browser tools

## MODIFIED Requirements

### Requirement: Nothing leaves the machine through the sidecar except harness traffic

The daemon SHALL start the sidecar with T3 telemetry disabled and with no T3 Connect, relay or cloud configuration. The daemon's health report SHALL name the sidecar as an owned process and SHALL state that its only egress is the coding harness's own provider traffic. Tool servers the daemon supplies to a thread SHALL be bound to the local interface and SHALL be named in that report as local, so a reader can tell a loopback tool call from egress. This is disclosure, not a consent step: no dialog is shown.

#### Scenario: telemetry stays off across restart

- **WHEN** the sidecar is spawned, stopped and spawned again
- **THEN** each spawn carries the telemetry-off setting and the health report shows telemetry off

#### Scenario: outbound connections during a turn

- **WHEN** a thread turn runs on the sidecar with network observation enabled
- **THEN** the only remote endpoints contacted are the harness provider's and any MCP servers the user configured, and the daemon's own tool server is reached only over loopback
