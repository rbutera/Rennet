import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
  const autoUpdaterMock = new Emitter() as InstanceType<typeof Emitter> & {
    quitAndInstall: ReturnType<typeof vi.fn>;
  };
  autoUpdaterMock.quitAndInstall = vi.fn();
  return {
    autoUpdaterMock,
    ipcHandlers: new Map<string, (event: unknown) => unknown>(),
    ipcListeners: new Map<string, (event: unknown) => void>(),
    windowSends: [] as Array<{ channel: string; payload: unknown }>,
    windows: [] as Array<{
      webContents: { isDestroyed(): boolean; send(c: string, p: unknown): void };
    }>,
    updateElectronApp: vi.fn(),
  };
});
const { autoUpdaterMock, ipcHandlers, ipcListeners, windowSends } = harness;
const updateElectronApp = harness.updateElectronApp;

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test", quit: () => undefined },
  autoUpdater: harness.autoUpdaterMock,
  ipcMain: {
    handle: (channel: string, handler: (event: unknown) => unknown) =>
      harness.ipcHandlers.set(channel, handler),
    on: (channel: string, listener: (event: unknown) => void) =>
      harness.ipcListeners.set(channel, listener),
  },
  BrowserWindow: { getAllWindows: () => harness.windows },
}));

vi.mock("update-electron-app", () => ({
  updateElectronApp: (options: unknown) => harness.updateElectronApp(options),
  UpdateSourceType: { ElectronPublicUpdateService: 0, StaticStorage: 1 },
}));

import {
  createUpdateReadiness,
  startAutoUpdate,
  UPDATE_APPLY_CHANNEL,
  UPDATE_READY_CHANNEL,
} from "./auto-update";

const quietLogger = { error: vi.fn() } as unknown as Console;
const trusted = { senderFrame: { url: "app://rennet/" } };
const untrusted = { senderFrame: { url: "https://evil.example/" } };
const isTrusted = (url: string) => url.startsWith("app://rennet");

function liveWindow() {
  const send = vi.fn((channel: string, payload: unknown) => windowSends.push({ channel, payload }));
  return { webContents: { isDestroyed: () => false, send } };
}

beforeEach(() => {
  ipcHandlers.clear();
  ipcListeners.clear();
  windowSends.length = 0;
  harness.windows.length = 0;
  autoUpdaterMock.removeAllListeners();
  vi.clearAllMocks();
});

