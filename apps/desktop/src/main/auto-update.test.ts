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
  APPLY_HANDOFF_TIMEOUT_MS,
  armMacUpdateRelaunch,
  createAutoUpdateStarter,
  createUpdateReadiness,
  isAutoUpdateEligible,
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
  it("initializes the update client exactly once", () => {
    const start = vi.fn(() => ({
      readiness: createUpdateReadiness(() => undefined),
      applyUpdate: async () => undefined,
    }));
    const startOnce = createAutoUpdateStarter(start);
    const first = startOnce(isTrusted, quietLogger);
    const second = startOnce(isTrusted, quietLogger);
    expect(second).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);
  });

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

  it("applies only from a trusted frame and prepares the bundle before quitAndInstall", async () => {
    const prepareToApply = vi.fn(async () => undefined);
    const handle = startAutoUpdate(isTrusted, quietLogger, { prepareToApply });
    const apply = ipcListeners.get(UPDATE_APPLY_CHANNEL);
    if (!apply) throw new Error("apply listener not registered");
    apply(untrusted);
    await Promise.resolve();
    expect(prepareToApply).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    apply(trusted);
    await handle.applyUpdate();
    expect(prepareToApply).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(prepareToApply.mock.invocationCallOrder[0]).toBeLessThan(
      autoUpdaterMock.quitAndInstall.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not invoke ShipIt until asynchronous bundle preparation completes", async () => {
    let releasePreparation: (() => void) | undefined;
    const prepareToApply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePreparation = resolve;
        }),
    );
    const handle = startAutoUpdate(isTrusted, quietLogger, { prepareToApply });
    const applying = handle.applyUpdate();
    await Promise.resolve();
    expect(prepareToApply).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    releasePreparation?.();
    await applying;
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("keeps Rennet open and reports a preparation failure instead of invoking ShipIt", async () => {
    const reportApplyFailure = vi.fn();
    const handle = startAutoUpdate(isTrusted, quietLogger, {
      prepareToApply: async () => {
        throw new Error("daemon still owns the app bundle");
      },
      reportApplyFailure,
    });
    await handle.applyUpdate();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(reportApplyFailure).toHaveBeenCalledWith("daemon still owns the app bundle");
  });

  it("deduplicates simultaneous apply choices from the tray and renderer", async () => {
    let releasePreparation: (() => void) | undefined;
    const prepareToApply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePreparation = resolve;
        }),
    );
    const handle = startAutoUpdate(isTrusted, quietLogger, { prepareToApply });
    const first = handle.applyUpdate();
    const second = handle.applyUpdate();
    expect(second).toBe(first);
    expect(prepareToApply).toHaveBeenCalledTimes(1);
    releasePreparation?.();
    await first;
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("restores a usable app and reports a native install handoff failure", async () => {
    const cancelRelaunchAfterApply = vi.fn();
    const armRelaunchAfterApply = vi.fn(() => cancelRelaunchAfterApply);
    const recoverAfterApplyFailure = vi.fn(async () => undefined);
    const reportApplyFailure = vi.fn();
    const handle = startAutoUpdate(isTrusted, quietLogger, {
      prepareToApply: async () => undefined,
      armRelaunchAfterApply,
      recoverAfterApplyFailure,
      reportApplyFailure,
    });

    await handle.applyUpdate();
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(armRelaunchAfterApply.mock.invocationCallOrder[0]).toBeLessThan(
      autoUpdaterMock.quitAndInstall.mock.invocationCallOrder[0] ?? 0,
    );
    autoUpdaterMock.emit("error", new Error("ShipIt could not stage the relaunch"));

    await vi.waitFor(() => expect(recoverAfterApplyFailure).toHaveBeenCalledTimes(1));
    expect(cancelRelaunchAfterApply).toHaveBeenCalledTimes(1);
    expect(cancelRelaunchAfterApply.mock.invocationCallOrder[0]).toBeLessThan(
      recoverAfterApplyFailure.mock.invocationCallOrder[0] ?? 0,
    );
    expect(reportApplyFailure).toHaveBeenCalledWith("ShipIt could not stage the relaunch");
    expect(recoverAfterApplyFailure.mock.invocationCallOrder[0]).toBeLessThan(
      reportApplyFailure.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("recovers when the native handoff silently closes the window without quitting", async () => {
    vi.useFakeTimers();
    try {
      const recoverAfterApplyFailure = vi.fn(async () => undefined);
      const reportApplyFailure = vi.fn();
      const handle = startAutoUpdate(isTrusted, quietLogger, {
        prepareToApply: async () => undefined,
        recoverAfterApplyFailure,
        reportApplyFailure,
      });

      await handle.applyUpdate();
      await vi.advanceTimersByTimeAsync(APPLY_HANDOFF_TIMEOUT_MS);

      expect(recoverAfterApplyFailure).toHaveBeenCalledTimes(1);
      expect(reportApplyFailure).toHaveBeenCalledWith(
        "The native updater closed Rennet without starting the install.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a download failure without running install recovery", async () => {
    const recoverAfterApplyFailure = vi.fn(async () => undefined);
    const reportApplyFailure = vi.fn();
    startAutoUpdate(isTrusted, quietLogger, {
      recoverAfterApplyFailure,
      reportApplyFailure,
    });

    autoUpdaterMock.emit("update-available");
    autoUpdaterMock.emit("error", new Error("download checksum mismatch"));

    await vi.waitFor(() =>
      expect(reportApplyFailure).toHaveBeenCalledWith("download checksum mismatch"),
    );
    expect(recoverAfterApplyFailure).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
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

describe("armMacUpdateRelaunch", () => {
  it("spawns an out-of-bundle helper with positional app data and supports cancellation", () => {
    const child = { unref: vi.fn(), kill: vi.fn() };
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const cancel = armMacUpdateRelaunch("/Applications/Rennet Test.app", "0.4.2", {
      parentPid: 417,
      openerPath: "/test/open",
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining([
        "rennet-update-relaunch",
        "417",
        "/Applications/Rennet Test.app",
        "0.4.2",
        "/test/open",
      ]),
      { detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
    cancel();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.runIf(process.platform === "darwin")(
    "opens the installed app after the parent is gone and the bundle version changes",
    async () => {
      const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
        require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { join } = require("node:path") as typeof import("node:path");
      const root = mkdtempSync(join(tmpdir(), "rennet-update-relaunch-"));
      const appPath = join(root, "Rennet Test.app");
      const markerPath = join(root, "opened.txt");
      const openerPath = join(root, "open-test-app");
      try {
        mkdirSync(join(appPath, "Contents"), { recursive: true });
        writeFileSync(
          join(appPath, "Contents", "Info.plist"),
          `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.4.3</string></dict></plist>`,
        );
        writeFileSync(openerPath, `#!/bin/sh\nprintf '%s' "$1" > "${markerPath}"\n`);
        chmodSync(openerPath, 0o755);

        const cancel = armMacUpdateRelaunch(appPath, "0.4.2", {
          parentPid: 2_147_483_647,
          openerPath,
        });
        try {
          await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), { timeout: 2_000 });
          expect(readFileSync(markerPath, "utf8")).toBe(appPath);
        } finally {
          cancel();
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});

describe("auto-update eligibility", () => {
  it("never starts in an unpackaged application", () => {
    expect(
      isAutoUpdateEligible(false, "darwin", "/Rennet.app/Contents/MacOS/Rennet", vi.fn()),
    ).toBe(false);
  });

  it("requires a Developer ID signature on macOS packages", () => {
    const verify = vi.fn(() => false);
    expect(isAutoUpdateEligible(true, "darwin", "/Rennet.app/Contents/MacOS/Rennet", verify)).toBe(
      false,
    );
    expect(verify).toHaveBeenCalledWith("/Rennet.app");
  });

  it("allows a verified Developer ID package and preserves the Windows updater", () => {
    expect(
      isAutoUpdateEligible(true, "darwin", "/Rennet.app/Contents/MacOS/Rennet", () => true),
    ).toBe(true);
    expect(isAutoUpdateEligible(true, "win32", "C:\\Rennet.exe", () => false)).toBe(true);
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
    startAutoUpdate(isTrusted, quietLogger, { detectStaged: () => "0.2.6" });
    const replay = ipcHandlers.get(UPDATE_READY_CHANNEL);
    if (!replay) throw new Error("replay handler not registered");
    expect(replay(trusted)).toEqual({ version: "0.2.6" });
  });

  it("stays unseeded when nothing is staged", () => {
    startAutoUpdate(isTrusted, quietLogger, { detectStaged: () => null });
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
      startAutoUpdate(isTrusted, quietLogger, { detectStaged: () => staged });
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
      startAutoUpdate(isTrusted, quietLogger, { detectStaged: () => staged });
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
