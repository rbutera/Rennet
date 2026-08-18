# remote-surface Specification

## Purpose

A paired client anywhere on the user's network (Tailscale-first) holds a live, full-capability review session against the daemon, receiving the R19 recipient-specific projection: no host-absolute path or raw event envelope ever crosses to a remote connection, in either direction. Loopback clients keep the private contract untouched. Pairing is a one-time bootstrap; the public contract is a checked-in, drift-tested JSON-Schema artifact.

## ADDED Requirements

### Requirement: Connections are classified once, at handshake

The listener SHALL classify every connection when `hello` arrives: loopback connections are `private` (existing contract, no token required); non-loopback connections presenting a valid device token are `projected`; non-loopback connections without a valid token may invoke exactly one command — the pairing exchange — and nothing else. The class SHALL NOT change for the connection's lifetime.

#### Scenario: loopback needs nothing

- **WHEN** a client connects from the loopback address without a token
- **THEN** it gets the full private contract exactly as before this change

#### Scenario: unpaired remote can only pair

- **WHEN** a token-less client connects from a non-loopback address
- **THEN** any request other than the pairing exchange is answered with a typed error

### Requirement: The projection scrubs paths in both directions

For `projected` connections, every structural host-absolute path field in responses and pushed events SHALL be replaced by a repo reference (`repoKey`, `displayName`, optional relative path) or repo-relative form, and free-text fields SHALL have known repository roots and the home directory substituted with display tokens. Inbound command inputs carrying host paths SHALL accept repo references, resolved server-side; an unresolvable reference SHALL produce a typed input error, never a guessed path. Capability parity holds: every command available to a private connection SHALL be available to a projected connection.

#### Scenario: no host path crosses outbound

- **WHEN** a projected client drives a review (capture, canvases, dispositions, progress events)
- **THEN** a sweep of every serialized frame finds no host-absolute path (home directory or repository root prefixes)

#### Scenario: the sweep itself is proven able to fail

- **WHEN** a deliberate path leak is injected into a response in the test harness
- **THEN** the sweep fails (positive control)

#### Scenario: inbound references resolve exactly

- **WHEN** a projected client invokes a command using a repo reference obtained from earlier responses
- **THEN** the daemon resolves it to the same repository a private client would have named by absolute path, and an unknown reference yields a typed error

### Requirement: Pairing is a one-time bootstrap

The daemon SHALL mint single-use, short-lived pairing codes on request (desktop settings panel and `rennet pair`); exchanging a valid code SHALL yield a long-lived device token (sliding expiry, refreshed on use) stored hashed at rest; a paired device SHALL connect and work with no further ceremony. Devices SHALL be listable and revocable (settings panel and CLI); a revoked or expired token SHALL simply fail the handshake, leaving pairing available.

#### Scenario: pair once, works after

- **WHEN** a device exchanges a valid code and reconnects later with its token
- **THEN** the handshake succeeds with no additional prompt on either side

#### Scenario: revocation takes effect at next handshake

- **WHEN** a device is revoked and its token is presented again
- **THEN** the handshake is refused and the pairing path remains available

### Requirement: Non-loopback bind is explicit configuration

The listener SHALL bind loopback by default; a `daemon.listen` config key SHALL opt into a specific host (and optionally port). For non-loopback binds, HTTP requests whose Host header does not match the configured host, its address literals, or localhost SHALL be refused before upgrade. The discovery file and `rennet status` SHALL reflect the bound host and port. Documentation SHALL present Tailscale as the remote path; no relay exists.

#### Scenario: default stays loopback

- **WHEN** no listen config is set
- **THEN** the daemon binds loopback exactly as before

#### Scenario: rebinding guard

- **WHEN** the daemon is bound beyond loopback and a request arrives with a foreign Host header
- **THEN** it is refused before the WebSocket upgrade

### Requirement: The public contract is a checked-in artifact

The projected contract's JSON Schemas SHALL be generated from the private Zod contract, checked in as fixtures, and guarded by a drift test that fails when regeneration differs from the fixtures. A host-path-typed field added to the private contract without a projection entry SHALL fail loudly, not silently pass through.

#### Scenario: drift is loud

- **WHEN** the private contract changes in a way that alters the projection
- **THEN** the drift test fails until the fixtures are regenerated and reviewed

#### Scenario: new path fields cannot slip through

- **WHEN** a command gains a host-path field with no projection table entry
- **THEN** a test fails naming the field

### Requirement: Server-initiated requests exist on the wire, feature-flagged

The session protocol SHALL define server→client request, client response, and resolved-cleanup frames, advertised via `serverInfo.features.serverRequests`; the listener SHALL expose a helper that asks a specific connection and cleans up on resolution or disconnect; the client bridge SHALL expose a handler seam. No product flow consumes them this phase (first consumer arrives with the client that needs turn asks); the wire contract SHALL be pinned by tests now so future clients build against files, not guesses.

#### Scenario: request round-trip and cleanup

- **WHEN** the server asks a connection and the client's handler answers
- **THEN** the helper resolves with the answer and a resolved frame is delivered
- **AND** a disconnect instead rejects the helper and resolves nothing twice
