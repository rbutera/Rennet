import { menuRunPayloadSchema } from "@rennet/protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

// The preload no longer forwards commands or filters push streams — those moved to the
// loopback WS transport (#378), which the renderer reaches through @rennet/client's
// WsRennetBridge. What remains is the Electron-native residue the renderer merges with
// that bridge: the host platform, the WS port to dial, and the menu-run channel.
const MENU_RUN_CHANNEL = "rennet:menu-run";
const CHOOSE_DIRECTORY_CHANNEL = "rennet:choose-directory";
const UPDATE_READY_CHANNEL = "rennet:update-ready";
const UPDATE_APPLY_CHANNEL = "rennet:update-apply";
const WS_PORT_ARG = "--rennet-ws-port=";

/** A downloaded-and-ready update, as pushed (or replayed) by MAIN. */
export interface UpdateReadyInfo {
  version?: string;
}

/** Boundary parse for the readiness payload — the channel idiom's zod-lite. */
function parseUpdateReady(payload: unknown): UpdateReadyInfo | null {
  if (typeof payload !== "object" || payload === null) return null;
  const version = (payload as { version?: unknown }).version;
  if (version === undefined) return {};
  return typeof version === "string" ? { version } : null;
}

/** The Electron-native surface the preload injects as `window.rennet`. */
export interface RennetPreload {
  /** The host platform (`process.platform`), so the renderer can gate macOS-only chrome. */
  readonly platform: string;
  /** The loopback WS port the server bound (#378), read from the injected argv flag. */
  readonly wsPort: number;
  /** Subscribe to menu-item activations (#44); returns an unsubscribe. */
  onMenuRun(listener: (id: string) => void): () => void;
  /**
   * Open the native directory picker and resolve the chosen path, or null if cancelled
   * (#379). A detached daemon cannot open a dialog, so the renderer obtains the path here
   * and forwards it to `repository.choose`. Honors RENNET_TEST_REPO on the main side.
   */
  chooseDirectory(): Promise<string | null>;
  /**
   * Subscribe to update-readiness (badge on the Rennet logo). The cached MAIN-side
   * state is replayed immediately so a renderer that loads after the download still
   * badges; returns an unsubscribe.
   */
  onUpdateReady(listener: (info: UpdateReadyInfo) => void): () => void;
  /** The user confirmed the restart-into-update prompt; MAIN quits and installs. */
  applyUpdate(): void;
}

// The WS port is a boot-time constant injected via webPreferences.additionalArguments;
// it lands in the sandboxed preload's `process.argv`.
const wsPortArg = process.argv.find((arg) => arg.startsWith(WS_PORT_ARG));
const wsPort = wsPortArg ? Number.parseInt(wsPortArg.slice(WS_PORT_ARG.length), 10) : 0;

const preload: RennetPreload = {
  platform: process.platform,
  wsPort,
  onMenuRun: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = menuRunPayloadSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data.id);
    };
    ipcRenderer.on(MENU_RUN_CHANNEL, handler);
    return () => ipcRenderer.removeListener(MENU_RUN_CHANNEL, handler);
  },
  chooseDirectory: () => ipcRenderer.invoke(CHOOSE_DIRECTORY_CHANNEL) as Promise<string | null>,
  onUpdateReady: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = parseUpdateReady(payload);
      if (parsed) listener(parsed);
    };
    ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
    // Replay: MAIN caches readiness, so a late subscriber still learns of it.
    void ipcRenderer.invoke(UPDATE_READY_CHANNEL).then((payload) => {
      const parsed = parseUpdateReady(payload);
      if (parsed) listener(parsed);
    });
    return () => ipcRenderer.removeListener(UPDATE_READY_CHANNEL, handler);
  },
  applyUpdate: () => ipcRenderer.send(UPDATE_APPLY_CHANNEL),
};

contextBridge.exposeInMainWorld("rennet", preload);
