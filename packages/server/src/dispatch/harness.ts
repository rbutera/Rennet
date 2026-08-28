import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function harnessHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "harness.detect": async (rawInput) => {
      const name = "harness.detect" as const;
      // The ambient detection line. Read-only, no repository, no index touch.
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { detected: await deps.detectHarnesses() });
    },
    "harness.hosts": async (rawInput) => {
      const name = "harness.hosts" as const;
      // Per-host agent detection (C17 cluster 3). Read-only, no repository, no model call —
      // DISCLOSURE, like harness.detect / forge.detect / daemon.status. Absent settings dep ⇒
      // no host enumeration exists, so the honest answer is NO hosts (never a fabricated one).
      parseCommandInput(name, rawInput);
      if (!deps.settings) return parseCommandOutput(name, { hosts: [] });
      return parseCommandOutput(name, { hosts: await deps.settings.harnessHosts() });
    },
  } satisfies Record<string, CommandHandler>;
}