describe("createUpdateReadiness", () => {
  it("starts with nothing ready and broadcasts nothing", () => {
    const broadcast = vi.fn();
    const readiness = createUpdateReadiness(broadcast);
    expect(readiness.ready).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("caches the downloaded release name and broadcasts it", () => {
    const broadcast = vi.fn();
    const readiness = createUpdateReadiness(broadcast);
    readiness.markDownloaded("0.2.3");
    expect(readiness.ready).toEqual({ version: "0.2.3" });
    expect(broadcast).toHaveBeenCalledWith({ version: "0.2.3" });
  });

  it("notifies subscribers (the tray) on each download, alongside the window broadcast", () => {
    const broadcast = vi.fn();
    const readiness = createUpdateReadiness(broadcast);
    const trayListener = vi.fn();
    readiness.subscribe(trayListener);
    readiness.markDownloaded("0.2.4");
    expect(trayListener).toHaveBeenCalledWith({ version: "0.2.4" });
    expect(broadcast).toHaveBeenCalledWith({ version: "0.2.4" });
  });

  it("treats a non-string or blank release name as version-unknown, still ready", () => {
    const broadcast = vi.fn();
    const readiness = createUpdateReadiness(broadcast);
    readiness.markDownloaded(undefined);
    expect(readiness.ready).toEqual({});
    readiness.markDownloaded("   ");
    expect(readiness.ready).toEqual({});
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});

describe("startAutoUpdate wiring", () => {
  it("configures the update client at the 5-minute minimum with the stock dialog off", () => {
    startAutoUpdate(isTrusted, quietLogger);
    expect(updateElectronApp).toHaveBeenCalledWith(
      expect.objectContaining({
        updateInterval: "5 minutes",
        notifyUser: false,
        updateSource: expect.objectContaining({ type: expect.anything() }),
      }),
    );
  });

  it("broadcasts to live windows when a download completes", () => {
    const window = liveWindow();
    harness.windows.push(window);
    startAutoUpdate(isTrusted, quietLogger);
    autoUpdaterMock.emit("update-downloaded", {}, "notes", "0.9.9");
    expect(window.webContents.send).toHaveBeenCalledWith(UPDATE_READY_CHANNEL, {
      version: "0.9.9",
    });
  });

  it("reaches a windowless tray subscriber through the real wiring (no window needed)", () => {
    // The tray subscribes to the handle's readiness store; a download must reach it even with
    // zero windows open (the whole point of tray residency). This drives startAutoUpdate's own
    // update-downloaded wiring — not a manual markDownloaded — with harness.windows empty
    // (review finding 6).
    const handle = startAutoUpdate(isTrusted, quietLogger);
    const trayListener = vi.fn();
    handle.readiness.subscribe(trayListener);
    expect(harness.windows).toHaveLength(0); // windowless
    autoUpdaterMock.emit("update-downloaded", {}, "notes", "3.1.4");
    expect(trayListener).toHaveBeenCalledWith({ version: "3.1.4" });
  });

  it("replays cached readiness to a trusted late subscriber and null before any download", () => {
    startAutoUpdate(isTrusted, quietLogger);
    const replay = ipcHandlers.get(UPDATE_READY_CHANNEL);
    if (!replay) throw new Error("replay handler not registered");
    expect(replay(trusted)).toBeNull();
    autoUpdaterMock.emit("update-downloaded", {}, "notes", "1.0.0");
    expect(replay(trusted)).toEqual({ version: "1.0.0" });
    expect(replay(untrusted)).toBeNull();
  });

  it("applies only from a trusted frame and routes to quitAndInstall", () => {
    startAutoUpdate(isTrusted, quietLogger);
    const apply = ipcListeners.get(UPDATE_APPLY_CHANNEL);
    if (!apply) throw new Error("apply listener not registered");
    apply(untrusted);
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    apply(trusted);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("degrades to a silent no-op when the update client throws (unsigned macOS)", () => {
    updateElectronApp.mockImplementationOnce(() => {
      throw new Error("code signing required");
    });
    expect(() => startAutoUpdate(isTrusted, quietLogger)).not.toThrow();
    autoUpdaterMock.emit("error", new Error("still quiet"));
    expect(windowSends).toEqual([]);
  });
});

describe("stagedNewerVersion", () => {
  const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const roots: string[] = [];
  function squirrelRoot(dirs: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "rennet-squirrel-"));
    roots.push(root);
    for (const dir of dirs) mkdirSync(join(root, dir));
    return root;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("finds the newest staged sibling strictly above the running version", async () => {
    const { stagedNewerVersion } = await import("./auto-update");
    const root = squirrelRoot(["app-0.2.5", "app-0.2.6", "app-0.2.4", "packages"]);
    expect(stagedNewerVersion(join(root, "app-0.2.5", "Rennet.exe"), "0.2.5", "win32")).toBe(
      "0.2.6",
    );
  });

  it("returns null with nothing newer, on non-Squirrel layouts, and off win32", async () => {
    const { stagedNewerVersion } = await import("./auto-update");
    const root = squirrelRoot(["app-0.2.5", "app-0.2.4"]);
    const exe = join(root, "app-0.2.5", "Rennet.exe");
    expect(stagedNewerVersion(exe, "0.2.5", "win32")).toBeNull();
    expect(stagedNewerVersion(join(root, "dev-build", "Rennet.exe"), "0.2.5", "win32")).toBeNull();
    expect(stagedNewerVersion(exe, "0.2.5", "darwin")).toBeNull();
    expect(
      stagedNewerVersion(join(root, "gone", "app-0.2.5", "x.exe"), "0.2.5", "win32"),
    ).toBeNull();
  });

  it("compares numerically, not lexically", async () => {
    const { stagedNewerVersion } = await import("./auto-update");
    const root = squirrelRoot(["app-0.9.0", "app-0.10.0"]);
    expect(stagedNewerVersion(join(root, "app-0.9.0", "Rennet.exe"), "0.9.0", "win32")).toBe(
      "0.10.0",
    );
  });
});

describe("staged-at-boot seeding", () => {
  it("seeds readiness from a detected staged update so the replay badges late renderers", () => {
    startAutoUpdate(isTrusted, quietLogger, () => "0.2.6");
    const replay = ipcHandlers.get(UPDATE_READY_CHANNEL);
    if (!replay) throw new Error("replay handler not registered");
    expect(replay(trusted)).toEqual({ version: "0.2.6" });
  });

  it("stays unseeded when nothing is staged", () => {
    startAutoUpdate(isTrusted, quietLogger, () => null);
    const replay = ipcHandlers.get(UPDATE_READY_CHANNEL);
    if (!replay) throw new Error("replay handler not registered");
    expect(replay(trusted)).toBeNull();
  });
});

describe("updateSourceFor", () => {
  it("points win32 straight at GitHub Releases latest/download", async () => {
    const { updateSourceFor, UPDATE_REPO } = await import("./auto-update");
    expect(updateSourceFor("win32", UPDATE_REPO)).toEqual({
      type: 1,
      baseUrl: "https://github.com/rbutera/rennet/releases/latest/download",
    });
  });

  it("keeps darwin (and others) on the Electron update service", async () => {
    const { updateSourceFor } = await import("./auto-update");
    expect(updateSourceFor("darwin", "rbutera/rennet")).toEqual({
      type: 0,
      repo: "rbutera/rennet",
    });
    expect(updateSourceFor("linux", "rbutera/rennet")).toEqual({
      type: 0,
      repo: "rbutera/rennet",
    });
  });
});

describe("staged-at-interval polling (the badge is a disk fact)", () => {
  it("seeds when a staged version appears AFTER boot — the live event is not required", () => {
    vi.useFakeTimers();
    try {
      let staged: string | null = null;
      startAutoUpdate(isTrusted, quietLogger, () => staged);
      const replay = ipcHandlers.get(UPDATE_READY_CHANNEL);
      if (!replay) throw new Error("replay handler not registered");
      expect(replay(trusted)).toBeNull();
      staged = "0.3.1";
      vi.advanceTimersByTime(5 * 60_000 + 10);
      expect(replay(trusted)).toEqual({ version: "0.3.1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-seeds only on a version change — a standing badge never re-broadcasts", () => {
    vi.useFakeTimers();
    try {
      const window = liveWindow();
      harness.windows.push(window);
      let staged: string | null = "0.3.1";
      startAutoUpdate(isTrusted, quietLogger, () => staged);
      expect(window.webContents.send).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(3 * (5 * 60_000 + 10));
      expect(window.webContents.send).toHaveBeenCalledTimes(1);
      staged = "0.3.2";
      vi.advanceTimersByTime(5 * 60_000 + 10);
      expect(window.webContents.send).toHaveBeenCalledTimes(2);
      expect(window.webContents.send).toHaveBeenLastCalledWith(UPDATE_READY_CHANNEL, {
        version: "0.3.2",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
