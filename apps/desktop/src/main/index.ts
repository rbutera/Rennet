import { execFile } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { detectLocus, listWslDistros } from "@rennet/core";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import { startAutoUpdate } from "./auto-update";
import { buildContextMenuTemplate } from "./context-menu";
import {
  ensureDaemon,
  ensureDaemonForProject,
  isOwnedDaemonRunning,
  stopOwnedDaemon,
} from "./daemon-supervisor";
import { buildStaticMenu } from "./menu";
import {
  acquireSingleInstance,
  createDockCoordinator,
  createTray,
  ensureWindow,
  residencyOnAllWindowsClosed,
  type TrayController,
} from "./tray";
import { brandWindowIcon, isExternalHttpUrl, resolveAppUserModelId } from "./window-identity";

// Squirrel (the win32 installer) launches the freshly-installed exe with a
// `--squirrel-install`/`--squirrel-updated`/`--squirrel-uninstall` argv while it
// wires up shortcuts, then kills it. electron-squirrel-startup handles those events
// (creating/removing the shortcuts) and returns true, in which case we must quit
// immediately and boot nothing else. No-op on macOS/Linux and on normal launches.
if (squirrelStartup) {
  app.quit();
}

// The native directory picker (#379): the detached daemon cannot open a dialog, so the
// renderer asks MAIN for the path and forwards it to `repository.choose`. Electron-native
// residue.
const CHOOSE_DIRECTORY_CHANNEL = "rennet:choose-directory";
// The source-aware project picker's WSL branch: the renderer asks MAIN which distros
// are installed, so it can list them instead of the user typing a distro name.
const LIST_WSL_DISTROS_CHANNEL = "rennet:list-wsl-distros";
// The renderer asks MAIN to ensure the daemon for a project PATH and hand back its ws port —
// a host path resolves the host daemon, a `\\wsl.localhost\<distro>\…` path spawns (or
// reuses) that distro's in-distro daemon and returns ITS loopback port. The renderer then
// dials that port as a connection target. A distro with no Node rejects, surfacing a prompt.
const RESOLVE_DAEMON_FOR_PATH_CHANNEL = "rennet:resolve-daemon-for-path";
// The renderer's connect-flow decisions land here and get appended to WSL_CONNECT_LOG_FILE,
// alongside MAIN's own resolve trace. This is the SHELL-side view of a WSL directory pick →
// distro-daemon connect (the in-distro daemon logs its own boot); loud on purpose so a live
// run on a headless Windows/WSL box is readable over SSH. Never carries a token.
const WSL_CONNECT_LOG_CHANNEL = "rennet:wsl-connect-log";
const WSL_CONNECT_LOG_FILE = "wsl-connect.log";
const APP_ORIGIN = "app://rennet";
// The flag the preload reads to build its WsRennetBridge URL; appended to the renderer
// process argv via `webPreferences.additionalArguments` (the boot-time-constant pattern
// under contextIsolation + sandbox).
const WS_PORT_ARG = "--rennet-ws-port=";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

if (process.env.RENNET_USER_DATA) app.setPath("userData", process.env.RENNET_USER_DATA);

function isTrustedAppUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "app:" &&
    url.hostname === "rennet" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function installApplicationMenu(): void {
  // A STATIC platform menu, not a registry projection (the command-built menu was removed
  // by `remove-app-menu`). macOS gets the standard app/edit/window roles; Windows/Linux get
  // no application menu. The palette (mod+k) and settings Keyboard section are the command
  // surfaces. Set once at startup — it never depends on renderer state.
  const template = buildStaticMenu(process.platform === "darwin");
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}

