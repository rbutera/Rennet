import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { menuRunPayloadSchema } from "@rennet/protocol";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import { startAutoUpdate } from "./auto-update";
import { buildContextMenuTemplate } from "./context-menu";
import { ensureDaemon, isOwnedDaemonRunning, stopOwnedDaemon } from "./daemon-supervisor";
import { applyMenuUpdate } from "./menu";
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

// The application menu channels (#44): the renderer PROJECTS the registry into menu
// sections and pushes them on `menu-update`; MAIN builds `Menu.setApplicationMenu` and
// routes an item click back on `menu-run` as a command id the renderer runs. These are
// the ONLY remaining IPC channels — command invocation and the progress/ask-stream push
// streams moved to the loopback WS transport (#378), where the renderer is client #1.
const MENU_UPDATE_CHANNEL = "rennet:menu-update";
const MENU_RUN_CHANNEL = "rennet:menu-run";
// The native directory picker (#379): the detached daemon cannot open a dialog, so the
// renderer asks MAIN for the path and forwards it to `repository.choose`. Electron-native
// residue, same family as the menu channels.
const CHOOSE_DIRECTORY_CHANNEL = "rennet:choose-directory";
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

function registerMenuHandler(): void {
  // The renderer projects the registry into serializable sections (#44); MAIN builds
  // the Electron menu and sets it. A menu item click routes back as a command id the
  // renderer runs through the same handler the palette uses (single dispatcher). The
  // command accelerators are display-only, so a chord never double-fires.
  ipcMain.on(MENU_UPDATE_CHANNEL, (event, payload: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return;
    applyMenuUpdate(payload, {
      isMac: process.platform === "darwin",
      onRun: (id) => {
        const runPayload = menuRunPayloadSchema.parse({ id });
        if (!event.sender.isDestroyed()) event.sender.send(MENU_RUN_CHANNEL, runPayload);
      },
      buildFromTemplate: (template) => Menu.buildFromTemplate(template),
      setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
    });
  });
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
    // Real glass (issue #61): the CHROME is genuinely translucent over the actual
    // desktop, not a painted in-app gradient — the OS compositor supplies the
    // blurred material behind the frosted chrome. On macOS that is native window
    // vibrancy over a transparent window. On Windows transparency only works on a
    // FRAMELESS window (no titlebar, no drag) and gets NO compositor blur — the
    // raw desktop showed straight through — so win32 keeps the NATIVE frame
    // (titlebar, snap, drag) and asks DWM for the acrylic material instead
    // (Windows 11; older builds just get a dark solid backing). Content surfaces
    // (panels, cards, code, paper) paint their own SOLID backgrounds on top, so
    // legibility never rides on the wallpaper (the #115 correction: glass is the
    // frame, not the content).
    ...(process.platform === "darwin"
      ? {
          transparent: true,
          backgroundColor: "#00000000",
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : process.platform === "win32"
        ? { backgroundMaterial: "acrylic" as const, backgroundColor: "#00000000" }
        : { transparent: true, backgroundColor: "#00000000" }),
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
      additionalArguments: [`${WS_PORT_ARG}${wsPort}`],
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
  // No `window.removeMenu()` — the application menu is now built from the registry
  // (#44) once the renderer sends its first `menu.update`. Until then Electron's
  // default menu stands (Edit/Window roles), never a missing menu bar.
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
  registerMenuHandler();
  registerDialogHandler();
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
