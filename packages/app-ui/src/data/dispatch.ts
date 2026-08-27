import type { CommandInput, CommandName, CommandOutput } from "@rennet/protocol";
import { useCallback } from "react";
import { useBridgeContext } from "./bridge";

// ─────────────────────────────────────────────────────────────────────────────
// useInvoke (C11) — a GENERIC one-shot dispatch for a command whose name is only
// known at runtime (the ⌘K menu's registry-command channel: the row to run is picked
// from the registry, so no static `useMutation(name)` fits). It rides the same bridge
// as the rest of the seam — the "no component calls `bridge.invoke` directly" law is
// about SURFACES; this lives in `data/`, which is the sanctioned path. Fire-and-forget:
// it neither caches nor invalidates (a registry command that stales a read declares it
// where that read lives).
// ─────────────────────────────────────────────────────────────────────────────

/** A stable dispatcher: `invoke(name, input)` runs one command through the bridge. */
export function useInvoke(): <K extends CommandName>(
  name: K,
  input: CommandInput<K>,
) => Promise<CommandOutput<K>> {
  const { bridge } = useBridgeContext();
  return useCallback(
    <K extends CommandName>(name: K, input: CommandInput<K>) => bridge.invoke(name, input),
    [bridge],
  );
}