function registerDialogHandler(): void {
  // The renderer's bridge composition calls this to satisfy `repository.choose` (#379).
  // RENNET_TEST_REPO short-circuits the dialog (e2e / headless), mirroring the server's
  // former chooser so the picker path stays test-driveable; otherwise the native dialog
  // runs and the chosen directory is forwarded to the daemon as the command's `path`.
  ipcMain.handle(CHOOSE_DIRECTORY_CHANNEL, async (event) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return null;
    if (process.env.RENNET_TEST_REPO) return process.env.RENNET_TEST_REPO;
    const result = await dialog.showOpenDialog({
      title: "Choose a repository to review",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

const execFileAsync = promisify(execFile);

/**
 * `wsl.exe -l -q` writes UTF-16LE (ponytail note in `listWslDistros`'s parser):
 * decode stdout as `utf16le` here, at the edge, before it reaches the node-free
 * core parser.
 */
function registerListWslDistrosHandler(): void {
  ipcMain.handle(LIST_WSL_DISTROS_CHANNEL, async (event) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return [];
    return listWslDistros(async (cmd, args) => {
      const { stdout } = await execFileAsync(cmd, args, { encoding: "utf16le" });
      return stdout;
    });
  });
}

/**
 * Append one line to `<userData>/wsl-connect.log` — the shell-side trace of a WSL connect
 * (both MAIN's own resolve and the renderer's forwarded decisions). Best-effort: a failed
 * write must never break a connect, so it swallows. One JSON object per line, ISO-stamped.
 */
function appendWslConnectLog(hostDataDir: string, entry: Record<string, unknown>): void {
  try {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    appendFileSync(join(hostDataDir, WSL_CONNECT_LOG_FILE), line, "utf8");
  } catch {
    // debug log only — a full disk or a bad path must not sink the connect flow
  }
}

/**
 * Resolve the ws port of the daemon that should serve a project at `path`, SELECTED BY its
 * execution locus (`ensureDaemonForProject`): a host path → the host daemon; a WSL path →
 * that distro's in-distro daemon (spawned once, reused). Resolved lazily each call so a
 * restarted daemon's fresh ephemeral port is always current. A failure (no Node in the
 * distro, WSL unavailable) rejects with a plain message the renderer turns into a prompt.
 *
 * Every call writes its detected locus + resolved port (or the failure) to the WSL-connect
 * debug log, and a companion channel appends the renderer's own connect decisions there too.
 */
function registerDaemonForPathResolver(hostDataDir: string): void {
  ipcMain.handle(RESOLVE_DAEMON_FOR_PATH_CHANNEL, async (event, path: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return null;
    if (typeof path !== "string" || path.length === 0) return null;
    const locus = detectLocus(path);
    appendWslConnectLog(hostDataDir, { side: "main", event: "resolve", path, locus });
    try {
      const port = await ensureDaemonForProject(path, hostDataDir);
      appendWslConnectLog(hostDataDir, { side: "main", event: "resolved", path, locus, port });
      return port;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendWslConnectLog(hostDataDir, { side: "main", event: "failed", path, locus, message });
      throw error;
    }
  });
  // The renderer forwards its connect-flow decisions (detect → switch → error) here.
  ipcMain.on(WSL_CONNECT_LOG_CHANNEL, (event, entry: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return;
    if (typeof entry !== "object" || entry === null) return;
    appendWslConnectLog(hostDataDir, { side: "renderer", ...(entry as Record<string, unknown>) });
  });
}

function registerAppProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = resolve(rendererRoot, `.${normalize(requestedPath)}`);
    if (target !== rendererRoot && !target.startsWith(rendererRoot + sep)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

async function createWindow(wsPort: number): Promise<void> {
  const window = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    // One seamless OPAQUE window (2026-08-19 overhaul; root DESIGN.md §Material).
    // Glass/vibrancy/acrylic are retired: the whole window paints the theme's warm
    // canvas, titlebar included. The pre-paint backgroundColor follows the OS
    // appearance — the best guess available before the renderer loads its stored
    // scheme. A user who forces the scheme OPPOSITE to the OS sees one brief
    // canvas-swap on launch; the renderer stamps data-scheme before its first
    // paint, so the swap is between the two theme canvases, never white/black.
    // macOS hides the native titlebar (traffic lights overlay the in-app bar, which
    // reserves their inset via [data-platform="darwin"]); win32/linux keep the
    // native frame (titlebar, snap, drag) above the web content.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e0d0c" : "#fbfaf7",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    // Version in the native titlebar (visible on the win32 native frame; macOS shows
    // it in the standard titlebar too). `page-title-updated` is suppressed below so
    // the renderer's static <title>Rennet</title> can't overwrite it after load.
    title: `Rennet ${app.getVersion()}`,
    // Dev runs (and Linux) have no exe-embedded icon, so without this they show the
    // default Electron icon in the titlebar/taskbar. Resolved lazily and only when
    // the brand file exists — the packaged win32 exe carries the `.ico` itself, so a
    // missing file degrades to Electron's default rather than throwing.
    icon: brandWindowIcon(__dirname, process.platform),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The loopback WS port the renderer's WsRennetBridge connects to (#378). Appended
      // to the renderer process argv; the sandboxed preload reads it and exposes it.
      additionalArguments: [`${WS_PORT_ARG}${wsPort}`, `--rennet-version=${app.getVersion()}`],
    },
  });
  // Keep the versioned title: Electron replaces the window title with the page's
  // <title> on every load unless the update is prevented.
  window.on("page-title-updated", (event) => event.preventDefault());
  // External links open in the OS BROWSER, never a second Electron window. The
  // renderer's `target="_blank"` anchors (e.g. the GitHub device-flow "enter this
  // code" link) land here — a bare deny made them silent no-ops (field bug,
  // 2026-08-19: the connect flow's verification link did nothing). Only http(s)
  // leaves; every other scheme stays denied outright.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, destination) => {
    if (isTrustedAppUrl(destination)) return;
    event.preventDefault();
    // Same policy for in-page anchors without target="_blank".
    if (isExternalHttpUrl(destination)) void shell.openExternal(destination);
  });
  // The application menu is installed once at startup (installApplicationMenu): the
  // static macOS role menu, or none on Windows/Linux. It never depends on this window.
  await window.loadURL(`${APP_ORIGIN}/`);
}

