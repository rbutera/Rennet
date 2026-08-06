import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitCaptureAdapter, RepoWatcher, SqliteReviewStore } from "@rennet/adapters";
import { ReviewService } from "@rennet/core";
import {
  type CommandName,
  isCommandName,
  parseCommandInput,
  parseCommandOutput,
} from "@rennet/protocol";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from "electron";

const IPC_CHANNEL = "rennet:invoke";
const APP_ORIGIN = "app://rennet";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

if (process.env.RENNET_USER_DATA) app.setPath("userData", process.env.RENNET_USER_DATA);

const capture = new GitCaptureAdapter();
const watcher = new RepoWatcher();
let store: SqliteReviewStore;
let service: ReviewService;
let repositoryDirty = false;
const allowedRoots = new Set<string>();

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

function assertAllowedRepository(repositoryPath: string): void {
  if (!allowedRoots.has(repositoryPath)) throw new Error("Repository access was not granted");
}

async function dispatch(name: CommandName, rawInput: unknown): Promise<unknown> {
  switch (name) {
    case "app.bootstrap": {
      parseCommandInput(name, rawInput);
      const review = service.bootstrap();
      if (review) {
        allowedRoots.add(review.repositoryRoot);
        watcher.start(review.repositoryRoot, () => {
          repositoryDirty = true;
        });
      }
      return parseCommandOutput(name, { review });
    }
    case "repository.choose": {
      parseCommandInput(name, rawInput);
      const testPath = process.env.RENNET_TEST_REPO;
      if (testPath) {
        allowedRoots.add(testPath);
        return parseCommandOutput(name, { path: testPath });
      }
      const result = await dialog.showOpenDialog({
        title: "Choose a repository to review",
        properties: ["openDirectory"],
      });
      const path = result.canceled ? null : (result.filePaths[0] ?? null);
      if (path) allowedRoots.add(path);
      return parseCommandOutput(name, { path });
    }
    case "review.capture": {
      const input = parseCommandInput(name, rawInput);
      assertAllowedRepository(input.repoPath);
      const review = await service.capture(input.commandId, input.repoPath, input.reviewId);
      allowedRoots.add(review.repositoryRoot);
      repositoryDirty = false;
      watcher.start(review.repositoryRoot, () => {
        repositoryDirty = true;
      });
      return parseCommandOutput(name, { review });
    }
    case "review.setDisposition": {
      const input = parseCommandInput(name, rawInput);
      const review = service.setDisposition(
        input.commandId,
        input.reviewId,
        input.patchsetId,
        input.path,
        input.disposition,
        input.body,
      );
      return parseCommandOutput(name, { review });
    }
    case "review.checkFreshness": {
      const input = parseCommandInput(name, rawInput);
      assertAllowedRepository(input.repoPath);
      const current = service.bootstrap();
      if (!current || current.id !== input.reviewId) throw new Error("Review not found");
      if (!repositoryDirty) return parseCommandOutput(name, { review: current });
      const review = await service.checkFreshness(input.commandId, input.reviewId, input.repoPath);
      repositoryDirty = false;
      return parseCommandOutput(name, { review });
    }
    case "review.regenerate": {
      const input = parseCommandInput(name, rawInput);
      assertAllowedRepository(input.repoPath);
      const review = await service.regenerate(input.commandId, input.reviewId, input.repoPath);
      repositoryDirty = false;
      return parseCommandOutput(name, { review });
    }
  }
}

function registerCommandHandler(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, request: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url))
      throw new Error("Untrusted renderer origin");
    if (!request || typeof request !== "object") throw new Error("Invalid command envelope");
    const { name, input } = request as { name?: unknown; input?: unknown };
    if (typeof name !== "string" || !isCommandName(name)) throw new Error("Unknown command");
    return dispatch(name, input);
  });
}

function registerAppProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = resolve(rendererRoot, `.${normalize(requestedPath)}`);
    if (target !== rendererRoot && !target.startsWith(`${rendererRoot}/`)) {
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
    backgroundColor: "#111318",
    title: "Rennet",
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
  window.removeMenu();
  await window.loadURL(`${APP_ORIGIN}/`);
}

app.whenReady().then(async () => {
  store = new SqliteReviewStore(join(app.getPath("userData"), "rennet.sqlite"));
  service = new ReviewService(capture, store);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  registerAppProtocol();
  registerCommandHandler();
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  void watcher.close();
  store?.close();
});
