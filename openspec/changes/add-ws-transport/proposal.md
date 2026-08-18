# WebSocket transport: the renderer becomes client #1 (#378)

## Why

Phase 1 (#377) put the runtime behind `createRennetServer()`; the Electron renderer still reaches it through hand-rolled IPC plumbing (`ipcMain.handle("rennet:invoke")`, two push channels, per-id listener filtering in the preload). Every future client — browser (#381), CLI (#379), mobile (#383) — needs a network transport speaking the Phase 0 envelope. Rai's accepted call: the renderer moves to WS rather than keeping an IPC shim — one transport to maintain, and the desktop app permanently exercises the exact client path every other client will use. From this phase on, a transport bug is a desktop bug, caught immediately, not a latent browser-client bug.

## What Changes

- **WS listener in `packages/server`**: loopback (`127.0.0.1`), ephemeral port (the `canvas-ops-external.ts` precedent: port 0, read back from `address()`), speaking the Phase 0 session frames as JSON text frames. Per connection: `hello`/`serverInfo` handshake, `request` → the server's existing `dispatch` with per-connection `emitProgress`/`emitAskStream` sinks (reproducing exactly the shape `registerCommandHandler` builds today, with the connection identity as `progressRecipientId` so the 256-event progress replay dedup keeps working), `response`/`rpcError` back, push frames fanned out to the sockets subscribed to that `commandId`/`reviewId` topic.
- **`WsRennetBridge` in a new browser-safe `packages/client`** (`@rennet/client`, imports only `types` + `protocol`, uses the global `WebSocket` — no Node imports): implements `RennetBridge` (`invoke` with requestId correlation, `onProgress`/`onAskStream` topic subscriptions), reconnect with backoff, resubscribe on reconnect. `updateMenu`/`onMenuRun` are simply absent (they are optional members — Electron-native concerns).
- **Renderer swaps bridges at its one composition point** (`renderer/index.tsx`): construct `WsRennetBridge` from the port the preload injects, keep `platform` and the menu members from the preload bridge (a thin merge: WS for commands/streams, preload residue for menu/platform).
- **Deleted**: `ipcMain.handle("rennet:invoke")` and its origin gate, the `rennet:progress`/`rennet:ask-stream` `webContents.send` channels, the preload `invoke` forwarder and per-id listener filtering. Preload shrinks to: `platform`, `wsPort`, `updateMenu`, `onMenuRun`.
- **CSP**: renderer `index.html` `connect-src` gains `ws://127.0.0.1:*` (today `'self'` blocks the socket — recon-verified).
- **New direct dependency `ws`** (exact pin at the version already resolved in the lockfile, 8.21.1) in `packages/server`. Node has no built-in WS *server*; hand-rolling RFC 6455 framing is exactly the subsystem the Dependency Standard says to buy, not build. The client side uses the platform-global `WebSocket` (browser/Electron renderer/Node ≥22) — no client dep.
- **Docs same-change**: `architecture-overview.md` transport section; `reactive-streams.md` (the push seam is now WS topics); `protocol-compatibility.md` gains the "first live transport" note if wording requires.

**Explicitly out of scope**: non-loopback bind, auth/pairing/device tokens (phase 4 — loopback is a default, not a lock), the detached daemon (phase 3), serving the UI bundle over HTTP (phase 5), ask-stream token backlog (reattach semantics stay exactly as today: persisted threads via `review.reattach`, live-only streams).

## Capabilities

### New Capabilities

- `ws-transport`: the server's loopback WS listener speaking the phase-0 envelope (handshake, request/response/rpcError, topic-keyed push fan-out, multi-socket), and the browser-safe `WsRennetBridge` client (requestId correlation, reconnect + resubscribe) that the Electron renderer now uses as client #1.

### Modified Capabilities

- `server-package`: the server handle grows the WS listener lifecycle (start on create or explicit `listen()`, port in server state, closed by `shutdown()`).

## Impact

- **`packages/server`** — WS listener module + tests; `ws` dependency; handle exposes `wsPort`.
- **`packages/client`** — new package (browser-safe); `WsRennetBridge` + tests; architecture edges client → {types, protocol} in both enforcers; `layer:app` gains `layer:client`.
- **`apps/desktop`** — preload shrinks; `index.ts` deletes the invoke/push IPC wiring, injects the port; renderer composition swaps bridges; `index.html` CSP.
- **`packages/ui`** — untouched (the bridge is a prop; recon-verified single composition point).
- **e2e** — untouched and green: the harness boots the real app and drives only the UI; the renderer must connect on boot (listener starts before window load).