// The daemon's WS port for THIS run, so tray "Open Rennet" / macOS `activate` can recreate a
// window that re-dials the same daemon after the last one closed (tray-presence residency).
let activeWsPort: number | undefined;
// Retained at module scope so the tray is never garbage-collected — Electron drops a Tray whose
// only reference is a local, and in dev nothing else holds it, leaving a window-less, tray-less,
// un-quittable resident app (review finding 1). Destroyed on `will-quit`.
let trayController: TrayController | null = null;

// Coordinates macOS Dock show/hide so a rapid close→reopen never trips the documented
// "hide is a no-op within ~1s of show" quirk (review finding 4). Off darwin, show/hide are
// no-ops, so this is inert on Windows/Linux.
const dock = createDockCoordinator({
  show: () => (process.platform === "darwin" ? app.dock?.show() : undefined),
  hide: () => {
    if (process.platform === "darwin") app.dock?.hide();
  },
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
});

/** Focus the live window, or recreate one (Dock back first) — shared by tray Open and activate. */
async function ensureWindowShared(): Promise<void> {
  await ensureWindow({
    hasWindow: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed()),
    focusExisting: () => {
      const w = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.focus();
    },
    showDock: () => dock.show(),
    recreate: async () => {
      if (activeWsPort !== undefined) await createWindow(activeWsPort);
    },
  });
  // A window lifecycle event is a cue that owned-daemon state may have moved — re-probe so the
  // tray Quit label stays truthful between the low-frequency refreshes (review finding 5).
  void trayController?.refreshOwnership();
}

// Single-instance guard (review finding 3): the primary holds the lock and routes a relaunch's
// `second-instance` back to its existing window; a later instance quits before doing any startup
// work (the whenReady body returns early when this is false), so no second daemon/tray appears.
const isPrimaryInstance = acquireSingleInstance({
  requestLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  onPrimary: () => app.on("second-instance", () => void ensureWindowShared()),
});

/** Tray "Quit completely": stop the OWNED daemon (graceful), then exit. No prompt (spec). */
async function quitCompletely(dataDir: string): Promise<void> {
  await stopOwnedDaemon(dataDir);
  app.quit();
}

