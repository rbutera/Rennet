import { describe, expect, it, vi } from "vitest";

// The tray module imports Tray/Menu/nativeImage at load for the wiring; stub them so the
// PURE derivation and the controller can be exercised without a real Electron. Each Tray
// instance records the images and menu templates it is handed.
const trayInstances: Array<{
  images: unknown[];
  menus: unknown[];
  tooltip?: string;
  destroyed: boolean;
}> = [];

vi.mock("electron", () => ({
  Tray: class {
    rec = {
      images: [] as unknown[],
      menus: [] as unknown[],
      tooltip: undefined as string | undefined,
      destroyed: false,
    };
    constructor(image: unknown) {
      this.rec.images.push(image);
      trayInstances.push(this.rec);
    }
    setImage(image: unknown) {
      this.rec.images.push(image);
    }
    setToolTip(t: string) {
      this.rec.tooltip = t;
    }
    setContextMenu(menu: unknown) {
      this.rec.menus.push(menu);
    }
    destroy() {
      this.rec.destroyed = true;
    }
  },
  // buildFromTemplate passes the template straight through so the test can read labels.
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeImage: {
    createFromPath: (path: string) => ({
      path,
      template: false,
      setTemplateImage(v: boolean) {
        this.template = v;
      },
    }),
  },
}));

import {
  acquireSingleInstance,
  buildTrayMenuTemplate,
  createDockCoordinator,
  createTray,
  ensureWindow,
  residencyOnAllWindowsClosed,
  trayAssetDir,
  trayIconFile,
} from "./tray";

