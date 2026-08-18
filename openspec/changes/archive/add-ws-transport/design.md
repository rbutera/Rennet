# Design — add-ws-transport (#378)

## Context

Recon facts (verified at main f66a45c, pre-phase-1; phase-1 relocations shift the `apps/desktop/src/main/index.ts` sites into `packages/server` — re-locate them, the shapes are identical):

- The transport seam is `registerCommandHandler` (pre-move index.ts:1639-1687): origin-gate → extract `commandId`/`reviewId` → build `emitProgress` (`event.sender.send("rennet:progress", {commandId, event})`) and `emitAskStream` sinks → `dispatch(name, input, {emitProgress, progressRecipientId: event.sender.id, emitAskStream})`. A WS connection reproduces exactly this, with the connection id as `progressRecipientId` (keeps the 256-event `LiveProjectRun` replay dedup working, dispatch.ts:463-527).
- Preload (62 lines) exposes `window.rennet`: `invoke`, `platform`, `onProgress`/`onAskStream` (shared channel + per-id filtering), `updateMenu`/`onMenuRun`. On `RennetBridge`, only `invoke` is required; all else optional.
- The renderer obtains the bridge at ONE point: `renderer/index.tsx:16` `<RennetApp bridge={window.rennet} />`. `packages/ui` never reads globals — bridge is a prop. Bridge swap is a composition-point change only.
- CSP (renderer/index.html:5-8): `connect-src 'self'` — BLOCKS `ws://127.0.0.1:*` until amended. webPreferences: contextIsolation, sandbox, no nodeIntegration — preload stays the only injection channel; precedent favors preload-injected config (recon Q10).
- Loopback listener precedent: `canvas-ops-external.ts` — `node:http` on `127.0.0.1`, port 0, read real port from `address()`, `close()` teardown.
- `ws@8.21.1` already resolved in the lockfile (transitive via happy-dom); no workspace package declares it. Dependency Standard: exact pins, buy-what-removes-a-subsystem.
- Ask-stream is live-only by design (no token backlog; `review.reattach` returns persisted threads, inFlight always empty). Progress has the bounded 256-event replay inside `createDispatch`. Do not add new replay machinery.
- Session layer (phase 0) exports everything needed: frame schemas, `parseSessionFrame`, `PROTOCOL_VERSION`, `MIN_COMPATIBLE_PROTOCOL_VERSION`, `checkProtocolCompatibility`.

## Goals / Non-Goals

**Goals:**

- One wire, exercised by the desktop app daily. Delete the IPC invoke path entirely — no shim, no dual transport.
- The WS layer is dumb: parse frame → route to the same `dispatch` → serialize result. All behavior stays in the server; the transport adds correlation and fan-out only.
- Reconnect is a client-side concern with working resubscribe; the desktop renderer must survive a server hiccup the same way a future browser tab must.

**Non-Goals:**

- No auth on the loopback socket this phase (phase 4 brings pairing/device tokens; loopback + ephemeral port is the same posture as the in-repo canvas-ops listener). No non-loopback bind. No TLS.
- No ask-stream backlog/replay changes. No new subscription registry beyond topic→sockets maps.
- No serving HTTP content (phase 5). No daemon (phase 3).
- No change to `packages/ui`.

## Decisions

**D1 — Envelope on the wire is exactly the phase-0 `sessionFrameSchema`, JSON text frames.** Inbound: `parseSessionFrame` on every message; a frame that fails parse gets an `rpcError` (code `invalid_input`, requestId if recoverable, else correlation-less) and the connection stays open. Handshake: client sends `hello` first; server replies `serverInfo` (`features: {}` for now); server checks `hello.protocolVersion >= MIN_COMPATIBLE_PROTOCOL_VERSION` and rpcErrors with `incompatible_protocol` if not (per the protocol-compatibility page's division of checks). Requests before `hello` are answered with `rpcError` (the handshake is sequencing, not a consent gate — one frame, no user interaction).

**D2 — Server: `ws` (exact-pinned 8.21.1) in `packages/server`, `WebSocketServer({ server })` attached to a `node:http` server bound `127.0.0.1:0`** (canvas-ops pattern). The server handle from phase 1 grows: `wsPort: number` (resolved at create) and the listener closes in `shutdown()`. Listener starts inside `createRennetServer` — the desktop shell needs the port before window load, and a server that exists but isn't listening serves nobody (YAGNI on a separate `listen()` step).

**D3 — Per-connection state is two maps + a hello flag.** `progressSubs: Map<commandId, true>`, `askSubs: Map<reviewId, true>` (subscription = the client sent a `subscribe` intent? NO —) Subscriptions are implicit: a `request` whose input carries `commandId` auto-wires that command's progress to the requesting socket (exactly what IPC did — the invoker got the events), and an explicit lightweight `subscribe` frame is NOT invented this phase. Instead `WsRennetBridge.onProgress(commandId)`/`onAskStream(reviewId)` register client-side listeners, and the server pushes progress/ask-stream events for a given key to every socket that has invoked with that key **plus** — for the reload/reattach case — any socket that sends a `request` for `review.reattach`/re-invokes with the same key. Concretely: the server keys sinks by connection at invoke time (today's semantics, preserved); the rehydration broadcast (`broadcastProgress` option from phase 1) fans out to ALL connected sockets (today: all windows). This preserves observable behavior with zero new protocol surface. If phase 5 needs cross-client subscription, it adds a `subscribe` frame via `serverInfo.features` then.