app.whenReady().then(async () => {
  // A second instance lost the single-instance lock and already called quit — do no startup
  // work (no daemon spawn, no window, no tray). The primary handles the relaunch.
  if (!isPrimaryInstance) return;
  // Install the static application menu first, before any await, so macOS shows the roles-only
  // menu instead of Electron's default while the daemon starts (or hangs, or fails its dialog).
  installApplicationMenu();
  // Stable Windows taskbar/toast identity — set before any window so grouping,
  // pinning, and notifications attach to this AUMID instead of a per-exe default. On
  // a Squirrel install we must match the id Squirrel stamped on the shortcut, or
  // toasts go dark; the resolver picks that automatically from the install layout.
  if (process.platform === "win32") {
    app.setAppUserModelId(resolveAppUserModelId(process.platform, process.execPath, existsSync));
  }
  // The shell is a supervisor + client now (#379): the composition root runs in a DETACHED
  // daemon, not in-process. Find a healthy daemon for this data dir or spawn one, then dial
  // it exactly as phase 2 dialed the in-process listener. The daemon owns the Electron-free
  // effects it used to receive from the shell (net→global fetch; the repo dialog moves to
  // the renderer picker forwarded as `repository.choose`'s `path`). Persistence is unchanged:
  // the daemon opens the same rennet.sqlite / projects.json / threads under `dataDir`.
  const dataDir = app.getPath("userData");
  let wsPort: number;
  try {
    wsPort = await ensureDaemon(dataDir);
  } catch (error) {
    const cause = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim();
    dialog.showErrorBox(
      "Rennet daemon failed to start",
      `Cause: ${cause}\nLog: ${join(dataDir, "daemon.log")}`,
    );
    app.quit();
    return;
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  registerAppProtocol();
  registerDialogHandler();
  registerListWslDistrosHandler();
  registerDaemonForPathResolver(dataDir);
  await createWindow(wsPort);
  activeWsPort = wsPort;

  // Tray-resident presence (tray-presence). The updater and the tray share ONE readiness
  // store and ONE apply path: the tray subscribes to the same store the renderer badge
  // rides, and its update line calls the same apply. Auto-update is packaged-only (dev/test
  // have no feed); the tray always exists.
  const update = app.isPackaged ? startAutoUpdate(isTrustedAppUrl) : undefined;
  const tray = createTray({
    baseDir: __dirname,
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    version: app.getVersion(),
    // Health-verified, cached, and self-refreshing — see createTray / isOwnedDaemonRunning.
    probeOwnedDaemon: () => isOwnedDaemonRunning(dataDir),
    openWindow: () => void ensureWindowShared(),
    applyUpdate: () => update?.applyUpdate(),
    quitCompletely: () => void quitCompletely(dataDir),
  });
  trayController = tray;
  update?.readiness.subscribe(() => tray.setUpdateReady(true));
  // Staged-at-boot: readiness may already be set (seeded before the tray existed) — sync it.
  if (update?.readiness.ready) tray.setUpdateReady(true);
});

// Reopen from the Dock/menu bar (macOS) recreates or focuses the window without a relaunch.
app.on("activate", () => void ensureWindowShared());

// App quit stops NOTHING implicitly (#379): the daemon and any running review turn outlive
// the window. No `before-quit` shutdown. The tray's "Quit completely" is the ONE explicit,
// scoped teardown (it stops the owned daemon first, then exits) — see ADR 0001.
// The system right-click menu (copy/paste/select-all, link copy, spellcheck) on
// every window this app ever creates. Contextual: an empty template shows nothing.
app.on("web-contents-created", (_event, contents) => {
  contents.on("context-menu", (_menuEvent, params) => {
    const template = buildContextMenuTemplate(params, {
      replaceMisspelling: (suggestion) => contents.replaceMisspelling(suggestion),
      copyText: (text) => clipboard.writeText(text),
    });
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup();
  });
});

// Closing the last window keeps Rennet tray-resident: it does NOT quit and stops nothing;
// macOS hides the Dock icon while window-less (the coordinator defers a too-soon hide;
// ensureWindow shows it again on reopen).
app.on("window-all-closed", () =>
  residencyOnAllWindowsClosed({ hideDock: () => dock.requestHide() }),
);

// The tray is retained at module scope (finding 1); release it as the app actually exits so
// the icon does not linger. This is teardown of an OWNED UI resource — it stops no daemon.
app.on("will-quit", () => {
  trayController?.destroy();
  trayController = null;
});
