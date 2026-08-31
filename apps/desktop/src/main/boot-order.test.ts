import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The boot path's ORDER (perf audit §2 H1 / §6 H1). `whenReady` used to `await
// ensureDaemon(dataDir)` before `new BrowserWindow`, so a cold start showed nothing until a
// 500ms probe, a spawn and a 10s health poll had finished — and a version-skew SIGTERM plus its
// 5s claim-wait pushed the worst case past 15s of black screen. This suite pins the fix as a
// SEQUENCE (window created while the ensure is still pending), not as a set of calls made.
//
// Everything Electron and every module with real side effects is mocked: the subject here is
// `main/index.ts`'s own ordering, nothing else. The fake window models CREATION and LOAD only —
// there is no `show`, no paint, no visibility — so nothing in this file may claim the user saw
// anything. What it can pin is that the ws-port handler is registered, and the window created
// and loaded, before the daemon ensure resolves.

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
  /** dataDir → in-flight ensure, so the fake folds concurrent asks like the real supervisor. */
  ensureInFlight: new Map<string, Promise<number>>(),
  autoUpdateEligible: false,
  autoUpdateOptions: null as {
    prepareToApply: () => Promise<void>;
    recoverAfterApplyFailure: () => Promise<void>;
  } | null,
  trayOptions: null as { quitCompletely: () => void } | null,
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
        // Registration is part of the sequence: a renderer that loads before the handler exists
        // gets "no handler registered for rennet:ws-port", not a wait. Today only the order of
        // two synchronous statements guarantees it — so the order array pins it.
        if (channel === "rennet:ws-port") harness.order.push("ws-port-handler");
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
  // Single-flighted per dataDir, exactly like the real one: concurrent callers (boot and an
  // early `rennet:ws-port` ask) fold onto ONE pending ensure, and the entry clears once it
  // settles so the next ask starts a fresh one. Modelling the fold is load-bearing now that the
  // IPC handler ensures per invoke instead of replaying a stored promise.
  ensureDaemon: (dataDir: string) => {
    harness.ensureCalls.push(dataDir);
    const pending = harness.ensureInFlight.get(dataDir);
    if (pending) return pending;
    harness.order.push("ensure-started");
    const started = new Promise<number>((resolve, reject) => {
      harness.ensure.resolve = (port) => {
        harness.order.push("ensure-resolved");
        resolve(port);
      };
      harness.ensure.reject = (error) => {
        harness.order.push("ensure-rejected");
        reject(error);
      };
    });
    harness.ensureInFlight.set(dataDir, started);
    const clear = (): void => {
      harness.ensureInFlight.delete(dataDir);
    };
    started.then(clear, clear);
    return started;
  },
  ensureDaemonForProject: async () => 1,
  isOwnedDaemonRunning: async () => false,
  prepareOwnedDaemonForUpdate: async () => undefined,
  stopOwnedDaemon: async () => ({ kind: "stopped" }),
}));

vi.mock("./auto-update", () => ({
  isAutoUpdateEligible: async () => harness.autoUpdateEligible,
  startAutoUpdateOnce: (_trust: unknown, _log: unknown, options: unknown) => {
    // Captured so a test can drive the update apply and its failure recovery, both of which
    // move `daemonDataDir` under the ws-port handler.
    harness.autoUpdateOptions = options as NonNullable<typeof harness.autoUpdateOptions>;
    return { readiness: { ready: false, subscribe: () => undefined } };
  },
  armMacUpdateRelaunch: () => undefined,
}));

vi.mock("./tray", () => ({
  acquireSingleInstance: () => true,
  createDockCoordinator: () => ({ show: () => undefined, requestHide: () => undefined }),
  createTray: (options: unknown) => {
    // Captured so a test can drive tray "Quit completely", which stops the owned daemon.
    harness.trayOptions = options as NonNullable<typeof harness.trayOptions>;
    return {
      setUpdateReady: () => undefined,
      refreshOwnership: () => undefined,
      destroy: () => undefined,
    };
  },
  ensureWindow: async () => undefined,
  residencyOnAllWindowsClosed: () => undefined,
}));

