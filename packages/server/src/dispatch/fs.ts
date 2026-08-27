import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function fsHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "fs.listDir": async (rawInput) => {
      const name = "fs.listDir" as const;
      // Ungated browse on the attached source's own daemon. Empty path ⇒ home dir.
      const input = parseCommandInput(name, rawInput);
      const result = await deps.listDir({ path: input.path });
      return parseCommandOutput(name, { result });
    },
  } satisfies Record<string, CommandHandler>;
}
