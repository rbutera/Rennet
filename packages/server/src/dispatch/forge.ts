import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function forgeHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "forge.detect": async (rawInput) => {
      const name = "forge.detect" as const;
      // Forge (source-control) CLI detection on this host. Read-only, no repository, no
      // model call — DISCLOSURE, like harness.detect. Feeds `sourceControlByHost` (C17).
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { detected: await deps.detectForges() });
    },
    "forge.hosts": async (rawInput) => {
      const name = "forge.hosts" as const;
      // Per-host forge detection (C17 amendment B), the mirror of `harness.hosts`. Read-only,
      // no repository, no model call — DISCLOSURE. Absent settings dep ⇒ no host enumeration
      // exists, so the honest answer is NO hosts (never a fabricated one).
      parseCommandInput(name, rawInput);
      if (!deps.settings) return parseCommandOutput(name, { hosts: [] });
      return parseCommandOutput(name, { hosts: await deps.settings.forgeHosts() });
    },
    "forge.setEnabled": async (rawInput) => {
      const name = "forge.setEnabled" as const;
      // The per-host forge ruling (amendment A). A plain settings write — no gate, no
      // ceremony (Rule Zero). Absent settings dep ⇒ there is no store to write to, so this
      // FAILS loudly rather than reporting a decision that went nowhere.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) throw new Error("forge.setEnabled: no settings store is wired");
      return parseCommandOutput(name, { disabled: deps.settings.setForgeEnabled(input) });
    },
  } satisfies Record<string, CommandHandler>;
}