**D4 — `WsRennetBridge` (new `packages/client`, browser-safe, global `WebSocket`):**
- `invoke`: assign `requestId` (crypto.randomUUID), send `request`, resolve on matching `response`, reject on matching `rpcError` (an `Error` whose message is the frame's `message` — same surface the renderer gets from IPC today).
- `onProgress(commandId, listener)` / `onAskStream(reviewId, listener)`: local key→listeners maps; incoming push frames route by key. Returns unsubscribe.
- Reconnect: on close, exponential backoff (capped, e.g. 0.5s→8s), re-`hello` on reopen. In-flight invokes reject on close (callers already handle command failure). Listener maps survive reconnect (resubscribe is client-side state; the streams they watch are live-only, matching today's reload semantics).
- Constructor takes `{ url }` (or port). No queueing of invokes while disconnected (ponytail: callers see a failed command exactly as they would a thrown dispatch — no new buffering semantics).
Invokes issued while the socket is CONNECTING (including the moment a reconnect attempt starts) wait for the handshake; invokes issued while the connection is closed or in backoff reject immediately.

**D5 — Preload shrinks to `{ platform, wsPort, updateMenu, onMenuRun }`.** Electron main passes the port to the preload via `process.argv` extra arg or `additionalArguments` (webPreferences) — the established pattern for boot-time constants under contextIsolation — and the preload exposes it. Renderer composition builds the final bridge: `{...new WsRennetBridge({port}), platform, updateMenu, onMenuRun}` merge. `RennetBridge` interface itself is unchanged.

**D6 — CSP `connect-src` gains `ws://127.0.0.1:*`** in renderer/index.html. Wildcard port because the port is ephemeral. Loopback-only origin, matching the bind.

**D7 — Architecture edges: new package `packages/client`, tag `layer:client`.** check-boundaries.mjs: `@rennet/client → {@rennet/types, @rennet/protocol}`. eslint: `layer:client → [types, protocol, client]`; `layer:app` gains `layer:client`. `packages/ui` does NOT gain the edge (it never imports the bridge — prop-injected).

**D8 — The multi-socket test is the transport's contract test** (in `packages/server`): two `WsRennetBridge` clients connect; both hello; client A invokes a progress-emitting command; A receives progress; B invokes with the same commandId key path where applicable / receives broadcast frames; A drops mid-stream, reconnects, re-invokes `review.reattach`, gets persisted threads. Use a real listener on 127.0.0.1:0 with a stub dispatch — the test pins framing, correlation, fan-out, and reconnect, not command behavior (dispatch has its own 3,854-line suite).

## Risks / Trade-offs

- **Risk: listener-before-renderer ordering.** Mitigation: `createRennetServer` resolves only after `listening`; the shell creates the window after the server handle exists (today's whenReady order already does composition before `createWindow`).
- **Risk: silent behavior drift in per-recipient progress replay.** The connection id replaces `event.sender.id` as `progressRecipientId`; the replay dedup semantics are pinned by existing dispatch tests — do not modify dispatch.
- **Trade-off (D3): no generic subscribe frame** means a second client cannot watch a stream it didn't start, beyond broadcasts. That is exactly today's per-window behavior; the wave adds cross-client subscription when a phase needs it, gated on `serverInfo.features`.
- **Trade-off (D4): no offline invoke queueing** — a command issued during a reconnect window fails visibly. Identical to today's behavior if main dies; honest failure beats silent buffering.
