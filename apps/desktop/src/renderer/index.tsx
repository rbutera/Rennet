import { WsRennetBridge } from "@rennet/client";
import type { RennetBridge } from "@rennet/protocol";
import { ConnectionHost, type ConnectionTarget } from "@rennet/ui";
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

/** Compose a full RennetBridge from a WS bridge + the shell's `repository.choose` fallback. */
function composeBridge(
  wsBridge: WsRennetBridge,
  chooseDirectory: () => Promise<string | null>,
): RennetBridge & { close?(): void } {
  const wsInvoke = wsBridge.invoke.bind(wsBridge);
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
    onProgress: wsBridge.onProgress.bind(wsBridge),
    onAskStream: wsBridge.onAskStream.bind(wsBridge),
    platform: preload.platform,
    updateMenu: preload.updateMenu,
    onMenuRun: preload.onMenuRun,
    close: () => wsBridge.close(),
  };
}

const DEFAULT_TARGET: ConnectionTarget = {
  id: "local",
  label: "This machine",
  host: "127.0.0.1",
  port: preload.wsPort,
};

function createBridge(target: ConnectionTarget): RennetBridge & { close?(): void } {
  if (target.id === DEFAULT_TARGET.id) {
    const wsBridge = new WsRennetBridge({ url: `ws://127.0.0.1:${preload.wsPort}` });
    return composeBridge(wsBridge, preload.chooseDirectory);
  }
  const authority = target.port ? `${target.host}:${target.port}` : target.host;
  const wsBridge = new WsRennetBridge({
    url: `ws://${authority}`,
    deviceToken: target.deviceToken,
  });
  // A remote daemon's repository is server-side: prompt for a path on its machine.
  const promptForPath = (): Promise<string | null> =>
    Promise.resolve(
      window.prompt("Absolute path to a repository on the daemon's machine:") || null,
    );
  return composeBridge(wsBridge, promptForPath);
}

createRoot(root).render(
  <StrictMode>
    <ConnectionHost createBridge={createBridge} defaultTarget={DEFAULT_TARGET} />
  </StrictMode>,
);
