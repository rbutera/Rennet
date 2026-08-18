// The one error a client-runtime consumer must be able to tell apart: a rejection
// caused by the CONNECTION (a dropped socket, an offline invoke, a rejected token),
// not by the command itself. It carries a stable `name` so a consumer that cannot
// import this class — `packages/ui` may not depend on `@rennet/client` — can still
// recognise it structurally as `error.name === "ConnectionError"` (see conversation-host).
//
// Lives in its own tiny module so both the transport (`ws-bridge`) and the supervisor
// use ONE definition without a cycle (the supervisor imports types back from the bridge).

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/** Structural check — matches a `ConnectionError` from any copy of this module (or a shell's shim). */
export function isConnectionError(error: unknown): boolean {
  return error instanceof Error && error.name === "ConnectionError";
}
