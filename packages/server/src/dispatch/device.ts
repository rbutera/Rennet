import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function deviceHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "device.registerPush": async (rawInput, ctx) => {
      const name = "device.registerPush" as const;
      const input = parseCommandInput(name, rawInput);
      // Token-bearing (projected) connections only: the authenticated device id keys the token.
      const deviceId = ctx?.deviceId;
      if (!deviceId || !deps.pushTokens) {
        throw new Error("device.registerPush requires a paired (token-bearing) connection");
      }
      if (input.remove || !input.pushToken) {
        deps.pushTokens.delete(deviceId);
        return parseCommandOutput(name, { registered: false });
      }
      deps.pushTokens.set(deviceId, input.pushToken, input.platform, input.disabledFamilies ?? []);
      return parseCommandOutput(name, { registered: true });
    },
  } satisfies Record<string, CommandHandler>;
}
