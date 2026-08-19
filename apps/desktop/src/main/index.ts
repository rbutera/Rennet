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
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import { startAutoUpdate } from "./auto-update";
import { buildContextMenuTemplate } from "./context-menu";
import { ensureDaemon } from "./daemon-supervisor";
import { applyMenuUpdate } from "./menu";
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
    // One seamless OPAQUE window (2026-08-19 overhaul; root DESIGN.md §Material).
    // Glass/vibrancy/acrylic are retired: the whole window paints the theme's warm
    // canvas, titlebar included. The pre-paint backgroundColor matches the resolved
    // scheme's canvas so there is no white/black flash before the renderer loads.
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

app.whenReady().then(async () => {
  // Stable Windows taskbar/toast identity — set before any window so grouping,
  // pinning, and notifications attach to this AUMID instead of a per-exe default. On
  // a Squirrel install we must match the id Squirrel stamped on the shortcut, or
  // toasts go dark; the resolver picks that automatically from the install layout.
  if (process.platform === "win32") {
    app.setAppUserModelId(resolveAppUserModelId(process.platform, process.execPath, existsSync));
  }
  // Auto-update, packaged builds only — dev/test runs have no release to pull and no
  // Squirrel/Squirrel.Mac feed. Best-effort and self-silencing (see auto-update.ts):
  // on unsigned macOS it no-ops instead of crashing; on Windows it activates once
  // Squirrel artifacts ship in a release.
  if (app.isPackaged) startAutoUpdate(isTrustedAppUrl);
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
});

// App quit stops NOTHING (#379): the daemon and any running review turn outlive the window.
// No `before-quit` shutdown — that implicit teardown was the thing this phase removes.
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

app.on("window-all-closed", () => app.quit());
