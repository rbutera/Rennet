import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function daemonHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "daemon.status": async (rawInput) => {
      const name = "daemon.status" as const;
      // Per-host daemon reachability + version (C17). Read-only, no repository, no model
      // call — DISCLOSURE, like harness.detect / forge.detect. Absent settings dep ⇒ no
      // host enumeration exists, so the honest answer is NO hosts (never a fabricated one).
      parseCommandInput(name, rawInput);
      if (!deps.settings) return parseCommandOutput(name, { hosts: [] });
      return parseCommandOutput(name, { hosts: await deps.settings.daemonStatus() });
    },
    "daemon.reconnect": async (rawInput) => {
      const name = "daemon.reconnect" as const;
      // The on-demand re-handshake behind Reconnect (C17 cluster 5, #533). No repository, no
      // model call, no gate — the viewer pressed the button, so it runs (Rule Zero). Absent
      // settings dep ⇒ there is nothing here that can perform a handshake, and saying so is
      // the honest outcome; reporting an unreachable host would be identical to a real timeout.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) throw new Error("daemon.reconnect: no settings composition is wired");
      return parseCommandOutput(name, await deps.settings.reconnect(input.source));
    },
  } satisfies Record<string, CommandHandler>;
}
