# protocol-session Specification

## Purpose

A transport-neutral session layer in `packages/protocol` so independently-updating clients and the Rennet daemon can coexist: a handshake that exchanges identity and capability, an envelope that correlates requests with responses and carries typed errors and server-push events, and a written versioning discipline that every later wire change obeys.

## ADDED Requirements

### Requirement: Handshake exchanges identity and capability

The protocol SHALL define a `hello` frame (client → server) carrying `clientId`, `clientType`, and the client's `protocolVersion`, and a `serverInfo` frame (server → client) carrying the server's `version`, `protocolVersion`, `minCompatibleProtocolVersion`, and a `features` record of boolean flags.

#### Scenario: hello and serverInfo round-trip

- **WHEN** a `hello` or `serverInfo` frame is serialized to JSON and parsed back through the session-frame parser
- **THEN** parsing succeeds and every declared field survives intact

#### Scenario: features is an open record

- **WHEN** a `serverInfo` frame carries a feature key the client's build has never heard of
- **THEN** the frame still parses and the unknown feature is simply present in the record

### Requirement: Envelope correlates requests, responses, and errors

The protocol SHALL define a `request` frame carrying `requestId`, a `command` name validated against the existing command registry, and the command input; a `response` frame carrying the matching `requestId` and output; and an `rpcError` frame carrying the `requestId`, a string `code`, a human-readable `message`, and optional `details`. Command input/output payloads SHALL remain validated by `commandDefinitions` (single authority), not duplicated into the envelope.

#### Scenario: a request names a real command

- **WHEN** a `request` frame's `command` is not a name in `commandDefinitions`
- **THEN** parsing the frame fails

#### Scenario: errors are typed frames, not throws

- **WHEN** an `rpcError` frame is parsed
- **THEN** it yields `requestId`, `code`, and `message` as typed fields
- **AND** both a documented code and a novel string code are accepted

### Requirement: Server-push events reuse the existing payload types

The protocol SHALL define a progress event frame keyed by `commandId` whose payload is the existing `ProjectProcessEvent`, and an ask-stream event frame keyed by `reviewId` whose payload is the existing `ReviewAskStreamEvent`. These payload types SHALL be reused by reference, never forked or copied.

#### Scenario: push frames carry the existing event types

- **WHEN** a progress or ask-stream event frame is built from an existing event value and round-tripped
- **THEN** the parsed payload deep-equals the original event

### Requirement: One protocol version with an explicit compatibility window

The protocol SHALL export a single integer `PROTOCOL_VERSION` and a `MIN_COMPATIBLE_PROTOCOL_VERSION`, and a compatibility check helper that, given both peers' version pairs, returns a compatible/incompatible result with a stated reason when incompatible.

#### Scenario: versions inside the window are compatible

- **WHEN** each peer's version is at or above the other's minimum compatible version
- **THEN** the helper reports compatible

#### Scenario: a version outside the window is refused with a reason

- **WHEN** one peer's version is below the other's minimum compatible version
- **THEN** the helper reports incompatible with a reason naming which side is too old

### Requirement: Inbound frames tolerate unknown fields by construction

Every session frame schema SHALL accept and strip unknown fields (tolerant decoding), so a newer peer adding an optional field never breaks an older decoder. This SHALL be pinned by test, not asserted in prose.

#### Scenario: an unknown field does not break parsing

- **WHEN** any session frame arrives with an extra field unknown to this build
- **THEN** parsing succeeds and the unknown field is stripped from the parsed value

### Requirement: The versioning discipline is written law

The documentation SHALL carry a `protocol-compatibility` reference page stating: wire schemas evolve append-only (new fields optional; never narrow, remove, or make required); new capabilities are gated once on `serverInfo.features.*` with no fallback paths; compatibility shims are tagged `COMPAT(name)` with a removal date; inbound decoders are tolerant. The page SHALL be registered in the docs sidebar and linked from the app server plan.

#### Scenario: the discipline is documented and reachable

- **WHEN** a developer reads the docs Reference section after this change
- **THEN** the protocol-compatibility page exists, states the append-only, feature-flag, COMPAT, and tolerant-decoder rules, and is linked from the app server plan page
