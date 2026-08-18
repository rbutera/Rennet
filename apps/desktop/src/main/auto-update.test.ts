import { beforeEach, describe, expect, it, vi } from "vitest";

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
      expect.objectContaining({ updateInterval: "5 minutes", notifyUser: false }),
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
