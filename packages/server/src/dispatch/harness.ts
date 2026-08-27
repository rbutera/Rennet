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
  } satisfies Record<string, CommandHandler>;
}
