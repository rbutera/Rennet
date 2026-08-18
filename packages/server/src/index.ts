// @rennet/server — the composition root and command router extracted from the
// Electron main process (#377). The handle `createRennetServer` returns IS the
// server's surface; the relocated modules are internal and imported relatively.
export {
  createRennetServer,
  type RennetServer,
  type RennetServerOptions,
} from "./create-server";
// The loopback WS transport primitive (#378). `createRennetServer` already starts a
// listener; this is exported so the transport can be exercised in isolation — a real
// listener over a stub dispatch — by the app-layer contract test (the only layer that
// may also import the real @rennet/client bridge).
export { startWsListener, type WsListener, type WsListenerDeps } from "./ws-listener";