/** An injected scheduler that never actually fires — keeps the interval out of the test loop. */
const noSchedule = {
  setInterval: (() => 0) as unknown as (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>,
  clearInterval: () => undefined,
};

const actions = { openWindow: vi.fn(), applyUpdate: vi.fn(), quitCompletely: vi.fn() };

function labels(template: Array<{ label?: string; type?: string }>) {
  return template.filter((i) => i.type !== "separator").map((i) => i.label);
}

describe("buildTrayMenuTemplate (minimal, truthful menu)", () => {
  it("no daemon, no update: Open, version, plain Quit — no update line", () => {
    const t = buildTrayMenuTemplate(
      { ownedDaemonRunning: false, updateReady: false, version: "0.2.0" },
      actions,
    );
    expect(labels(t)).toEqual(["Open Rennet", "Rennet 0.2.0", "Quit Rennet"]);
  });

  it("owned daemon running: the Quit label says it stops the daemon", () => {
    const t = buildTrayMenuTemplate(
      { ownedDaemonRunning: true, updateReady: false, version: "0.2.0" },
      actions,
    );
    expect(labels(t)).toEqual(["Open Rennet", "Rennet 0.2.0", "Quit Rennet and stop daemon"]);
  });

  it("update staged: the restart line appears between Open and the version", () => {
    const t = buildTrayMenuTemplate(
      { ownedDaemonRunning: false, updateReady: true, version: "0.2.0" },
      actions,
    );
    expect(labels(t)).toEqual([
      "Open Rennet",
      "Restart Rennet to update",
      "Rennet 0.2.0",
      "Quit Rennet",
    ]);
  });

  it("owned daemon AND update staged: both signals show together", () => {
    const t = buildTrayMenuTemplate(
      { ownedDaemonRunning: true, updateReady: true, version: "1.0.0" },
      actions,
    );
    expect(labels(t)).toEqual([
      "Open Rennet",
      "Restart Rennet to update",
      "Rennet 1.0.0",
      "Quit Rennet and stop daemon",
    ]);
  });

  it("each item routes to its action", () => {
    const local = { openWindow: vi.fn(), applyUpdate: vi.fn(), quitCompletely: vi.fn() };
    const t = buildTrayMenuTemplate(
      { ownedDaemonRunning: true, updateReady: true, version: "0.2.0" },
      local,
    ) as Array<{ label?: string; click?: () => void }>;
    for (const item of t) item.click?.();
    expect(local.openWindow).toHaveBeenCalledOnce();
    expect(local.applyUpdate).toHaveBeenCalledOnce();
    expect(local.quitCompletely).toHaveBeenCalledOnce();
  });
});

describe("trayAssetDir", () => {
  it("resolves the packaged resources path when packaged", () => {
    expect(trayAssetDir("/app/dist/main", "/app/res", true)).toBe("/app/res/tray");
  });

  it("resolves the repo-root brand dir in dev/source", () => {
    expect(trayAssetDir("/repo/apps/desktop/dist/main", "/x", false)).toBe(
      "/repo/brand/exports/tray",
    );
  });
});

describe("ensureWindow (focus-or-recreate; close then reopen)", () => {
  it("focuses the existing window and neither recreates nor touches the Dock", async () => {
    const deps = {
      hasWindow: () => true,
      focusExisting: vi.fn(),
      showDock: vi.fn(),
      recreate: vi.fn(),
    };
    await ensureWindow(deps);
    expect(deps.focusExisting).toHaveBeenCalledOnce();
    expect(deps.recreate).not.toHaveBeenCalled();
    expect(deps.showDock).not.toHaveBeenCalled();
  });

  it("recreates a window (showing the Dock first) when none is live", async () => {
    const order: string[] = [];
    const deps = {
      hasWindow: () => false,
      focusExisting: vi.fn(),
      showDock: vi.fn(() => {
        order.push("dock");
      }),
      recreate: vi.fn(() => {
        order.push("recreate");
      }),
    };
    await ensureWindow(deps);
    expect(deps.focusExisting).not.toHaveBeenCalled();
    expect(order).toEqual(["dock", "recreate"]);
  });
});

describe("residencyOnAllWindowsClosed (close does not quit)", () => {
  it("hides the Dock and returns without any quit — nothing to signal here", () => {
    const hideDock = vi.fn();
    // The absence of a quit dependency is the point: this handler cannot quit the app.
    expect(() => residencyOnAllWindowsClosed({ hideDock })).not.toThrow();
    expect(hideDock).toHaveBeenCalledOnce();
  });
});

describe("createTray update surface (one readiness, tray reflects it)", () => {
  function make(overrides: Partial<Parameters<typeof createTray>[0]> = {}) {
    trayInstances.length = 0;
    const controller = createTray({
      baseDir: "/repo/apps/desktop/dist/main",
      resourcesPath: "/x",
      isPackaged: false,
      platform: "darwin",
      version: "0.2.0",
      // Default: no owned daemon, so the seed probe never changes state (no extra rebuild).
      probeOwnedDaemon: () => Promise.resolve(false),
      openWindow: vi.fn(),
      applyUpdate: vi.fn(),
      quitCompletely: vi.fn(),
      ...noSchedule,
      ...overrides,
    });
    const rec = trayInstances[0];
    if (!rec) throw new Error("tray was not constructed");
    return { controller, rec };
  }

  it("starts with the plain icon and no update line", () => {
    const { rec } = make();
    const firstMenu = rec.menus.at(-1) as Array<{ label?: string }>;
    expect(labels(firstMenu)).not.toContain("Restart Rennet to update");
    // Latest image is the plain darwin template mark.
    expect((rec.images.at(-1) as { path: string }).path).toContain("rennetTemplate.png");
  });

  it("flipping update-ready swaps to the dot icon and adds the restart line", () => {
    const { controller, rec } = make();
    controller.setUpdateReady(true);
    const menu = rec.menus.at(-1) as Array<{ label?: string }>;
    expect(labels(menu)).toContain("Restart Rennet to update");
    expect((rec.images.at(-1) as { path: string }).path).toContain("rennetUpdateTemplate.png");
  });

  it("flipping back to not-ready removes the line and restores the plain icon", () => {
    const { controller, rec } = make();
    controller.setUpdateReady(true);
    controller.setUpdateReady(false);
    const menu = rec.menus.at(-1) as Array<{ label?: string }>;
    expect(labels(menu)).not.toContain("Restart Rennet to update");
    expect((rec.images.at(-1) as { path: string }).path).toContain("rennetTemplate.png");
  });

  it("a redundant setUpdateReady(true) does not rebuild", () => {
    const { controller, rec } = make();
    const menusAfterInit = rec.menus.length;
    controller.setUpdateReady(true);
    controller.setUpdateReady(true);
    expect(rec.menus.length).toBe(menusAfterInit + 1);
  });
});

describe("trayIconFile (platform + update-state icon selection)", () => {
  it("macOS uses the alpha template PNGs (recoloured to the menu-bar theme)", () => {
    expect(trayIconFile("darwin", false)).toBe("rennetTemplate.png");
    expect(trayIconFile("darwin", true)).toBe("rennetUpdateTemplate.png");
  });

  it("Windows uses the multi-resolution .ico (the native tray format)", () => {
    expect(trayIconFile("win32", false)).toBe("rennet.ico");
    expect(trayIconFile("win32", true)).toBe("rennetUpdate.ico");
  });

  it("Linux uses the square PNG badge", () => {
    expect(trayIconFile("linux", false)).toBe("rennet.png");
    expect(trayIconFile("linux", true)).toBe("rennetUpdate.png");
  });
});

describe("createTray owned-daemon label (driven by the real health probe, not a boolean)", () => {
  it("shows the plain Quit label until the probe verifies an owned daemon, then rebuilds", async () => {
    trayInstances.length = 0;
    let owned = false;
    const controller = createTray({
      baseDir: "/repo/apps/desktop/dist/main",
      resourcesPath: "/x",
      isPackaged: false,
      platform: "darwin",
      version: "0.2.0",
      // The label derives from THIS probe (as isOwnedDaemonRunning does in prod), never a
      // supplied boolean — a stale/absent probe reads as not-owned (review finding 5).
      probeOwnedDaemon: () => Promise.resolve(owned),
      openWindow: vi.fn(),
      applyUpdate: vi.fn(),
      quitCompletely: vi.fn(),
      ...noSchedule,
    });
    const rec = trayInstances[0];
    if (!rec) throw new Error("tray was not constructed");

    // Seed probe resolves false: quit label is the plain one.
    await controller.refreshOwnership();
    expect(labels(rec.menus.at(-1) as Array<{ label?: string }>)).toContain("Quit Rennet");

    // The owned daemon comes up; the next refresh flips the label truthfully.
    owned = true;
    await controller.refreshOwnership();
    expect(labels(rec.menus.at(-1) as Array<{ label?: string }>)).toContain(
      "Quit Rennet and stop daemon",
    );
  });

  it("refreshOwnership does not rebuild when the probed value is unchanged", async () => {
    trayInstances.length = 0;
    const controller = createTray({
      baseDir: "/repo/apps/desktop/dist/main",
      resourcesPath: "/x",
      isPackaged: false,
      platform: "darwin",
      version: "0.2.0",
      probeOwnedDaemon: () => Promise.resolve(false),
      openWindow: vi.fn(),
      applyUpdate: vi.fn(),
      quitCompletely: vi.fn(),
      ...noSchedule,
    });
    const rec = trayInstances[0];
    if (!rec) throw new Error("tray was not constructed");
    await controller.refreshOwnership();
    const menus = rec.menus.length;
    await controller.refreshOwnership();
    expect(rec.menus.length).toBe(menus);
  });

  it("destroy() clears the refresh interval and destroys the tray", () => {
    trayInstances.length = 0;
    const cleared: number[] = [];
    const controller = createTray({
      baseDir: "/repo/apps/desktop/dist/main",
      resourcesPath: "/x",
      isPackaged: false,
      platform: "darwin",
      version: "0.2.0",
      probeOwnedDaemon: () => Promise.resolve(false),
      openWindow: vi.fn(),
      applyUpdate: vi.fn(),
      quitCompletely: vi.fn(),
      setInterval: (() => 7) as unknown as (
        fn: () => void,
        ms: number,
      ) => ReturnType<typeof setInterval>,
      clearInterval: ((h: number) => cleared.push(h)) as unknown as (
        h: ReturnType<typeof setInterval>,
      ) => void,
    });
    controller.destroy();
    expect(cleared).toEqual([7]);
    expect(trayInstances[0]?.destroyed).toBe(true);
  });
});

describe("createDockCoordinator (macOS dock hide/show timing, review finding 4)", () => {
  function harness(minVisibleMs = 1100) {
    let clock = 0;
    const events: string[] = [];
    const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
    let nextId = 1;
    const coord = createDockCoordinator({
      show: () => {
        events.push("show");
      },
      hide: () => {
        events.push("hide");
      },
      now: () => clock,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.push({ id, fn, ms });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (h) => {
        const i = timers.findIndex((t) => t.id === (h as unknown as number));
        if (i >= 0) timers.splice(i, 1);
      },
      minVisibleMs,
    });
    return {
      coord,
      events,
      timers,
      advance: (ms: number) => {
        clock += ms;
      },
      fireTimers: () => {
        for (const t of timers.splice(0)) t.fn();
      },
    };
  }

  it("hides immediately when the window has been up longer than the min-visible window", async () => {
    const h = harness();
    await h.coord.show();
    h.advance(2000); // well past 1100ms
    h.coord.requestHide();
    expect(h.events).toEqual(["show", "hide"]);
    expect(h.timers).toHaveLength(0);
  });

  it("defers a hide that lands within ~1s of a show (macOS ignores it otherwise)", async () => {
    const h = harness();
    await h.coord.show();
    h.advance(200); // too soon
    h.coord.requestHide();
    expect(h.events).toEqual(["show"]); // hide deferred, not dropped
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(900); // 1100 - 200
    h.fireTimers();
    expect(h.events).toEqual(["show", "hide"]);
  });

  it("a reopen cancels a pending hide, so a rapid close→reopen leaves the icon up", async () => {
    const h = harness();
    await h.coord.show();
    h.advance(200);
    h.coord.requestHide(); // schedules a deferred hide
    expect(h.timers).toHaveLength(1);
    await h.coord.show(); // reopen cancels it
    expect(h.timers).toHaveLength(0);
    h.fireTimers(); // nothing pending
    expect(h.events).toEqual(["show", "show"]); // never hid
  });
});

describe("acquireSingleInstance (relaunch routing, review finding 3)", () => {
  it("primary: keeps the lock, wires the second-instance handler, returns true", () => {
    const quit = vi.fn();
    const onPrimary = vi.fn();
    const primary = acquireSingleInstance({ requestLock: () => true, quit, onPrimary });
    expect(primary).toBe(true);
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("loser: fails the lock, quits, wires nothing, returns false", () => {
    const quit = vi.fn();
    const onPrimary = vi.fn();
    const primary = acquireSingleInstance({ requestLock: () => false, quit, onPrimary });
    expect(primary).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it("routes a relaunch to the existing window via the onPrimary handler", () => {
    const ensureWindowShared = vi.fn();
    // onPrimary is where prod registers `second-instance` → ensureWindowShared; prove the wire.
    acquireSingleInstance({
      requestLock: () => true,
      quit: vi.fn(),
      onPrimary: () => ensureWindowShared(),
    });
    expect(ensureWindowShared).toHaveBeenCalledOnce();
  });
});
