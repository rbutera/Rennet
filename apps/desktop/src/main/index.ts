import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { menuRunPayloadSchema } from "@rennet/protocol";
import { createRennetServer, type RennetServer } from "@rennet/server";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from "electron";
import squirrelStartup from "electron-squirrel-startup";
import { startAutoUpdate } from "./auto-update";
import { applyMenuUpdate } from "./menu";
import { brandWindowIcon, resolveAppUserModelId } from "./window-identity";

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

// The in-process server handle (#377). Composed in `whenReady` once the app data
// path is resolved; `registerCommandHandler` forwards each IPC invoke to it and
// `before-quit` shuts it down. A phase-2 transport speaks to this same handle.
let server: RennetServer | null = null;

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
    title: "Rennet",
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
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isTrustedAppUrl(destination)) event.preventDefault();
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
  if (app.isPackaged) startAutoUpdate();
  // The composition root now lives in @rennet/server (#377). The shell supplies the
  // Electron-owned effects — the resolved user-data dir, the process env, the repo
  // chooser dialog, shell.openPath, and net.fetch. Command invocation and the
  // progress/ask-stream streams travel the server's loopback WS listener (#378), which
  // the renderer dials as client #1 — no `rennet:invoke` IPC path exists anymore.
  // Persistence is byte-for-byte: the server opens the same rennet.sqlite /
  // projects.json / threads under `dataDir`.
  server = await createRennetServer({
    dataDir: app.getPath("userData"),
    env: process.env,
    serverVersion: app.getVersion(),
    chooseRepositoryFallback: async () => {
      const result = await dialog.showOpenDialog({
        title: "Choose a repository to review",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    // Background rehydration progress now fans out to every WS client inside the
    // server's listener (#378); the old per-window `webContents.send` broadcast is gone.
    openPath: async (absPath) => (await shell.openPath(absPath)) === "",
    httpFetch: async (url, init) => {
      const res = await net.fetch(url, init);
      return { status: res.status, headers: res.headers, text: () => res.text() };
    },
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  registerAppProtocol();
  registerMenuHandler();
  await createWindow(server.wsPort);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  // Hand the quit to the server: it aborts in-flight turns, closes the watcher and
  // rehydration, and closes the store (#251 criterion 4). Idempotent.
  server?.shutdown();
});
