import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function chatHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "chat.t3Session": async (rawInput) => {
      const name = "chat.t3Session" as const;
      // Broker sidecar access to a client (t3code-sidecar-chat, 2.4): the daemon owns the
      // credential, the client never reads the token file. Starting the sidecar on first
      // ask is the whole point — no gate, no confirmation (Rule Zero). Absent supervisor ⇒
      // this daemon was composed without a vendored bundle; say so.
      parseCommandInput(name, rawInput);
      if (!deps.t3Sidecar) {
        throw new Error("chat.t3Session: this daemon has no T3 Code sidecar composed");
      }
      return parseCommandOutput(name, await deps.t3Sidecar.session());
    },
  } satisfies Record<string, CommandHandler>;
}
