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
  } satisfies Record<string, CommandHandler>;
}
