# Tasks — add-ws-transport (#378)

## 1. Server: WS listener

- [x] 1.1 Add `ws` (exact pin, the lockfile-resolved 8.21.1) + `@types/ws` (dev) to `packages/server`.
- [x] 1.2 `packages/server/src/ws-listener.ts`: `node:http` server bound `127.0.0.1:0` + `WebSocketServer({server})`; per-connection: hello→serverInfo handshake (version check per protocol-compatibility page; `features: {}`), `parseSessionFrame` on every inbound message, `request` → the server's `dispatch` with per-connection `emitProgress`/`emitAskStream` sinks and the connection id as `progressRecipientId`, `response`/`rpcError` frames back; malformed frame → `rpcError`, connection stays open; requests before hello → `rpcError`. Rehydration `broadcastProgress` fans out to all connected sockets.
- [x] 1.3 Server handle: `wsPort` exposed; `createRennetServer` resolves after `listening`; `shutdown()` closes the listener (idempotent still).

## 2. Client: `packages/client` + WsRennetBridge

- [x] 2.1 Scaffold `packages/client` (`@rennet/client`, browser-safe: no Node imports, global `WebSocket`; deps `@rennet/types`, `@rennet/protocol`; tags `["scope:rennet","layer:client"]`; targets like other packages).
- [x] 2.2 Architecture edges in BOTH enforcers: check-boundaries.mjs `@rennet/client → {types, protocol}`; eslint `layer:client → [types, protocol, client]`, `layer:app` += `layer:client`.
- [x] 2.3 `WsRennetBridge` per design D4: invoke with requestId correlation (resolve response / reject rpcError-as-Error), onProgress/onAskStream keyed listener maps with unsubscribe, reconnect with capped exponential backoff + re-hello, in-flight invokes reject on close, no offline queueing.
- [x] 2.4 Unit tests against a stub WS server: correlation (two interleaved invokes resolve to their own outputs), rpcError rejection, push routing by key, unsubscribe stops delivery, reconnect + re-hello.

## 3. Desktop swap + deletion

- [x] 3.1 Electron main: delete `ipcMain.handle("rennet:invoke")` wiring and the progress/ask-stream `webContents.send` push code; pass `wsPort` to preload via `webPreferences.additionalArguments` (or process.argv extra) per D5.
- [x] 3.2 Preload shrinks to `{ platform, wsPort, updateMenu, onMenuRun }`; delete the invoke forwarder and per-id listener filtering; delete the now-unused channel constants.
- [x] 3.3 Renderer composition (`renderer/index.tsx`): build bridge = WsRennetBridge({port: window.rennet.wsPort}) merged with preload's platform/updateMenu/onMenuRun; `packages/ui` untouched.
- [x] 3.4 CSP in `renderer/index.html`: `connect-src 'self' ws://127.0.0.1:*`.
- [x] 3.5 Grep-proof the deletion: no live references to `rennet:invoke`, `rennet:progress`, `rennet:ask-stream` outside menu channels (negative conclusion WITHOUT piping through head).

## 4. Contract test (multi-socket)

- [x] 4.1 Per design D8: two clients handshake; invoke + progress delivery to the invoker; broadcast fan-out reaches both; disconnect mid-stream → reconnect → `review.reattach` returns persisted threads (stub dispatch). Framing/correlation/fan-out pinned, not command behavior. **Lives in `apps/desktop/src/ws-contract.test.ts`, not `packages/server`:** the test uses BOTH the real listener and the real `@rennet/client` bridge, and the dependency arrows forbid `packages/server` importing `@rennet/client` — `apps/desktop` (layer:app) is the only layer permitted to import both. `startWsListener` is exported from `@rennet/server` for this.

## 5. Proof

- [x] 5.1 `NX_DAEMON=false pnpm check` green.
- [x] 5.2 e2e UNTOUCHED and green (real app boots, renderer connects over WS). If an e2e edit seems needed, STOP and report.

## 6. Docs (same change)

- [x] 6.1 `developing/concepts/architecture-overview.md`: transport section (WS loopback, envelope, client #1).
- [x] 6.2 `developing/reference/reactive-streams.md`: push seam is WS topics now.
- [x] 6.3 `developing/reference/app-server-plan.md` phase 2 wording if the page tracks status. **No edit needed:** the page is a forward plan with no per-phase status markers, and its Phase 2 paragraph already describes the shipped design accurately (WS loopback listener, `WsRennetBridge`, deleting the `ipcMain.handle`/`webContents.send` pair, IPC remaining only for menu/platform).
