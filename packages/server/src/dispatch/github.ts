import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function githubHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "github.status": async (rawInput) => {
      const name = "github.status" as const;
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { status: await deps.github.status() });
    },
    "github.connectStart": async (rawInput) => {
      const name = "github.connectStart" as const;
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, await deps.github.connectStart());
    },
    "github.connectPoll": async (rawInput) => {
      const name = "github.connectPoll" as const;
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { poll: await deps.github.connectPoll() });
    },
    "github.connectCancel": async (rawInput) => {
      const name = "github.connectCancel" as const;
      parseCommandInput(name, rawInput);
      await deps.github.connectCancel();
      return parseCommandOutput(name, {});
    },
    "github.setToken": async (rawInput) => {
      const name = "github.setToken" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { status: await deps.github.setToken(input.token) });
    },
    "github.disconnect": async (rawInput) => {
      const name = "github.disconnect" as const;
      parseCommandInput(name, rawInput);
      await deps.github.disconnect();
      return parseCommandOutput(name, {});
    },
  } satisfies Record<string, CommandHandler>;
}
