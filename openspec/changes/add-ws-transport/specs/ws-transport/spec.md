# ws-transport Specification

## Purpose

The Rennet server listens on a loopback WebSocket speaking the protocol session envelope; a browser-safe `WsRennetBridge` implements the `RennetBridge` interface over that socket; the Electron renderer is the first client of the real wire, and the bespoke IPC invoke path no longer exists.

## ADDED Requirements

### Requirement: The server speaks the session envelope over loopback WS

The server SHALL accept WebSocket connections on `127.0.0.1` (ephemeral port, exposed on the server handle), and on each connection: complete a `hello`/`serverInfo` handshake (rejecting an incompatible client protocol version with a typed `rpcError`), route `request` frames to the same dispatch used in-process (with per-connection progress/ask-stream sinks and the connection identity as the progress recipient id), and answer with `response` or `rpcError` frames correlated by `requestId`. A malformed inbound frame SHALL produce an `rpcError` without closing the connection.

#### Scenario: request round-trips over the wire

- **WHEN** a connected, handshaken client sends a `request` for a valid command
- **THEN** it receives a `response` with the same `requestId` and the command's output, identical to what the in-process dispatch returns

#### Scenario: a command failure is a typed error frame

- **WHEN** a dispatched command throws
- **THEN** the client receives an `rpcError` with the same `requestId` and the error message

#### Scenario: progress reaches the invoking socket

- **WHEN** a client invokes a progress-emitting command with a `commandId`
- **THEN** progress event frames for that `commandId` are delivered to that client's socket while the command runs

#### Scenario: broadcast progress reaches every socket

- **WHEN** the server emits background (rehydration) progress
- **THEN** every connected client receives the progress frames

### Requirement: WsRennetBridge is a faithful RennetBridge over the wire

`packages/client` SHALL export a browser-safe `WsRennetBridge` (global `WebSocket`, no Node imports) implementing `invoke` (requestId correlation; rejects with an `Error` carrying the `rpcError` message), `onProgress`/`onAskStream` (keyed listeners with working unsubscribe), and reconnecting with capped backoff and a fresh handshake after connection loss; in-flight invokes at disconnect SHALL reject rather than hang.

#### Scenario: interleaved invokes resolve independently

- **WHEN** two invokes are in flight concurrently
- **THEN** each resolves with the output matching its own request, regardless of response order

#### Scenario: disconnect fails fast, reconnect restores service

- **WHEN** the socket drops while an invoke is in flight
- **THEN** that invoke rejects promptly
- **AND** after the bridge reconnects and re-handshakes, a new invoke succeeds

### Requirement: The renderer is client #1 and the IPC invoke path is gone

The Electron renderer SHALL perform all command invocation and stream subscription through `WsRennetBridge`. The `rennet:invoke` IPC handler, the progress/ask-stream `webContents.send` channels, and the preload invoke/stream plumbing SHALL NOT exist. The preload SHALL expose only `platform`, the WS port, and the Electron-native menu members. `packages/ui` SHALL be unchanged.

#### Scenario: the app works entirely over WS

- **WHEN** the desktop app boots and the user exercises the existing e2e journeys (add project, local review, review canvases)
- **THEN** all pass with zero e2e edits, with every command travelling the WS wire

#### Scenario: the deleted channels have no live references

- **WHEN** the codebase is searched for the invoke and push channel names
- **THEN** no live (non-menu) references remain

### Requirement: Transport contract survives multiple clients

Two simultaneous client connections SHALL be independently served: each completes its own handshake, invokes commands, and receives its own correlated responses and subscribed events; one client disconnecting mid-stream SHALL not disturb the other, and the disconnected client SHALL be able to reconnect and recover persisted review threads via `review.reattach`.

#### Scenario: two clients, independent streams

- **WHEN** clients A and B are connected and A invokes a streaming command
- **THEN** A receives its stream, B's connection is unaffected, and broadcasts reach both

#### Scenario: reattach after drop

- **WHEN** a client drops mid-turn and reconnects
- **THEN** `review.reattach` returns the persisted threads for the review, matching pre-WS reload semantics
