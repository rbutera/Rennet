/**
 * `session/` — the session contracts. `wire.ts` is the #376 transport layer
 * (handshake, envelope, frames), moved here unchanged; `model.ts` holds the
 * #466/#457 durable-session shapes. This is the folder's only public seam;
 * the root `src/index.ts` re-exports it.
 */
export * from "./model";
export * from "./wire";
