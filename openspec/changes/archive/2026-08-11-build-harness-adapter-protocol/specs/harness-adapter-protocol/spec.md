## ADDED Requirements

### Requirement: The harness protocol is node-free and portable
The normalized harness protocol SHALL import nothing at module scope beyond in-repo types, SHALL contain no `node:*`, filesystem, or process access, and SHALL be importable by a browser or mobile client.

#### Scenario: A renderer imports capability and event types
- **WHEN** a browser-safe package imports the harness protocol
- **THEN** it resolves the descriptor, capability, and event types with no Node runtime dependency

### Requirement: Capability flags are three-layer and derived from passing checks
Every capability SHALL carry three independent boolean layers (`implementedByAdapter`, `advertisedByHarness`, `availableInSession`), each SHALL default to `false`, and a layer SHALL become `true` only from an explicit passing check, never from declaration.

#### Scenario: A capability with no evidence
- **WHEN** a descriptor is built without evidence for a capability
- **THEN** all three layers of that capability are `false`

#### Scenario: A capability implemented but not yet advertised or exercised
- **WHEN** the adapter has mapping code for a capability but no conformance run and no live session
- **THEN** `implementedByAdapter` is `true` and both other layers remain `false`

### Requirement: Events carry an adapter-assigned monotonic sequence and their raw frame
Each event SHALL carry a per-session monotonic `seq` assigned by the adapter rather than by any harness clock, and SHALL retain the raw native frame verbatim.

#### Scenario: Multiple events in one session
- **WHEN** an adapter emits several events for one session
- **THEN** their `seq` values strictly increase in emission order

#### Scenario: An unmodelled native frame arrives
- **WHEN** a frame does not match any known event kind
- **THEN** it is surfaced as a `passthrough` event whose `native` field holds the original frame, and no data is dropped

### Requirement: The error taxonomy carries a class and an origin axis
A normalized harness error SHALL carry both a closed `class` and an `origin` axis (`adapter`, `harness`, `provider`, or `transport`), and SHALL record whether retryability was signalled by the harness or inferred.

#### Scenario: A provider-side error is normalized
- **WHEN** the harness reports a rate limit or budget error
- **THEN** the normalized error names the class, sets `origin` to `provider`, and records the retryability source
