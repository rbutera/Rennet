import { WsRennetBridge } from "@rennet/client";
import { commands as commandRegistry } from "@rennet/protocol";
import { startWsListener, type WsListener } from "@rennet/server";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_SHELL_INTERCEPTS, composeBrowserInvoke } from "./browser/shell-intercepts";

// The parity inventory (issue #381, design D6). The truthful parity axis is the WIRE:
// both shells share `WsRennetBridge`, so a per-command UI-driving test would test the ui
// (shell-independent). Instead this proves (1) every command-registry key reaches
// dispatch over the real WS request path — no transport/allowlist filter silently drops a
// command — and (2) the browser shell's interception allowlist is EXACTLY
// `["repository.choose"]`, each entry carrying a justification. A new interception without
// a justification, or an extra dropped command, fails here.
//
// This lives in apps/desktop (not packages/server, where design D6 first placed it) for the
// same reason ws-contract.test.ts does: it is the only layer permitted to import BOTH the
// server listener and the client bridge — packages/server may not depend on @rennet/client.

type Dispatch = Parameters<typeof startWsListener>[0]["dispatch"];

function invoke(
  composedInvoke: ReturnType<typeof composeBrowserInvoke>,
  name: string,
  input: unknown,
): Promise<unknown> {
  return (composedInvoke as unknown as (n: string, i: unknown) => Promise<unknown>)(name, input);
}

const bridges: WsRennetBridge[] = [];
const listeners: WsListener[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const listener of listeners.splice(0)) await listener.close();
});

describe("browser-shell parity inventory (#381)", () => {
  it("routes every wire command through the browser bridge path to dispatch", async () => {
    const seen: string[] = [];
    const dispatch = (async (name: string) => {
      seen.push(name);
      return {};
    }) as Dispatch;
    const listener = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(listener);
    // The browser shell uses this exact bridge class (with a token when remote); a loopback
    // client here is `private`, which is the strictest routing surface.
    const bridge = new WsRennetBridge({
      url: `ws://127.0.0.1:${listener.port}`,
      initialBackoffMs: 10,
    });
    bridges.push(bridge);
    const composedInvoke = composeBrowserInvoke(
      bridge.invoke.bind(bridge),
      () => "/tmp/rennet-browser-parity",
    );

    const commands = Object.keys(commandRegistry);
    for (const command of commands) {
      await invoke(composedInvoke, command, {});
    }
    expect(seen.sort()).toEqual([...commands].sort());
  });

  it("intercepts exactly repository.choose, with a justification", () => {
    const names = Object.keys(BROWSER_SHELL_INTERCEPTS);
    expect(names).toEqual(["repository.choose"]);
    for (const [name, justification] of Object.entries(BROWSER_SHELL_INTERCEPTS)) {
      expect(justification, `interception ${name} needs a justification`).toBeTruthy();
      expect(justification.length).toBeGreaterThan(20);
    }
  });
});
