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
    "harness.setEnabled": async (rawInput) => {
      const name = "harness.setEnabled" as const;
      // The per-host enable decision (C17 cluster 3.2). A plain settings write — no gate, no
      // ceremony (Rule Zero). Absent settings dep ⇒ there is no store to write to, so this
      // FAILS loudly rather than reporting a decision that went nowhere.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) throw new Error("harness.setEnabled: no settings store is wired");
      return parseCommandOutput(name, { disabled: deps.settings.setHarnessEnabled(input) });
    },
  } satisfies Record<string, CommandHandler>;
}
