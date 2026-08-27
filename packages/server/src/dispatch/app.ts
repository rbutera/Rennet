import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function appHandlers(rt: DispatchRuntime) {
  const { service, allowedRoots, deps, repositoryExists } = rt;
  return {
    "app.bootstrap": async (rawInput) => {
      const name = "app.bootstrap" as const;
      parseCommandInput(name, rawInput);
      const review = service.bootstrap();
      const repositoryPresent = review !== null && repositoryExists(review.repositoryRoot);
      if (review && repositoryPresent) {
        allowedRoots.add(review.repositoryRoot);
        deps.startWatching(review.repositoryRoot);
      }
      return parseCommandOutput(name, { review, repositoryPresent });
    },
  } satisfies Record<string, CommandHandler>;
}
