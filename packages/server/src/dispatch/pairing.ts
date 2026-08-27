import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function pairingHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "pairing.mint": async (rawInput) => {
      const name = "pairing.mint" as const;
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, deps.pairing.mint());
    },
    "pairing.exchange": async (rawInput) => {
      const name = "pairing.exchange" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, deps.pairing.exchange(input.code, input.deviceName));
    },
    "pairing.listDevices": async (rawInput) => {
      const name = "pairing.listDevices" as const;
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { devices: deps.pairing.listDevices() });
    },
    "pairing.revokeDevice": async (rawInput) => {
      const name = "pairing.revokeDevice" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { devices: deps.pairing.revokeDevice(input.deviceId) });
    },
  } satisfies Record<string, CommandHandler>;
}