const WS_PORT_CHANNEL = "rennet:ws-port";
const DATA_DIR = "/tmp/rennet-boot-order";

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
  harness.ensureInFlight.clear();
  harness.autoUpdateEligible = false;
  harness.autoUpdateOptions = null;
  harness.trayOptions = null;
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
    expect(harness.order).toEqual([
      "ensure-started",
      "ws-port-handler",
      "window-created",
      "window-loaded",
    ]);

    harness.ensure.resolve(51_000);
    await settle();
    expect(harness.order).toEqual([
      "ensure-started",
      "ws-port-handler",
      "window-created",
      "window-loaded",
      "ensure-resolved",
    ]);
    expect(harness.ensureCalls).toEqual([DATA_DIR]);
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

  it("surfaces a failed ensure after the window is created and loaded, then quits", async () => {
    await boot();
    const handler = harness.ipcHandlers.get(WS_PORT_CHANNEL);
    const asked = handler?.();

    harness.ensure.reject(new Error("spawn ENOENT\n  at boot"));
    await settle();

    // The window was created and loaded before the failure, with the dialog's content unchanged.
    // (Whether it had PAINTED by then is not something this fake can say — see the file header.)
    expect(harness.order).toEqual([
      "ensure-started",
      "ws-port-handler",
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

  it("re-ensures on a later port ask after an update-recovery ensure rejected", async () => {
    // MAIN used to publish the ensure PROMISE on `rennet:ws-port`. An update-apply recovery whose
    // ensure rejected replaced it with a REJECTED promise, and every later ask inherited that
    // rejection for the life of the process — the renderer could never redial. The handler calls
    // `ensureDaemon` per invoke now, so the ask after a failure re-probes.
    harness.autoUpdateEligible = true;
    await boot();
    harness.ensure.resolve(51_000); // boot's daemon came up; that ensure has settled.
    await settle();

    // The recovery's own re-ensure fails (the daemon the installer left behind will not start).
    const recovery = harness.autoUpdateOptions?.recoverAfterApplyFailure();
    await settle();
    harness.ensure.reject(new Error("recovery spawn ENOENT"));
    await expect(recovery).rejects.toThrow("recovery spawn ENOENT");
    await settle();

    const handler = harness.ipcHandlers.get(WS_PORT_CHANNEL);
    const asked = Promise.resolve(handler?.());
    await settle();
    harness.ensure.resolve(51_002);
    // A FRESH port from a FRESH ensure — not the recovery's rejection replayed.
    expect(await asked).toBe(51_002);
    // Boot, the recovery, and the ask: three ensures, and the ask started the third.
    expect(harness.ensureCalls).toEqual([DATA_DIR, DATA_DIR, DATA_DIR]);

    // Per INVOKE, not memoised on the first SUCCESS either. A handler that cached 51_002 would
    // pass everything above; it would still hand the renderer a dead port after a skew restart
    // respawned the daemon on a new one. So the fake answers differently now, and the next ask
    // must reflect that — a fourth ensure, not a fourth replay of the third's port.
    const later = Promise.resolve(handler?.());
    await settle();
    harness.ensure.resolve(51_003);
    expect(await later).toBe(51_003);
    expect(harness.ensureCalls).toEqual([DATA_DIR, DATA_DIR, DATA_DIR, DATA_DIR]);
  });

  it("does not respawn the daemon when a reconnecting renderer asks mid-update-apply", async () => {
    // The renderer's bridge reconnects every ~500ms and asks `rennet:ws-port` per attempt. The
    // update apply SIGTERMs the owned daemon precisely so the installer can replace the bundle
    // it runs from (auto-update.ts states the requirement) — and the ask arriving out of that
    // very disconnect used to ensure again, spawning a fresh DETACHED daemon back onto the
    // bundle. The ask must be refused for as long as the teardown is in flight.
    harness.autoUpdateEligible = true;
    await boot();
    harness.ensure.resolve(51_000);
    await settle();
    expect(harness.ensureCalls).toEqual([DATA_DIR]);

    await harness.autoUpdateOptions?.prepareToApply();
    const handler = harness.ipcHandlers.get(WS_PORT_CHANNEL);
    // Asserted BEFORE the ask is awaited, and it is the load-bearing one: a handler that
    // ensured here would leave the ask PENDING (the fake resolves nothing), so awaiting first
    // would fail this test on a timeout instead of on the spawn that is the actual defect.
    const refused = Promise.resolve(handler?.()).catch((error: Error) => error.message);
    await settle();
    expect(harness.ensureCalls).toEqual([DATA_DIR]);
    expect(await refused).toContain("the daemon has not been started");

    // …and the refusal lasts only as long as the teardown. The apply failed, so the app stays:
    // recovery puts the data dir back and the renderer's next ask ensures again.
    const recovery = harness.autoUpdateOptions?.recoverAfterApplyFailure();
    await settle();
    harness.ensure.resolve(51_004);
    await recovery;
    expect(harness.ensureCalls).toEqual([DATA_DIR, DATA_DIR]);

    const asked = Promise.resolve(handler?.());
    await settle();
    harness.ensure.resolve(51_005);
    expect(await asked).toBe(51_005);
    expect(harness.ensureCalls).toEqual([DATA_DIR, DATA_DIR, DATA_DIR]);
  });

  it("does not respawn the daemon when a reconnecting renderer asks mid-quit", async () => {
    // Same shape as the update apply, different exit: tray "Quit completely" stops the owned
    // daemon and then exits, and the renderer reconnects across that stop.
    await boot();
    harness.ensure.resolve(51_000);
    await settle();

    harness.trayOptions?.quitCompletely();
    await settle();

    const handler = harness.ipcHandlers.get(WS_PORT_CHANNEL);
    const refused = Promise.resolve(handler?.()).catch((error: Error) => error.message);
    await settle();
    expect(harness.ensureCalls).toEqual([DATA_DIR]);
    expect(await refused).toContain("the daemon has not been started");
    expect(harness.quits).toBe(1);
  });
});
