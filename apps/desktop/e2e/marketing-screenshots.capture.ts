import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { AskLogStore, SessionStore } from "@rennet/adapters";
import { WsRennetBridge } from "@rennet/client";
import { addProject, completeWelcome, launchRennet, makeTempDir } from "./harness";
import { MARKETING_CONVERSATION, seedMarketingConversation } from "./marketing-conversation";
import {
  FIXTURE_FILES,
  fixtureLine,
  seedMarketingBoard,
  seedMarketingRepo,
} from "./marketing-fixture";

/**
 * Capture the marketing site's product screenshots from the SHIPPED app (#470).
 *
 * Not a test and not in the e2e suite: `playwright.screenshots.config.ts` is the only config
 * that matches this file, and `pnpm nx run rennet-marketing:screenshots` is the only thing
 * that runs it. The app is launched exactly as the hermetic specs launch it, with the
 * model-free environment (`RENNET_DISABLE_HARNESS=1`, no `claude`, no `codex`, no network),
 * against the invented `atlas` repository and the board `marketing-fixture.ts` seeds through
 * the production writer. The chat pane shows `marketing-conversation.ts`, appended to the
 * review's own T3 thread as the sidecar's own events between two launches of the app. Raw
 * 2x PNGs land in `apps/marketing/.screenshots-raw/`; the marketing
 * `optimize-screenshots.mjs` step quantises them into `public/product/`.
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

/**
 * The reviewer's own staged work, written through the durable ask log exactly as the
 * Request Changes popover writes it: one request-change on the 429 lines, claiming the quote
 * thread it minted. It is the reviewer's, not the model's; the FAB counts it and the hand-off
 * lane carries it into the work order.
 */
function seedStagedAsk(userData: string, review: { reviewId: string; patchsetId: string }) {
  const start = fixtureLine(FIXTURE_FILES.middleware, "response.statusCode = 429;");
  const end = fixtureLine(FIXTURE_FILES.middleware, 'response.end("rate limit exceeded");');
  const threadId = "quote-1";
  const quote = 'response.statusCode = 429;\nresponse.end("rate limit exceeded");';
  const body =
    'Answer the 429 through json(response, 429, { error: "rate limit exceeded" }) so the envelope in docs/api.md holds.';
  const codeRef = {
    patchsetId: review.patchsetId,
    path: FIXTURE_FILES.middleware,
    side: "head" as const,
    startLine: start,
    endLine: end,
  };
  new AskLogStore(join(userData, "asks")).appendMany(review.reviewId, [
    {
      kind: "quote-open",
      threadId,
      thread: {
        anchor: quote,
        codeRef,
        kind: "comment",
        messages: [{ author: "user", text: body }],
      },
    },
    {
      kind: "stage",
      ask: { id: threadId, anchor: quote, type: "request-change", body, threadId, codeRef },
    },
  ]);
}

/** Wait for the daemon's sidecar to be gone, so the store is closed before it is written. */
async function waitForSidecarExit(userData: string): Promise<void> {
  const claimPath = join(userData, "t3-sidecar.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!existsSync(claimPath)) return;
    let pid: unknown;
    try {
      pid = JSON.parse(readFileSync(claimPath, "utf8")).pid;
    } catch {
      return;
    }
    if (typeof pid !== "number") return;
    try {
      process.kill(pid, 0);
    } catch {
      return; // the process is gone; a stale claim is fine, the daemon replaces it
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
  throw new Error("the T3 sidecar did not stop with the daemon");
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

/** Expand every collapsed finding so its evidence is on the board. */
async function openFindings(page: Page): Promise<void> {
  const toggles = page.locator(
    'article[data-lens] [data-kind="finding"] button[aria-expanded="false"]',
  );
  for (let remaining = 0; remaining < 20; remaining += 1) {
    if ((await toggles.count()) === 0) return;
    await toggles.first().click();
  }
}

/**
 * First-run coachmarks surface as their anchors appear (the hand-off FAB's arrives once an
 * ask is staged), so this runs right before every screenshot, not once.
 */
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
  await openFindings(page);
  // Opening a section scrolls to it; the picture starts at the board's title and intro.
  await page
    .locator("article[data-lens]")
    .evaluate((article) => article.closest(".overflow-y-auto")?.scrollTo({ top: 0 }));
}

/** Scroll the board so `elementId` starts at the top of the frame. */
async function scrollBoardTo(page: Page, elementId: string): Promise<void> {
  const element = page.locator(`article[data-lens] [data-element-id="${elementId}"]`).first();
  await expect(element).toBeVisible();
  await element.evaluate((node) => {
    const scroller = node.closest(".overflow-y-auto");
    if (scroller === null) return;
    const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + top - 24 });
  });
}

/** Route within the session without a reload: the shell reads the hash. */
async function route(page: Page, sessionId: string, query: string): Promise<void> {
  await page.evaluate(
    ([id, search]) => {
      location.hash = `#/s/${encodeURIComponent(id)}${search}`;
    },
    [sessionId, query] as const,
  );
}

async function waitForConversation(page: Page): Promise<void> {
  await expect(page.getByText("Then why does the store wrapper fail open?")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Send a message to start the conversation.")).toHaveCount(0);
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
  await dismissTips(page);
  // The pane opens on the newest turn, but a remount can restore an earlier position and a
  // near-end one hides the pane's own "Scroll to end" pill, so the timeline is scrolled to
  // its end directly: the last answer must sit whole above the composer.
  await page
    .getByText(MARKETING_CONVERSATION[MARKETING_CONVERSATION.length - 1]?.user ?? "")
    .last()
    .evaluate((node) => {
      let scroller: HTMLElement | null = node.parentElement;
      while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight + 1) {
        scroller = scroller.parentElement;
      }
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
    });
  await page.waitForTimeout(400);
  await retina.screenshot(join(RAW_DIR, `${name}-${scheme}.png`));
}

