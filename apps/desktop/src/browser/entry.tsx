import { WsRennetBridge } from "@rennet/client";
import type { RennetBridge } from "@rennet/protocol";
import { ConnectionHost, type ConnectionTarget } from "@rennet/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BROWSER_SHELL_INTERCEPT_NAMES } from "./shell-intercepts";

// The browser shell (issue #381, design D4/D5). A tab served by the daemon is a full peer
// of the desktop app: it mounts the SAME `ConnectionHost` over the SAME `packages/ui`. The
// only shell-specific pieces are the bridge factory (the serving origin is the default
// daemon; saved remotes carry a device token) and the `repository.choose` fallback — a
// browser has no native directory picker, so first-contact choose prompts for an absolute
// path ON THE DAEMON'S MACHINE (honest, minimal; the projection's repo references mean most
// flows never need a raw path again). No preload, no platform, no menu (navigator covers chords).

const root = document.getElementById("root");
if (!root) throw new Error("Browser root is missing");

/** The serving origin — the daemon that handed us this page. Always available, no token. */
const DEFAULT_TARGET: ConnectionTarget = {
  id: "local",
  label: "This server",
  host: location.hostname,
};

/** The WS authority for a target: the serving origin for the default, else the saved host[:port]. */
function authorityFor(target: ConnectionTarget): string {
  if (target.id === DEFAULT_TARGET.id) return location.host;
  return target.port ? `${target.host}:${target.port}` : target.host;
}

// Module-level (stable) so ConnectionHost keys its remounts on the active target, not on a
// changing factory identity.
function createBridge(target: ConnectionTarget): RennetBridge & { close?(): void } {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBridge = new WsRennetBridge({
    url: `${scheme}//${authorityFor(target)}`,
    deviceToken: target.deviceToken,
  });
  const wsInvoke = wsBridge.invoke.bind(wsBridge);
  const invoke: RennetBridge["invoke"] = async (name, input) => {
    // The ONLY shell interception is the allowlist's `repository.choose` (design D5/D6).
    if (
      BROWSER_SHELL_INTERCEPT_NAMES.has(name) &&
      (input as { path?: string }).path === undefined
    ) {
      const path = window.prompt("Absolute path to a repository on the daemon's machine:");
      if (!path) return { path: null } as never;
      return wsInvoke("repository.choose", { path }) as never;
    }
    return wsInvoke(name, input);
  };
  return {
    invoke,
    onProgress: wsBridge.onProgress.bind(wsBridge),
    onAskStream: wsBridge.onAskStream.bind(wsBridge),
    close: () => wsBridge.close(),
  };
}

createRoot(root).render(
  <StrictMode>
    <ConnectionHost createBridge={createBridge} defaultTarget={DEFAULT_TARGET} />
  </StrictMode>,
);
