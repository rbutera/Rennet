import type { RennetPreload } from "../preload";

declare global {
  interface Window {
    // The preload now injects only the Electron-native residue (#378); the renderer
    // merges it with a WsRennetBridge into the full RennetBridge it hands the UI.
    rennet: RennetPreload;
  }
}
