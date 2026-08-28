import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { launchRennet, makeTempDir, seedReviewRepo } from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// C20 (#558) corner-slot chrome, in the real packaged-shape app on macOS. The window
// is `titleBarStyle: "hiddenInset"` there, so the OS paints the close/minimise/zoom
// buttons OVER the renderer's top-left — the one thing a DOM test cannot see, because
// happy-dom has no window and no lights. What this spec pins is geometry: whichever
// pane owns the corner slot, its interactive controls clear the zone the lights
// occupy, and the slot is the drag region.
//
// SCOPE, stated rather than implied (packet risk 8.1): the repo's Playwright-on-
// Electron harness has no precedent for a window-drag or a traffic-light-geometry
// case, and inventing one is not worth the hours. So this spec proves what Playwright
// can genuinely prove — bounding boxes, mount counts, the drag class, and the toggle
// round-trip — and the window DRAG itself is verified by hand (recorded in the C20
// tasks record). A synthetic drag would prove nothing about the real window.
//
// KNOWN NOT-RUN (2026-08-28): this spec has never executed. Playwright's Electron
// driver cannot launch the app on this toolchain at all — `Electron: bad option:
// --remote-debugging-port=0` (Electron 43.2.0 vs @playwright/test 1.62.0), and an
// UNTOUCHED spec on main fails identically, so it is not this change's doing. Treat
// the assertions below as unverified until the harness launches again.
//
// The lights' zone with the default `hiddenInset` inset: three 12px buttons from
// x≈12 to x≈82, vertically centred around y≈20. A control clears them by starting
// after the reserve (x ≥ 76) or by sitting below the strip (y ≥ 40).
// ─────────────────────────────────────────────────────────────────────────────

const LIGHT_ZONE = { right: 76, bottom: 40 };
const darwin = process.platform === "darwin";

/** Every corner slot currently in the document, with its owner. */
async function slotOwners(page: Page): Promise<string[]> {
  return page.$$eval('[data-slot="corner-slot"]', (nodes) =>
    nodes.map((n) => n.getAttribute("data-owner") ?? ""),
  );
}

/** Assert every interactive control inside `root` clears the traffic-light zone. */
async function expectClearsLights(page: Page, selector: string): Promise<void> {
  const boxes = await page.$$eval(`${selector} button, ${selector} a`, (nodes) =>
    nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y })),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    // Evidence, not assertion: the failure message carries the offending coordinate.
    expect(
      box.x >= LIGHT_ZONE.right || box.y >= LIGHT_ZONE.bottom,
      `control at (${box.x}, ${box.y}) overlaps the traffic-light zone`,
    ).toBe(true);
  }
}

test("the corner slot owns the window's top-left in every state, clear of the lights", async () => {
  test.skip(!darwin, "hiddenInset traffic lights exist only on darwin");
  test.setTimeout(120_000);

  const repository = seedReviewRepo("rennet-e2e-corner-");
  const userData = makeTempDir("rennet-e2e-state-");
  const home = makeTempDir("rennet-e2e-home-");
  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();
    await page.waitForSelector('[data-slot="corner-slot"]', { timeout: 60_000 });

    // ── State 1: sidebar expanded. The sidebar header IS the corner slot. ──
    expect(await slotOwners(page)).toEqual(["sidebar"]);
    const sidebarSlot = '[data-slot="corner-slot"][data-owner="sidebar"]';
    // The strip is the drag region: `navigation-titlebar` sets -webkit-app-region:
    // drag on it, and its buttons opt back out. That pair IS what makes the corner
    // draggable while the toggle stays clickable.
    await expect(page.locator(sidebarSlot)).toHaveClass(/navigation-titlebar/);
    // `-webkit-app-region` is not in lib.dom's CSSStyleDeclaration, so read it by name.
    const appRegion = (selector: string) =>
      page.$eval(selector, (n) =>
        getComputedStyle(n).getPropertyValue("-webkit-app-region").trim(),
      );
    expect(await appRegion(sidebarSlot)).toBe("drag");
    expect(await appRegion(`${sidebarSlot} button`)).toBe("no-drag");
    await expectClearsLights(page, sidebarSlot);
    await page.screenshot({ path: "test-results/c20-state-1-sidebar.png" });

    // ── State 3: collapse the sidebar with the chat closed — the floating pill. ──
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.locator('[data-slot="corner-slot"][data-owner="floating"]')).toBeVisible();
    expect(await slotOwners(page)).toEqual(["floating"]);
    const floatingSlot = '[data-slot="corner-slot"][data-owner="floating"]';
    await expect(page.locator(floatingSlot)).toHaveClass(/navigation-titlebar/);
    await expectClearsLights(page, floatingSlot);
    // Whatever chips the state-3 layer renders beside the pill must clear the lights
    // too — the pill is not allowed to be the only thing that dodges them.
    const bar = page.locator('[data-slot="session-top-bar"][data-floating="true"]');
    if (await bar.count()) {
      await expectClearsLights(page, '[data-slot="session-top-bar"][data-floating="true"]');
    }
    await page.screenshot({ path: "test-results/c20-state-3-floating.png" });

    // ── Back to state 1: the slot returns to the sidebar, still exactly one. ──
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.locator(sidebarSlot)).toBeVisible();
    expect(await slotOwners(page)).toEqual(["sidebar"]);
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
