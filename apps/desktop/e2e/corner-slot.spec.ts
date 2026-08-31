import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

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
// case, and inventing one is not worth the hours. So this spec covers what Playwright
// could genuinely prove — bounding boxes, mount counts, the drag class, and the toggle
// round-trip — and deliberately does NOT attempt a synthetic drag, which would prove
// nothing about the real window. The real drag has NOT been verified by anyone yet;
// its proof path is Rai's manual check on a shipped build.
//
// The geometry below is UNCHANGED by #574 and was never the fault: this spec read `[]` owners
// because C21's first-run welcome unmounts the shell entirely, so there was no sidebar to own
// the corner. Settling the welcome (below) is the whole repair — the slot logic was fine.
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
    // The shell — and therefore the corner slot — only exists on the far side of the
    // first-run welcome, which deliberately unmounts it (C21). The wizard is
    // `first-run-welcome.spec.ts`'s subject; the chrome under it is this spec's.
    await completeWelcome(page);
    await page.waitForSelector('[data-slot="corner-slot"]', { timeout: 60_000 });

    // ── State 1: sidebar expanded. The sidebar header IS the corner slot. ──
    expect(await slotOwners(page)).toEqual(["sidebar"]);
    const sidebarSlot = '[data-slot="corner-slot"][data-owner="sidebar"]';
    // The strip is the drag region: the slot carries `app-region-drag`
    // (`-webkit-app-region: drag`) and every interactive thing inside it carries
    // `app-region-no-drag` by name — an opt-out stated per element, not inferred from
    // a tag list. That pair IS what makes the corner draggable while the toggle stays
    // clickable, and the computed-style reads below are what prove it took effect.
    await expect(page.locator(sidebarSlot)).toHaveClass(/app-region-drag/);
    // `-webkit-app-region` is not in lib.dom's CSSStyleDeclaration, so read it by name.
    const appRegion = (selector: string) =>
      page.$eval(selector, (n) =>
        getComputedStyle(n).getPropertyValue("-webkit-app-region").trim(),
      );
    expect(await appRegion(sidebarSlot)).toBe("drag");
    expect(await appRegion(`${sidebarSlot} button`)).toBe("no-drag");
    await expectClearsLights(page, sidebarSlot);
    await page.screenshot({ path: "test-results/c20-state-1-sidebar.png" });

    // ── State 2: collapsed + chat open — the slot moves into the chat header. ──
    // Reached from state 1 so the walk is continuous: open the chat, then collapse.
    // (The dock, and therefore this state, exists only on a session route.)
    const chatToggle = page.getByRole("button", { name: "Open chat" });
    if (await chatToggle.count()) {
      await chatToggle.click();
      await expect(page.getByTestId("chat-dock-slot")).toHaveAttribute("data-open", "true");
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      const chatSlot = '[data-slot="corner-slot"][data-owner="chat"]';
      await expect(page.locator(chatSlot)).toBeVisible();
      expect(await slotOwners(page)).toEqual(["chat"]);
      await expect(page.locator(chatSlot)).toHaveClass(/app-region-drag/);
      await expectClearsLights(page, chatSlot);
      await page.screenshot({ path: "test-results/c20-state-2-chat.png" });
      // Back to state 1 so the state-3 walk below starts from a known place.
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.getByRole("button", { name: "Close chat" }).click();
    }

    // ── State 3: collapse the sidebar with the chat closed — the floating pill. ──
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.locator('[data-slot="corner-slot"][data-owner="floating"]')).toBeVisible();
    expect(await slotOwners(page)).toEqual(["floating"]);
    const floatingSlot = '[data-slot="corner-slot"][data-owner="floating"]';
    await expect(page.locator(floatingSlot)).toHaveClass(/app-region-drag/);
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
