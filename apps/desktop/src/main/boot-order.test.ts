import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The boot path's ORDER (perf audit §2 H1 / §6 H1). `whenReady` used to `await
// ensureDaemon(dataDir)` before `new BrowserWindow`, so a cold start showed nothing until a
// 500ms probe, a spawn and a 10s health poll had finished — and a version-skew SIGTERM plus its
// 5s claim-wait pushed the worst case past 15s of black screen. This suite pins the fix as a
// SEQUENCE (window created while the ensure is still pending), not as a set of calls made.
//
// Everything Electron and every module with real side effects is mocked: the subject here is
// `main/index.ts`'s own ordering, nothing else.

const harness = vi.hoisted(() => ({
  /** Boot events in the order they happened — the whole point of this file. */
  order: [] as string[],
  ready: { resolve: (): void => undefined },
  readyPromise: null as Promise<void> | null,
  ensure: {
    resolve: (port: number): void => void port,
    reject: (error: Error): void => void error,
  },
  windowOptions: [] as Array<Record<string, unknown>>,
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  errorBoxes: [] as Array<{ title: string; content: string }>,
  quits: 0,
  ensureCalls: [] as string[],
}));

vi.mock("electron-squirrel-startup", () => ({ default: false }));

vi.mock("electron", () => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    static getAllWindows(): FakeBrowserWindow[] {
      return FakeBrowserWindow.instances;
    }
    readonly webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
    };
    constructor(options: Record<string, unknown>) {
      harness.windowOptions.push(options);
      harness.order.push("window-created");
      FakeBrowserWindow.instances.push(this);
    }
    readonly on = vi.fn();
    readonly destroy = vi.fn();
    isDestroyed(): boolean {
      return false;
    }
    loadURL(): Promise<void> {
      harness.order.push("window-loaded");
      return Promise.resolve();
    }
  }
  return {
    app: {
      whenReady: () => harness.readyPromise as Promise<void>,
      quit: () => {
        harness.quits += 1;
      },
      getVersion: () => "9.9.9",
      getAppPath: () => "/tmp/app.asar",
      isPackaged: false,
      setPath: () => undefined,
      setAppUserModelId: () => undefined,
      requestSingleInstanceLock: () => true,
      on: () => undefined,
      dock: { show: () => undefined, hide: () => undefined },
    },
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: () => undefined },
    dialog: {
      showErrorBox: (title: string, content: string) => {
        harness.order.push("error-box");
        harness.errorBoxes.push({ title, content });
      },
    },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        harness.ipcHandlers.set(channel, handler);
      },
      on: () => undefined,
    },
    Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    net: { fetch: () => Promise.resolve(new Response("")) },
    protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
    session: { defaultSession: { setPermissionRequestHandler: () => undefined } },
    shell: { openExternal: () => Promise.resolve() },
  };
});

vi.mock("@rennet/core", () => ({
  detectLocus: () => ({ kind: "host" }),
  listWslDistros: async () => [],
}));

vi.mock("@rennet/server", () => ({ defaultDataDir: () => "/tmp/rennet-boot-order" }));

vi.mock("./daemon-supervisor", () => ({
  ensureDaemon: (dataDir: string) => {
    harness.ensureCalls.push(dataDir);
    harness.order.push("ensure-started");
    return new Promise<number>((resolve, reject) => {
      harness.ensure.resolve = (port) => {
        harness.order.push("ensure-resolved");
        resolve(port);
      };
      harness.ensure.reject = (error) => {
        harness.order.push("ensure-rejected");
        reject(error);
      };
    });
  },
  ensureDaemonForProject: async () => 1,
  isOwnedDaemonRunning: async () => false,
  prepareOwnedDaemonForUpdate: async () => undefined,
  stopOwnedDaemon: async () => ({ kind: "stopped" }),
}));

vi.mock("./auto-update", () => ({
  isAutoUpdateEligible: async () => false,
  startAutoUpdateOnce: () => ({ readiness: { ready: false, subscribe: () => undefined } }),
  armMacUpdateRelaunch: () => undefined,
}));

