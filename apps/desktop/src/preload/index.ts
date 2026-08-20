import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

// The preload no longer forwards commands or filters push streams — those moved to the
// loopback WS transport (#378), which the renderer reaches through @rennet/client's
// WsRennetBridge. What remains is the Electron-native residue the renderer merges with
// that bridge: the host platform, the WS port to dial, the directory picker, and the
// host-app updater channels.
const CHOOSE_DIRECTORY_CHANNEL = "rennet:choose-directory";
const RESOLVE_DAEMON_FOR_PATH_CHANNEL = "rennet:resolve-daemon-for-path";
const UPDATE_READY_CHANNEL = "rennet:update-ready";
const UPDATE_APPLY_CHANNEL = "rennet:update-apply";
const WS_PORT_ARG = "--rennet-ws-port=";
const VERSION_ARG = "--rennet-version=";

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
  /** The host app version (`app.getVersion()`), read from the injected argv flag. */
  readonly version: string;
  /** The loopback WS port the server bound (#378), read from the injected argv flag. */
  readonly wsPort: number;
  /**
   * Open the native directory picker and resolve the chosen path, or null if cancelled
   * (#379). A detached daemon cannot open a dialog, so the renderer obtains the path here
   * and forwards it to `repository.choose`. Honors RENNET_TEST_REPO on the main side.
   */
  chooseDirectory(): Promise<string | null>;
  /**
   * Ensure the daemon that should serve a project at `path` (host daemon for a host path,
   * the in-distro daemon for a `\\wsl.localhost\<distro>\…` path) and resolve its ws port.
   * Rejects with a plain message when a WSL distro has no usable Node or is unreachable — the
   * renderer turns that into an install/start prompt. Returns null for an untrusted caller.
   */
  resolveDaemonForPath(path: string): Promise<number | null>;
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
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_ARG));
const version = versionArg ? versionArg.slice(VERSION_ARG.length) : "";

const preload: RennetPreload = {
  platform: process.platform,
  version,
  wsPort,
  chooseDirectory: () => ipcRenderer.invoke(CHOOSE_DIRECTORY_CHANNEL) as Promise<string | null>,
  resolveDaemonForPath: (path) =>
    ipcRenderer.invoke(RESOLVE_DAEMON_FOR_PATH_CHANNEL, path) as Promise<number | null>,
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
