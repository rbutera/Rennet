import {
  browserHistory,
  type Connection,
  ConnectionHost,
  type ConnectionTarget,
} from "@rennet/app-ui";
import { ConnectionSupervisor, type TokenStore, WsRennetBridge } from "@rennet/client";
import type { RennetBridge } from "@rennet/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { composeBrowserInvoke } from "./shell-intercepts";

// The browser shell (issue #381, design D4/D5). A tab served by the daemon is a full peer
// of the desktop app: it mounts the SAME `ConnectionHost` over the SAME `packages/app-ui`. The
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
  port: location.port ? Number(location.port) : undefined,
};

/** The WS authority for a target: the serving origin for the default, else the saved host[:port]. */
function authorityFor(target: ConnectionTarget): string {
  if (target.id === DEFAULT_TARGET.id) return location.host;
  return target.port ? `${target.host}:${target.port}` : target.host;
}

/** A token store seeded from the saved target (the daemons localStorage ConnectionHost owns,
 *  migrated in place). Read-only; token material never reaches a log line. */
function targetTokenStore(target: ConnectionTarget): TokenStore {
  return { get: () => target.deviceToken, set: () => undefined, delete: () => undefined };
}

// Module-level (stable) so ConnectionHost keys its remounts on the active target, not on a
// changing factory identity.
function createConnection(target: ConnectionTarget): Connection {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${authorityFor(target)}`;
  const supervisor = new ConnectionSupervisor({
    daemonId: target.id,
    tokenStore: targetTokenStore(target),
    // queue: hold an invoke until the handshake completes (the bridge's old #whenReady
    // behaviour), so the served tab's initial bootstrap stays behavior-neutral.
    offlineInvoke: "queue",
    createBridge: (hooks, deviceToken) =>
      new WsRennetBridge({
        url,
        deviceToken,
        autoReconnect: false,
        onLifecycle: hooks.onLifecycle,
      }),
  });
  const invoke: RennetBridge["invoke"] = composeBrowserInvoke(supervisor.invoke.bind(supervisor));
  const bridge: RennetBridge & { close?(): void } = {
    invoke,
    onProgress: supervisor.onProgress.bind(supervisor),
    onProjectDetailProgress: supervisor.onProjectDetailProgress.bind(supervisor),
    onAskStream: supervisor.onAskStream.bind(supervisor),
    close: () => supervisor.close(),
  };
  return {
    bridge,
    subscribe: (listener) => supervisor.subscribe(listener),
    close: () => supervisor.close(),
  };
}

createRoot(root).render(
  <StrictMode>
    <ConnectionHost
      createConnection={createConnection}
      defaultTarget={DEFAULT_TARGET}
      history={browserHistory}
    />
  </StrictMode>,
);
