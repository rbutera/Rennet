import { ConnectionSupervisor, type TokenStore, WsRennetBridge } from "@rennet/client";
import type { RennetBridge } from "@rennet/protocol";
import { type Connection, ConnectionHost, type ConnectionTarget } from "@rennet/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root is missing");

const preload = window.rennet;

// Expose the host platform to CSS so chrome can gate macOS-only insets (the
// titlebar traffic-light reservation) instead of leaking them onto Windows.
if (preload.platform) {
  document.documentElement.dataset.platform = preload.platform;
}

// The connections surface (#381, design D4): the renderer now mounts `ConnectionHost`
// rather than `RennetApp` directly. The DEFAULT target is this machine's own daemon (the
// loopback port the preload injected), reached with the native directory picker for
// `repository.choose`. A SAVED remote target is a `WsRennetBridge` at its host with its
// device token; a browser-style path prompt stands in for the native picker (a remote
// choose is server-side). The Electron-native menu residue merges onto every target — it
// operates whichever daemon the window is attached to. Switching a target is a clean
// RennetApp remount; the desktop's own daemon spawn/supervision is untouched (remote
// attach is purely a renderer-level bridge choice).

/** A token store seeded from the saved target (ConnectionHost's daemons storage, migrated
 *  in place). Read-only here — the runtime never mints a token; pairing writes the daemon
 *  list ConnectionHost owns. Token material stays off every log line by construction. */
function targetTokenStore(target: ConnectionTarget): TokenStore {
  return {
    get: () => target.deviceToken,
    set: () => undefined,
    delete: () => undefined,
  };
}

/** Compose a full RennetBridge from the supervisor + the shell's `repository.choose` fallback. */
function composeBridge(
  supervisor: ConnectionSupervisor,
  chooseDirectory: () => Promise<string | null>,
): RennetBridge & { close?(): void } {
  const wsInvoke = supervisor.invoke.bind(supervisor);
  const invoke: RennetBridge["invoke"] = async (name, input) => {
    if (name === "repository.choose" && (input as { path?: string }).path === undefined) {
      const path = await chooseDirectory();
      if (path === null) return { path: null } as never;
      return wsInvoke("repository.choose", { path }) as never;
    }
    return wsInvoke(name, input);
  };
  return {
    invoke,
    onProgress: supervisor.onProgress.bind(supervisor),
    onAskStream: supervisor.onAskStream.bind(supervisor),
    platform: preload.platform,
    updateMenu: preload.updateMenu,
    onMenuRun: preload.onMenuRun,
    close: () => supervisor.close(),
  };
}

const DEFAULT_TARGET: ConnectionTarget = {
  id: "local",
  label: "This machine",
  host: "127.0.0.1",
  port: preload.wsPort,
};

function createConnection(target: ConnectionTarget): Connection {
  const isLocal = target.id === DEFAULT_TARGET.id;
  const url = isLocal
    ? `ws://127.0.0.1:${preload.wsPort}`
    : `ws://${target.port ? `${target.host}:${target.port}` : target.host}`;
  // The local daemon uses the native picker; a remote daemon's repository is server-side, so
  // a path prompt on ITS machine stands in.
  const chooseDirectory = isLocal
    ? preload.chooseDirectory
    : (): Promise<string | null> =>
        Promise.resolve(
          window.prompt("Absolute path to a repository on the daemon's machine:") || null,
        );
  const supervisor = new ConnectionSupervisor({
    daemonId: target.id,
    tokenStore: targetTokenStore(target),
    // queue: an invoke before the handshake completes waits for `online` (the bridge's old
    // #whenReady behaviour), so the initial `app.bootstrap` is behavior-neutral.
    offlineInvoke: "queue",
    createBridge: (hooks, deviceToken) =>
      new WsRennetBridge({
        url,
        deviceToken,
        autoReconnect: false,
        onLifecycle: hooks.onLifecycle,
      }),
  });
  return { bridge: composeBridge(supervisor, chooseDirectory), close: () => supervisor.close() };
}

createRoot(root).render(
  <StrictMode>
    <ConnectionHost createConnection={createConnection} defaultTarget={DEFAULT_TARGET} />
  </StrictMode>,
);
