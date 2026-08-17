// @rennet/client — the browser-safe transport clients (issue #378, app server wave
// phase 2). Imports only @rennet/protocol (the session envelope + RennetBridge
// contract); no Node imports, so the same bundle runs in the Electron renderer, a
// browser tab, or Node ≥22 (all provide a global `WebSocket` and `crypto.randomUUID`).
export { WsRennetBridge, type WsRennetBridgeOptions } from "./ws-bridge";
