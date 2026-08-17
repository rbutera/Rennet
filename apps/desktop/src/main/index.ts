import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isCommandName,
  menuRunPayloadSchema,
  type ProjectProcessEvent,
  type ReviewAskStreamEvent,
} from "@rennet/protocol";
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

const IPC_CHANNEL = "rennet:invoke";
// The push channel a long-running command streams live progress on (today
// `project.process`'s snapshot-build narration). The renderer's `onProgress`
// bridge filters by the `commandId` it passed to `invoke`.
const PROGRESS_CHANNEL = "rennet:progress";
// The push channel a review's conversation streams its token deltas on (#251). Keyed
// by `reviewId` (NOT commandId) so the renderer's `onAskStream` re-attaches after a
// reload while the turn keeps running in main. Each event carries its own turnId.
const ASK_STREAM_CHANNEL = "rennet:ask-stream";
// The application menu channels (#44): the renderer PROJECTS the registry into menu
// sections and pushes them on `menu-update`; MAIN builds `Menu.setApplicationMenu` and
// routes an item click back on `menu-run` as a command id the renderer runs.
const MENU_UPDATE_CHANNEL = "rennet:menu-update";
const MENU_RUN_CHANNEL = "rennet:menu-run";
const APP_ORIGIN = "app://rennet";

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

function registerCommandHandler(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, request: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url))
      throw new Error("Untrusted renderer origin");
    if (!request || typeof request !== "object") throw new Error("Invalid command envelope");
    const { name, input } = request as { name?: unknown; input?: unknown };
    if (typeof name !== "string" || !isCommandName(name)) throw new Error("Unknown command");
    if (!server) throw new Error("The command router is not ready");
    // A command that carries a `commandId` may stream live progress; push each
    // event on the progress channel keyed by that id so the renderer can filter to
    // its own invocation. `sender.isDestroyed()` guards a window closed mid-build.
    const commandId =
      input &&
      typeof input === "object" &&
      typeof (input as { commandId?: unknown }).commandId === "string"
        ? (input as { commandId: string }).commandId
        : undefined;
    const emitProgress = commandId
      ? (progress: ProjectProcessEvent): void => {
          if (!event.sender.isDestroyed())
            event.sender.send(PROGRESS_CHANNEL, { commandId, event: progress });
        }
      : undefined;
    // #251: a review.ask carrying a reviewId may stream its answer's tokens; push each
    // event on the ask-stream channel keyed by that reviewId so the renderer filters to
    // its own review (and can re-attach by reviewId after a reload).
    const reviewId =
      input &&
      typeof input === "object" &&
      typeof (input as { reviewId?: unknown }).reviewId === "string"
        ? (input as { reviewId: string }).reviewId
        : undefined;
    const emitAskStream = reviewId
      ? (streamEvent: ReviewAskStreamEvent): void => {
          if (!event.sender.isDestroyed())
            event.sender.send(ASK_STREAM_CHANNEL, { reviewId, event: streamEvent });
        }
      : undefined;
    return server.dispatch(name, input, {
      emitProgress,
      progressRecipientId: event.sender.id,
      emitAskStream,
    });
  });
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

async function createWindow(): Promise<void> {
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
  // chooser dialog, the progress broadcast, shell.openPath, and net.fetch — and
  // forwards `rennet:invoke` to `server.dispatch`. Persistence is byte-for-byte: the
  // server opens the same rennet.sqlite / projects.json / threads under `dataDir`.
  server = createRennetServer({
    dataDir: app.getPath("userData"),
    env: process.env,
    chooseRepositoryFallback: async () => {
      const result = await dialog.showOpenDialog({
        title: "Choose a repository to review",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    broadcastProgress: (commandId, event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(PROGRESS_CHANNEL, { commandId, event });
      }
    },
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
  registerCommandHandler();
  registerMenuHandler();
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  // Hand the quit to the server: it aborts in-flight turns, closes the watcher and
  // rehydration, and closes the store (#251 criterion 4). Idempotent.
  server?.shutdown();
});
