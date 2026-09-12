import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { SessionStore } from "@rennet/adapters";
import { WsRennetBridge } from "@rennet/client";
import { addProject, completeWelcome, launchRennet, makeTempDir } from "./harness";
import { seedMarketingBoard, seedMarketingRepo } from "./marketing-fixture";

/**
 * Capture the marketing site's product screenshots from the SHIPPED app (#470).
 *
 * Not a test and not in the e2e suite: `playwright.screenshots.config.ts` is the only config
 * that matches this file, and `pnpm nx run rennet-marketing:screenshots` is the only thing
 * that runs it. The app is launched exactly as the hermetic specs launch it, with the
 * model-free environment (`RENNET_DISABLE_HARNESS=1`, no `claude`, no `codex`, no network),
 * against the invented `atlas` repository and the board `marketing-fixture.ts` seeds through
 * the production writer. Raw 2x PNGs land in `apps/marketing/.screenshots-raw/`; the
 * marketing `optimize-screenshots.mjs` step quantises them into `public/product/`.
 */

const RAW_DIR = resolve("apps/marketing/.screenshots-raw");
/** The hero slot on the marketing page is 1536×1024 CSS pixels; capture at exactly that. */
const VIEWPORT = { width: 1536, height: 1024 };

async function openCapturedReview(page: Page, repository: string, userData: string) {
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  try {
    const { projects } = await bridge.invoke("projects.list", {});
    const project = projects.find((candidate) => candidate.openPath === repository);
    if (project === undefined) throw new Error("fixture project was not added");
    const { session } = await bridge.invoke("session.mint", {
      commandId: crypto.randomUUID(),
      projectId: project.id,
    });
    if (session === null) throw new Error("fixture session was not minted");
    // With no harness on the machine the drafting attempt fails honestly; the capture is
    // what matters here, and the board is seeded in its place.
    await expect
      .poll(
        async () => {
          const { sessions } = await bridge.invoke("session.list", {});
          const captured = sessions.find((candidate) => candidate.id === session.id);
          return captured?.reviewId !== undefined && captured.preparation?.status === "failed";
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    new SessionStore(join(userData, "sessions")).setPreparation(session.id, undefined);
    await page.evaluate((id) => {
      location.hash = `#/s/${encodeURIComponent(id)}`;
    }, session.id);
    await page.reload();
  } finally {
    bridge.close();
  }
}

async function openBoardSections(page: Page): Promise<void> {
  const toggles = page.locator(
    'article[data-lens] [data-kind="board-section"] button[aria-label^="Toggle "][aria-expanded="false"]',
  );
  // Opening one section drops it out of this locator, so always take the first that is left.
  for (let remaining = 0; remaining < 40; remaining += 1) {
    if ((await toggles.count()) === 0) return;
    await toggles.first().click();
  }
}

async function dismissTips(page: Page): Promise<void> {
  const skipTips = page.getByRole("button", { name: "Skip all tips", exact: true });
  if (await skipTips.isVisible()) await skipTips.click();
}

/**
 * The model-free environment has no `claude` on PATH, and the chat pane says so in a banner
 * once its provider probe answers. True, and not the product: a user with a harness never
 * sees it. It arrives asynchronously, so this runs right before every screenshot.
 */
async function dismissProviderBanners(page: Page): Promise<void> {
  const banners = page.getByRole("button", { name: /^Dismiss .+ provider (warning|error)$/ });
  for (let remaining = 0; remaining < 4; remaining += 1) {
    if ((await banners.count()) === 0) return;
    await banners.first().click();
  }
}

async function selectLens(page: Page, name: string): Promise<void> {
  const tab = page
    .getByRole("tablist", { name: "Lens" })
    .getByRole("tab", { name: new RegExp(`^${name}(?:,|$)`) });
  // Clicking the tab that is already selected pins its activity popover open instead.
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator("article[data-lens]")).toHaveAttribute("data-lens", name.toLowerCase());
  // Clicking leaves the pointer on the tab, whose hover popover would otherwise be in frame.
  await page.mouse.move(400, 600);
  const activity = page.getByRole("dialog", { name: /activity details$/ });
  if ((await activity.count()) > 0 && (await activity.first().isVisible())) {
    await page.keyboard.press("Escape");
  }
  await expect(activity).toBeHidden();
  await openBoardSections(page);
  // Opening a section scrolls to it; the picture starts at the board's title and intro.
  await page
    .locator("article[data-lens]")
    .evaluate((article) => article.closest(".overflow-y-auto")?.scrollTo({ top: 0 }));
}

/**
 * Render and read pixels at a device scale factor of 2 whatever the display is.
 * `--force-device-scale-factor` is ignored by Chromium on macOS, and Playwright's own
 * viewport emulation pins the factor to 1, so the capture goes through one CDP session of
 * its own: the override is re-sent right before every screenshot (a later viewport change
 * would otherwise win) and the screenshot is taken on the same session.
 */
class RetinaCapture {
  private constructor(private readonly session: CDPSession) {}

  static async attach(page: Page): Promise<RetinaCapture> {
    return new RetinaCapture(await page.context().newCDPSession(page));
  }

  async screenshot(path: string): Promise<void> {
    await this.session.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const { data } = await this.session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    writeFileSync(path, Buffer.from(data, "base64"));
  }
}

async function capture(
  page: Page,
  retina: RetinaCapture,
  name: string,
  scheme: "light" | "dark",
): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  // Let the theme swap and any fold animation settle before the pixels are read.
  await page.waitForTimeout(400);
  await dismissProviderBanners(page);
  await retina.screenshot(join(RAW_DIR, `${name}-${scheme}.png`));
}

test("capture the marketing product screenshots from the shipped app", async () => {
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });
  const repository = seedMarketingRepo();
  const userData = makeTempDir("rennet-marketing-state-");
  const home = makeTempDir("rennet-marketing-home-");
  const { application } = await launchRennet({ repository, userData, home });
  try {
    const page = await application.firstWindow();
    await page.setViewportSize(VIEWPORT);
    const retina = await RetinaCapture.attach(page);
    await completeWelcome(page);
    await addProject(page, repository);
    await openCapturedReview(page, repository, userData);
    const fixture = await seedMarketingBoard(page, repository, userData);
    const board = page.locator("article[data-lens]");

    // The page shows one surface: the Sequence board, whose steps carry the cited code
    // inline. The other lenses and the Diff view capture the same way; add a
    // `selectLens` / `openDiffView` and a `capture` call here when the page needs one.
    // Each scheme gets a fresh render: the code highlighter picks its theme when a block
    // first mounts, so the capture opens the board the way a user in that scheme would.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.reload();
      await page.setViewportSize(VIEWPORT);
      await expect(board).toHaveAttribute("data-generation", fixture.generation, {
        timeout: 60_000,
      });
      await dismissTips(page);
      await selectLens(page, "Sequence");
      await capture(page, retina, "review-sequence", scheme);
    }
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
