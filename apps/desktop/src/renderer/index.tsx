import {
  type Connection,
  ConnectionHost,
  type ConnectionTarget,
  type DaemonResolution,
} from "@rennet/app-ui";
import { ConnectionSupervisor, type TokenStore, WsRennetBridge } from "@rennet/client";
import type { RennetBridge } from "@rennet/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveDaemonTarget as resolveWslDaemonTarget } from "./wsl-connect";

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
// loopback port the preload injected). A SAVED remote target is a `WsRennetBridge` at its
// host with its device token. The in-app directory browser (source-aware project selection)
// retired the native directory picker AND the remote path prompt — `repository.choose` now
// always arrives with a `{ path }` the browser supplied, on whichever source's daemon is
// attached. The Electron-native preload residue (platform, the app-updater channels, the WSL
// distro list) merges onto every target — it operates whichever daemon the window is attached
// to, since those are about the installed app, not the daemon. Switching a target is a clean
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

/**
 * Compose a full RennetBridge from the supervisor + the Electron-native preload residue. The
 * native directory picker is retired (source-aware project selection): the in-app directory
 * browser now supplies the path, so `repository.choose` always arrives with its `{ path }` and the
 * bridge forwards every command straight through — no interception.
 */
function composeBridge(supervisor: ConnectionSupervisor): RennetBridge & { close?(): void } {
  return {
    invoke: supervisor.invoke.bind(supervisor),
    onProgress: supervisor.onProgress.bind(supervisor),
    onProjectDetailProgress: supervisor.onProjectDetailProgress.bind(supervisor),
    onAskStream: supervisor.onAskStream.bind(supervisor),
    platform: preload.platform,
    version: preload.version,
    // App-binary update readiness rides every target like the platform residue — the
    // update is about THIS installed app, not whichever daemon the window watches.
    onUpdateReady: preload.onUpdateReady,
    applyUpdate: preload.applyUpdate,
    close: () => supervisor.close(),
  };
}

const DEFAULT_TARGET: ConnectionTarget = {
  id: "local",
  label: "This machine",
  host: "127.0.0.1",
  port: preload.wsPort,
};

// WSL connect flow (shell side): pick a WSL directory → resolve+attach that distro's in-distro
// daemon → the remounted app captures the repo there. The decision lives in the import-safe
// `./wsl-connect` module (unit-tested); here we just bind it to the preload's methods.
const resolveDaemonTarget = (path: string): Promise<DaemonResolution> =>
  resolveWslDaemonTarget(path, preload);

function createConnection(target: ConnectionTarget): Connection {
  const isLocal = target.id === DEFAULT_TARGET.id;
  const url = isLocal
    ? `ws://127.0.0.1:${preload.wsPort}`
    : `ws://${target.port ? `${target.host}:${target.port}` : target.host}`;
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
  return {
    bridge: composeBridge(supervisor),
    subscribe: (listener) => supervisor.subscribe(listener),
    close: () => supervisor.close(),
  };
}

createRoot(root).render(
  <StrictMode>
    <ConnectionHost
      createConnection={createConnection}
      defaultTarget={DEFAULT_TARGET}
      resolveDaemonTarget={resolveDaemonTarget}
      logWslConnect={preload.logWslConnect}
      listWslDistros={preload.listWslDistros}
    />
  </StrictMode>,
);
