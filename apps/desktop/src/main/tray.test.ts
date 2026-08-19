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
  buildTrayMenuTemplate,
  createTray,
  ensureWindow,
  residencyOnAllWindowsClosed,
  trayAssetDir,
} from "./tray";

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
      showDock: vi.fn(() => order.push("dock")),
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
      ownedDaemonRunning: () => true,
      openWindow: vi.fn(),
      applyUpdate: vi.fn(),
      quitCompletely: vi.fn(),
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
