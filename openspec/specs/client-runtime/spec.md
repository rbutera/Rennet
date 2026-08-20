# client-runtime Specification

## Purpose
Defines the shared client connection runtime for desktop, browser, and mobile clients. It reports reachability, restores subscriptions after reconnection, persists device tokens through an injected store, and exposes last-known state while offline.
## Requirements
### Requirement: Reachability is a truthful, subscribable state machine

The runtime SHALL expose each daemon's connection state as `idle`, `connecting`, `online`, `offline`, or `error`, and notify subscribers on every transition. `online` SHALL mean that the transport is open and the protocol handshake has completed. A lost connection SHALL set `offline` while retry continues. A fatal condition such as rejected authentication SHALL set `error` with the cause and stop retrying.

#### Scenario: state reflects a dropped socket

- **WHEN** an `online` connection's socket closes unexpectedly
- **THEN** subscribers observe `offline`, retry begins with capped exponential backoff, and subscribers observe `online` again once the handshake completes

#### Scenario: auth rejection is terminal, not retried

- **WHEN** the daemon rejects the connection's device token
- **THEN** the state becomes `error` carrying the rejection cause, and the runtime does not keep retrying with the same rejected token

### Requirement: Reconnection restores every live subscription

The runtime SHALL track every active push subscription, including ask streams keyed by review and progress streams keyed by command. After a reconnect, it SHALL re-establish each subscription on the new socket without caller involvement. A stream consumer created before a network interruption SHALL continue receiving events after it.

#### Scenario: mid-turn ask stream survives a reconnect

- **WHEN** a turn is streaming over `onAskStream` and the socket drops and reconnects
- **THEN** subsequent turn events for that review are delivered to the same subscriber without a new subscribe call from the consumer

#### Scenario: no duplicate delivery after resubscribe

- **WHEN** a subscription is re-established after reconnect
- **THEN** the consumer observes each event at most once (events emitted while disconnected are recovered by state reconciliation, not by stream replay from the consumer's perspective doubling up)

### Requirement: Commands fail honestly across disconnection

An `invoke` issued while the connection is not `online` SHALL either be queued for the reconnected socket or rejected with a distinguishable connection error, per the runtime's declared mode; an in-flight `invoke` whose socket drops SHALL reject with a connection error rather than hanging indefinitely.

#### Scenario: in-flight invoke on a dropped socket

- **WHEN** an invoke has been sent and the socket closes before its response arrives
- **THEN** the invoke's promise rejects with an error identifying the connection loss, and the caller can retry after `online`

### Requirement: Device tokens live behind an injected store

The runtime SHALL persist and present device tokens through an injected storage interface. Desktop and browser clients SHALL use their saved connection storage, while mobile SHALL use the platform keychain. The runtime SHALL NOT read or write token material through another path, and token values SHALL never appear in logs or error messages.

#### Scenario: shells swap stores without behavior change

- **WHEN** the same runtime is constructed with two different token store implementations
- **THEN** connection and authentication behavior is identical, and only the storage location differs

### Requirement: Last-known state paints before the socket opens

For a daemon the client has connected to before, the runtime SHALL provide the last-known replica of projected state before any socket opens. Once `online`, it SHALL reconcile that replica against the daemon by cursor. The client SHALL mark the replica as stale until reconciliation completes.

#### Scenario: offline open shows the replica

- **WHEN** the client opens while its daemon is unreachable
- **THEN** the previously synced state is available to render, the connection state reads `offline` (never `online`), and no data is silently fabricated

### Requirement: Presence is reported through a runtime seam

The runtime SHALL accept focus, visibility, and device-class presence signals from its shell. It SHALL transmit them to a connected daemon that advertises attention and presence support in its handshake capabilities. If the daemon does not advertise the capability, the runtime SHALL record the state locally and send no presence traffic.

#### Scenario: presence transmits when advertised

- **WHEN** the shell reports presence and the connected daemon advertised the attention capability
- **THEN** the runtime sends the presence frame and re-sends current presence after every reconnect

#### Scenario: Presence stays local without daemon support

- **WHEN** the connected daemon did not advertise the capability
- **THEN** the runtime records the presence state locally and sends nothing

### Requirement: All client shells use the runtime without changing commands or streams

Desktop and browser clients SHALL construct their daemon connections through the runtime. The same commands SHALL succeed and the same streams SHALL deliver through both clients.

#### Scenario: Client end-to-end tests use the shared runtime

- **WHEN** desktop and browser end-to-end suites exercise daemon commands and streams
- **THEN** both clients pass through the shared runtime and preserve their command and stream behavior
