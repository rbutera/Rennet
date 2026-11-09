import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * Install for me (source-control-tooling spec, review-preparation-reliability D3). Pressing
 * the button is the request: no confirmation step, no consent token (Rule Zero).
 */
export function toolsHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "tools.install": async (rawInput) => {
      const name = "tools.install" as const;
      // Streams the installer's output as `tool-install-output` progress events under the
      // input's command id while it runs, then answers with the re-probed tool. Absent dep ⇒
      // this composition has no installer at all, which FAILS loudly rather than pretending.
      const input = parseCommandInput(name, rawInput);
      if (!deps.tools) throw new Error("tools.install: no installer is wired");
      return parseCommandOutput(name, { result: await deps.tools.install(input) });
    },
    "tools.cancelInstall": async (rawInput) => {
      const name = "tools.cancelInstall" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, {
        cancelled: deps.tools?.cancelInstall(input.commandId) ?? false,
      });
    },
  } satisfies Record<string, CommandHandler>;
}
