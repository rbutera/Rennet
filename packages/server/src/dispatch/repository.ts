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
    "repository.identify": async (rawInput) => {
      const name = "repository.identify" as const;
      // Resolve the checkout path to its canonical `owner/name` on the DAEMON, so the headless
      // CLI mints and PR-scopes with the daemon's own identity string rather than one it spelled
      // (headless-review-cli D11). A read of the repo's origin remote; grants nothing.
      const input = parseCommandInput(name, rawInput);
      const identity = await deps.repositoryIdentify({ path: input.path });
      return parseCommandOutput(name, {
        repository: identity.repository,
        ...(identity.forgeRepository === undefined
          ? {}
          : { forgeRepository: identity.forgeRepository }),
      });
    },
  } satisfies Record<string, CommandHandler>;
}
