import type { CommandHandler } from "./runtime";

export function patchsetHandlers() {
  return {
    "patchset.readSpan": async () => {
      // B3 ships this row as CONTRACT ONLY (proposal reconciliation 8): the
      // registry freezes the shape for Track C; B4/B10 bind the real
      // patchset-backed reader. Until then the wire answers unbound.
      throw new Error("patchset.readSpan is not bound yet (B4/B10 bind dispatch)");
    },
  } satisfies Record<string, CommandHandler>;
}
