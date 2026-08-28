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
  } satisfies Record<string, CommandHandler>;
}