vi.mock("./tray", () => ({
  acquireSingleInstance: () => true,
  createDockCoordinator: () => ({ show: () => undefined, requestHide: () => undefined }),
  createTray: () => ({
    setUpdateReady: () => undefined,
    refreshOwnership: () => undefined,
    destroy: () => undefined,
  }),
  ensureWindow: async () => undefined,
  residencyOnAllWindowsClosed: () => undefined,
}));

const WS_PORT_CHANNEL = "rennet:ws-port";

/** Let every already-queued microtask AND timer callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Import a fresh `main/index.ts` and drive it to `app.whenReady()`. */
async function boot(): Promise<void> {
  vi.resetModules();
  harness.readyPromise = new Promise<void>((resolve) => {
    harness.ready.resolve = resolve;
  });
  await import("./index");
  harness.ready.resolve();
  await settle();
}

let savedUserData: string | undefined;

beforeEach(() => {
  harness.order.length = 0;
  harness.windowOptions.length = 0;
  harness.ipcHandlers.clear();
  harness.errorBoxes.length = 0;
  harness.ensureCalls.length = 0;
  harness.quits = 0;
  savedUserData = process.env.RENNET_USER_DATA;
  delete process.env.RENNET_USER_DATA;
});

afterEach(() => {
  if (savedUserData === undefined) delete process.env.RENNET_USER_DATA;
  else process.env.RENNET_USER_DATA = savedUserData;
});

describe("desktop boot order (perf audit §2/§6 H1)", () => {
  it("creates and loads the window while the daemon ensure is still pending", async () => {
    await boot();

    // The assertion is the SEQUENCE. The ensure has not resolved at this point in the file —
    // nothing has resolved it — so a window in `order` here can only mean boot did not wait.
    expect(harness.order).toEqual(["ensure-started", "window-created", "window-loaded"]);

    harness.ensure.resolve(51_000);
    await settle();
    expect(harness.order).toEqual([
      "ensure-started",
      "window-created",
      "window-loaded",
      "ensure-resolved",
    ]);
    expect(harness.ensureCalls).toEqual(["/tmp/rennet-boot-order"]);
  });

  it("no longer injects the port into the renderer argv, and still injects the version", async () => {
    await boot();
    const args = harness.windowOptions[0]?.webPreferences as { additionalArguments: string[] };
    expect(args.additionalArguments).toEqual(["--rennet-version=9.9.9"]);
  });

  it("answers the port channel with the ensured port, after it resolves", async () => {
    await boot();
    const handler = harness.ipcHandlers.get(WS_PORT_CHANNEL);
    expect(handler).toBeTypeOf("function");

    let answered: number | undefined;
    const asked = Promise.resolve(handler?.()).then((port) => {
      answered = port as number;
    });
    // Asked BEFORE the daemon is healthy — the renderer's real cold-start case. It must wait,
    // not answer 0 or undefined.
    await settle();
    expect(answered).toBeUndefined();

    harness.ensure.resolve(51_001);
    await asked;
    expect(answered).toBe(51_001);
  });

  it("surfaces a failed ensure on the already-visible window, then quits", async () => {
    await boot();
    const handler = harness.ipcHandlers.get(WS_PORT_CHANNEL);
    const asked = handler?.();

    harness.ensure.reject(new Error("spawn ENOENT\n  at boot"));
    await settle();

    // The window came first, the failure lands on it — the old code's dialog-over-black-screen
    // is now dialog-over-app, with the same content.
    expect(harness.order).toEqual([
      "ensure-started",
      "window-created",
      "window-loaded",
      "ensure-rejected",
      "error-box",
    ]);
    expect(harness.errorBoxes[0]?.title).toBe("Rennet daemon failed to start");
    expect(harness.errorBoxes[0]?.content).toContain("spawn ENOENT at boot");
    expect(harness.errorBoxes[0]?.content).toContain("daemon.log");
    expect(harness.quits).toBe(1);
    // …and the renderer's pending ask rejects rather than hanging or resolving a bogus port.
    await expect(asked).rejects.toThrow("spawn ENOENT");
  });
});
