import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function attentionHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "attention.acknowledge": async (rawInput) => {
      const name = "attention.acknowledge" as const;
      const input = parseCommandInput(name, rawInput);
      const cleared = deps.acknowledgeAttention?.(input) ?? 0;
      return parseCommandOutput(name, { cleared });
    },
  } satisfies Record<string, CommandHandler>;
}