/** Select whole lines of a code block in the page and release the mouse over them. */
async function selectCodeLines(
  page: Page,
  path: string,
  side: "base" | "head",
  startLine: number,
  endLine: number,
): Promise<void> {
  const block = page.locator(`article[data-lens] [data-evidence-path="${path}"]`).first();
  await expect(block).toBeVisible();
  const first = block.locator(`[data-code-side="${side}"][data-code-line="${startLine}"]`).first();
  const last = block.locator(`[data-code-side="${side}"][data-code-line="${endLine}"]`).first();
  // Mid-frame, so the selection, its toolbar and the finding above it are all in the picture.
  await first.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await last.evaluate(
    (end, start) => {
      // Start and end INSIDE the line spans: the toolbar reads the code identity from the
      // nearest `[data-code-patchset]` ancestor of each range end.
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.childNodes.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      end.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    await first.elementHandle(),
  );
}

test("capture the marketing product screenshots from the shipped app", async () => {
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });
  const repository = seedMarketingRepo();
  const userData = makeTempDir("rennet-marketing-state-");
  const home = makeTempDir("rennet-marketing-home-");
  let { application } = await launchRennet({ repository, userData, home });
  try {
    let page = await application.firstWindow();
    await page.setViewportSize(VIEWPORT);
    await completeWelcome(page);
    await addProject(page, repository);
    await openCapturedReview(page, repository, userData);
    const fixture = await seedMarketingBoard(page, repository, userData);
    seedStagedAsk(userData, fixture);

    // The conversation is appended to the sidecar's store while it is stopped, and the
    // sidecar's own projector reads it in at the next boot: close the app, write, relaunch.
    await application.close();
    await waitForSidecarExit(userData);
    seedMarketingConversation({ userData, reviewId: fixture.reviewId });
    ({ application } = await launchRennet({ repository, userData, home }));
    page = await application.firstWindow();
    await page.setViewportSize(VIEWPORT);
    const retina = await RetinaCapture.attach(page);
    const board = page.locator("article[data-lens]");

    // Each scheme gets a fresh render: the code highlighter picks its theme when a block
    // first mounts, so the capture opens the board the way a user in that scheme would.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await route(page, fixture.sessionId, "?view=board&lens=sequence");
      await page.reload();
      await page.setViewportSize(VIEWPORT);
      await expect(board).toHaveAttribute("data-generation", fixture.generation, {
        timeout: 60_000,
      });
      await dismissTips(page);
      await waitForConversation(page);
      // Open the last turn's tool activity so the pane shows the work behind the answer.
      const lastWork = page.getByRole("button", { name: /^Worked for/ }).last();
      if (
        (await lastWork.count()) > 0 &&
        (await lastWork.getAttribute("aria-expanded")) !== "true"
      ) {
        await lastWork.click();
      }

      // The four lens boards, each scrolled so a cited TypeScript span is in frame.
      await selectLens(page, "Sequence");
      await scrollBoardTo(page, "seq-step-bucket");
      await capture(page, retina, "lens-sequence", scheme);

      await selectLens(page, "Decisions");
      await capture(page, retina, "lens-decisions", scheme);

      await selectLens(page, "Flagged");
      await capture(page, retina, "lens-flagged", scheme);

      await selectLens(page, "Design");
      // Reveal the first requirement's cited bucket span beneath its trace chips.
      await page
        .locator('article[data-lens] button[title^="Show src/rate-limit/bucket.ts:"]')
        .first()
        .click();
      await page.mouse.move(400, 600);
      await scrollBoardTo(page, "des-req-limited");
      await capture(page, retina, "lens-design", scheme);

      // Explain and Request Changes on a selected range of the high finding's evidence.
      await selectLens(page, "Flagged");
      await scrollBoardTo(page, "flg-outage");
      const failOpenStart = fixtureLine(FIXTURE_FILES.store, "export function failOpen(");
      await selectCodeLines(page, FIXTURE_FILES.store, "head", failOpenStart, failOpenStart + 3);
      await expect(page.getByRole("button", { name: "Explain", exact: true })).toBeVisible();
      await capture(page, retina, "explain-request-changes", scheme);
      await page.keyboard.press("Escape");

      // The built-in diff view, deep-linked to the middleware file.
      await route(page, fixture.sessionId, "?view=diff");
      await expect(page.getByText(/files changed$/)).toBeVisible({ timeout: 30_000 });
      await page
        .getByRole("navigation", { name: "Changed files" })
        .getByRole("button", { name: /middleware\.ts/ })
        .click();
      await expect(page.locator(`[id="diff-${FIXTURE_FILES.middleware}"]`)).toBeVisible();
      await page.mouse.move(400, 600);
      await page.waitForTimeout(600);
      await capture(page, retina, "diff-viewer", scheme);

      // The hand-off lane in its Changes state: the reviewer's staged ask with its cited lines
      // revealed, and Dispatch Round beneath. (The lane becomes the pull request only once no
      // ask remains and a body has been drafted, which takes a model turn.)
      await route(page, fixture.sessionId, "?view=handoff");
      const askAnchor = page.locator(`button[title^="Show ${FIXTURE_FILES.middleware}:"]`);
      await expect(askAnchor.first()).toBeVisible({ timeout: 30_000 });
      await askAnchor.first().click();
      await page.mouse.move(400, 600);
      await page.waitForTimeout(800);
      await capture(page, retina, "handoff-changes", scheme);
    }
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
