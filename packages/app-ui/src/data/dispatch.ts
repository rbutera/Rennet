import type { CommandInput, CommandName, CommandOutput } from "@rennet/protocol";
import { commands } from "@rennet/protocol";
import { useCallback } from "react";
import { useBridgeContext } from "./bridge";

// ─────────────────────────────────────────────────────────────────────────────
// useInvoke (C11) — a GENERIC one-shot dispatch for a command whose name is only
// known at runtime (the ⌘K menu's registry-command channel: the row to run is picked
// from the registry, so no static `useMutation(name)` fits). It rides the same bridge
// as the rest of the seam — the "no component calls `bridge.invoke` directly" law is
// about SURFACES; this lives in `data/`, which is the sanctioned path.
//
// It does not cache, but it DOES invalidate: a dispatched row stales the reads of its own
// FAMILY, so `github.disconnect` stales `github.status` and every mounted GitHub surface
// re-reads. `useMutation` declares `invalidates` at a static call site; the menu has no
// static call site, so the command's own family is the honest stand-in. Under-invalidating
// here is a surface rendering something the user just deleted.
// ─────────────────────────────────────────────────────────────────────────────

/** A stable dispatcher: `invoke(name, input)` runs one command through the bridge. */
export function useInvoke(): <K extends CommandName>(
  name: K,
  input: CommandInput<K>,
) => Promise<CommandOutput<K>> {
  const { bridge, cache } = useBridgeContext();
  return useCallback(
    async <K extends CommandName>(name: K, input: CommandInput<K>) => {
      const output = await bridge.invoke(name, input);
      const family = `${name.slice(0, name.indexOf("."))}.`;
      for (const other of Object.keys(commands)) {
        if (other.startsWith(family)) cache.invalidate(other);
      }
      return output;
    },
    [bridge, cache],
  );
}
