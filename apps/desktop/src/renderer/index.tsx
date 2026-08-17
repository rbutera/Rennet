import { WsRennetBridge } from "@rennet/client";
import type { RennetBridge } from "@rennet/protocol";
import { RennetApp } from "@rennet/ui";
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

// Client #1 of the real wire (#378): command invocation and the progress/ask-stream
// push streams travel the WS bridge; the preload contributes only the Electron-native
// residue (platform + the application-menu channels). Merged into one RennetBridge so
// the UI stays transport-agnostic.
const wsBridge = new WsRennetBridge({ url: `ws://127.0.0.1:${preload.wsPort}` });
const bridge: RennetBridge = {
  invoke: wsBridge.invoke.bind(wsBridge),
  onProgress: wsBridge.onProgress.bind(wsBridge),
  onAskStream: wsBridge.onAskStream.bind(wsBridge),
  platform: preload.platform,
  updateMenu: preload.updateMenu,
  onMenuRun: preload.onMenuRun,
};

createRoot(root).render(
  <StrictMode>
    <RennetApp bridge={bridge} />
  </StrictMode>,
);
