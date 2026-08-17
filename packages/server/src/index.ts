// @rennet/server — the composition root and command router extracted from the
// Electron main process (#377). The handle `createRennetServer` returns IS the
// server's surface; the relocated modules are internal and imported relatively.
export {
  createRennetServer,
  type RennetServer,
  type RennetServerOptions,
} from "./create-server";
