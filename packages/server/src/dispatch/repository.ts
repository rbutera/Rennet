import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function repositoryHandlers(rt: DispatchRuntime) {
  const { allowedRoots, deps } = rt;
  return {
    "repository.choose": async (rawInput) => {
      const name = "repository.choose" as const;
      // A windowed client forwards a `path` obtained from its own native picker (#379):
      // the daemon has no dialog. Absent → fall back to the injected chooser / test repo.
      const input = parseCommandInput(name, rawInput);
      const path = input.path ?? (await deps.chooseRepository());
      if (path) allowedRoots.add(path);
      return parseCommandOutput(name, { path });
    },
  } satisfies Record<string, CommandHandler>;
}
