import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

// The preload no longer forwards commands or filters push streams — those moved to the
// loopback WS transport (#378), which the renderer reaches through @rennet/client's
// WsRennetBridge. What remains is the Electron-native residue the renderer merges with
// that bridge: the host platform, the WS port to dial, the directory picker, and the
// host-app updater channels.
// The source-aware project picker's WSL branch: lists installed distros so the
// renderer offers them instead of the user typing a distro name.
const LIST_WSL_DISTROS_CHANNEL = "rennet:list-wsl-distros";
const RESOLVE_DAEMON_FOR_PATH_CHANNEL = "rennet:resolve-daemon-for-path";
// The renderer's connect-flow decisions (locus detect / daemon switch / failure) land here as
// structured lines in MAIN's <userData>/wsl-connect.log — the SHELL-side trace of connecting a
// WSL directory to its in-distro daemon. Debug plumbing, deliberately loud, no secrets.
const WSL_CONNECT_LOG_CHANNEL = "rennet:wsl-connect-log";
const UPDATE_READY_CHANNEL = "rennet:update-ready";
const UPDATE_APPLY_CHANNEL = "rennet:update-apply";
const OPEN_FULL_DISK_ACCESS_CHANNEL = "rennet:open-full-disk-access";
// The daemon's WS port used to ride the renderer argv as a boot-time constant. It cannot: MAIN
// creates the window BEFORE the daemon is healthy now (perf audit §2/§6 H1), so the port is an
// answer that arrives later, over this channel.
const WS_PORT_CHANNEL = "rennet:ws-port";
const VERSION_ARG = "--rennet-version=";

/** A downloaded-and-ready update, as pushed (or replayed) by MAIN. */
export interface UpdateReadyInfo {
  version?: string;
}

/**
 * A structured line the renderer appends to MAIN's WSL-connect debug log. Free-form
 * `detail` so the connect-flow can log whatever it decided (detected distro, resolved
 * port, error) without a per-event schema. Never carries a token or credential.
 */
export interface WslConnectLogEntry {
  /** Which stage of the connect flow logged this (`detect`, `switch`, `error`, …). */
  readonly event: string;
  /** The project path being connected. */
  readonly path?: string;
  /** Everything else worth seeing over SSH — distro, port, translated path, message. */
  readonly detail?: Record<string, unknown>;
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
  /**
   * The loopback WS port the daemon bound (#378), asked of MAIN. It resolves LATE on a cold
   * start — the window exists before the daemon is healthy — and rejects when the daemon never
   * comes up, which MAIN surfaces itself (dialog naming daemon.log, then quit). The renderer
   * hands it to its bridge as a late endpoint, so the shell paints and the connection
   * supervisor sits in `connecting` meanwhile.
   */
  wsPort(): Promise<number>;
  /**
   * Installed WSL distros (`wsl.exe -l -q`), or `[]` off win32 / with no WSL / on
   * any error — never rejects. Backs the source-aware project picker's WSL branch.
   */
  listWslDistros(): Promise<string[]>;
  /**
   * Ensure the daemon that should serve a project at `path` (host daemon for a host path,
   * the in-distro daemon for a `\\wsl.localhost\<distro>\…` path) and resolve its ws port.
   * Rejects with a plain message when a WSL distro has no usable Node or is unreachable — the
   * renderer turns that into an install/start prompt. Returns null for an untrusted caller.
   */
  resolveDaemonForPath(path: string): Promise<number | null>;
  /**
   * Append one structured line to MAIN's `<userData>/wsl-connect.log` — the renderer-side
   * trace of the WSL connect flow (fire-and-forget; the log is best-effort debug plumbing).
   */
  logWslConnect(entry: WslConnectLogEntry): void;
  /**
   * Subscribe to update-readiness (badge on the Rennet logo). The cached MAIN-side
   * state is replayed immediately so a renderer that loads after the download still
   * badges; returns an unsubscribe.
   */
  onUpdateReady(listener: (info: UpdateReadyInfo) => void): () => void;
  /** The user confirmed the restart-into-update prompt; MAIN quits and installs. */
  applyUpdate(): void;
  /** Open macOS System Settings at Privacy & Security → Full Disk Access. */
  openFullDiskAccessSettings(): Promise<boolean>;
}

// The app version IS a boot-time constant injected via webPreferences.additionalArguments;
// it lands in the sandboxed preload's `process.argv`. The WS port no longer can be — see above.
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_ARG));
const version = versionArg ? versionArg.slice(VERSION_ARG.length) : "";

const preload: RennetPreload = {
  platform: process.platform,
  version,
  wsPort: () => ipcRenderer.invoke(WS_PORT_CHANNEL) as Promise<number>,
  listWslDistros: () => ipcRenderer.invoke(LIST_WSL_DISTROS_CHANNEL) as Promise<string[]>,
  resolveDaemonForPath: (path) =>
    ipcRenderer.invoke(RESOLVE_DAEMON_FOR_PATH_CHANNEL, path) as Promise<number | null>,
  logWslConnect: (entry) => ipcRenderer.send(WSL_CONNECT_LOG_CHANNEL, entry),
  onUpdateReady: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = parseUpdateReady(payload);
      if (parsed) listener(parsed);
    };
    ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
    // Replay: MAIN caches readiness, so a late subscriber still learns of it. On a packaged,
    // signed macOS build the handler is registered only after the codesign probe resolves, so
    // this invoke RELIABLY rejects with "no handler registered" when the renderer subscribes
    // first — swallowed, because no cached readiness is the same answer as "nothing staged".
    void ipcRenderer
      .invoke(UPDATE_READY_CHANNEL)
      .then((payload) => {
        const parsed = parseUpdateReady(payload);
        if (parsed) listener(parsed);
      })
      .catch(() => undefined);
    return () => ipcRenderer.removeListener(UPDATE_READY_CHANNEL, handler);
  },
  applyUpdate: () => ipcRenderer.send(UPDATE_APPLY_CHANNEL),
  openFullDiskAccessSettings: () =>
    ipcRenderer.invoke(OPEN_FULL_DISK_ACCESS_CHANNEL) as Promise<boolean>,
};

contextBridge.exposeInMainWorld("rennet", preload);
