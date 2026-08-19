# client-runtime Specification

## Purpose
The shared client connection runtime every Rennet UI shell (desktop renderer, browser tab, native mobile) uses to reach a daemon: connection supervision with truthful reachability state, reconnection that restores every live subscription, device-token persistence behind an injected store, and last-known-state painting so an opening client is never blank.
## Requirements
### Requirement: Reachability is a truthful, subscribable state machine

The runtime SHALL expose per-daemon connection state as one of `idle`, `connecting`, `online`, `offline`, or `error`, and SHALL notify subscribers on every transition. `online` SHALL mean the transport is open and the protocol handshake has completed; a lost connection SHALL surface as `offline` while retry continues; a fatal condition (such as rejected authentication) SHALL surface as `error` with the cause, and SHALL NOT be silently retried into.

#### Scenario: state reflects a dropped socket

- **WHEN** an `online` connection's socket closes unexpectedly
- **THEN** subscribers observe `offline`, retry begins with capped exponential backoff, and subscribers observe `online` again once the handshake completes

#### Scenario: auth rejection is terminal, not retried

- **WHEN** the daemon rejects the connection's device token
- **THEN** the state becomes `error` carrying the rejection cause, and the runtime does not keep retrying with the same rejected token

### Requirement: Reconnection restores every live subscription

The runtime SHALL track every active push subscription (ask streams keyed by review, progress streams keyed by command) and, after a reconnect, SHALL re-establish each one on the new socket without caller involvement, so a stream consumer created before a network interruption continues receiving events after it. This closes the liveness gap where a mid-turn reconnect left the live ask stream unbound (issue #389).

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

The runtime SHALL persist and present device tokens through an injected storage interface, so each shell supplies its platform's store (config file on desktop and browser shells; platform keychain on mobile). The runtime SHALL NOT read or write token material through any other path, and token values SHALL never appear in logs or error messages.

#### Scenario: shells swap stores without behavior change

- **WHEN** the same runtime is constructed with two different token store implementations
- **THEN** connection and authentication behavior is identical, and only the storage location differs

### Requirement: Last-known state paints before the socket opens

For a daemon the client has connected to before, the runtime SHALL provide the last-known replica of projected state immediately on startup — before any socket opens — and SHALL reconcile it against the daemon by cursor once `online`, so an opening client renders a readable (and honestly stale-marked) record rather than a blank screen.

#### Scenario: offline open shows the replica

- **WHEN** the client opens while its daemon is unreachable
- **THEN** the previously synced state is available to render, the connection state reads `offline` (never `online`), and no data is silently fabricated

### Requirement: Presence is reported through a runtime seam

The runtime SHALL accept focus/visibility/device-class presence signals from its shell and SHALL transmit them to a connected daemon that advertises attention/presence support in its handshake capabilities. Against a daemon that does not advertise the capability, the seam SHALL remain a well-defined no-op that alters no protocol traffic — M0-era daemons are unaffected.

#### Scenario: presence transmits when advertised

- **WHEN** the shell reports presence and the connected daemon advertised the attention capability
- **THEN** the runtime sends the presence frame and re-sends current presence after every reconnect

#### Scenario: presence updates are accepted and inert today

- **WHEN** the connected daemon did not advertise the capability
- **THEN** the runtime records the presence state locally and sends nothing — the seam stays inert exactly as it was against every pre-attention daemon

### Requirement: Shell adoption is behavior-neutral

Adopting the runtime in the existing desktop and browser shells SHALL NOT change any externally observable behavior: the same commands succeed, the same streams deliver, and the existing end-to-end suites pass unchanged (except where a suite is extended to cover the newly fixed reconnect-resubscribe behavior).

#### Scenario: existing e2e is the proof

- **WHEN** the desktop and browser shells are switched to construct their connection through the runtime
- **THEN** the pre-existing e2e suites pass without behavioral amendment

