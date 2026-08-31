import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE proof that CAPTURING A CHANGE DRAFTS ITS BOARDS — the core loop, end to end.
//
// `product-and-vision.md` draws it `local --> boards`: you capture a change and you READ
// it as boards. For a long time nothing in the shipped app closed that loop. Two defects,
// one on each side of the wire, and each hid the other:
//
//   1. SERVER — the drafting pipeline had a single caller, the round-regeneration tail,
//      and a round only runs on staged asks, which a reviewer can only stage BY READING A
//      BOARD. So a captured review never got a first board and could not: deadlock. The fix
//      kicks `draftBoardsForReview` off `onReviewOpened` (which `review.capture` fires).
//   2. CLIENT — the review workspace read its boards at the literal generation `"live"`,
//      which no board is ever stamped with (the daemon files every board under
//      `gen:<patchsetId>` and `board.read` matches EXACTLY), so even a drafted board was
//      unreachable. The fix reads at `generationIdForPatchset(review.activePatchsetId)`.
//
// This drives BOTH at once against the REAL `claude`: capture over the app's own daemon
// socket (the #480 router still has no front-door repo-capture surface — same reason
// f1-live-chat captures this way), navigate the real window to the review, and wait for a
// real drafted board to REPLACE the honest-empty state. A green here means the daemon
// drafted, filed under a generation the client asks for, and the board rendered — the whole
// sentence, not a mock of it.
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic, zero-spend specs use `modelFreeEnv`; this runs a REAL `claude` turn on the
// reviewer's own subscription, drafting five lenses. Opt-in, a cost switch not a gate:
// `RENNET_LIVE_E2E=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts board-drafting-live`.
test.skip(process.env.RENNET_LIVE_E2E !== "1", "live harness spec — set RENNET_LIVE_E2E=1");

function liveEnv(disableHarness: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // #569
  if (disableHarness) env.RENNET_DISABLE_HARNESS = "1";
  else delete env.RENNET_DISABLE_HARNESS;
  return env;
}

/** Capture `repository` into a review through the app's own daemon, and open its route.
 *  `review.capture` fires `onReviewOpened`, which is what kicks the drafting under test. */
async function openCapturedReview(page: Page, repository: string): Promise<string> {
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  try {
    await bridge.invoke("repository.choose", { path: repository });
    const { review } = await bridge.invoke("review.capture", {
      commandId: crypto.randomUUID(),
      repoPath: repository,
    });
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, review.id);
    return review.id;
  } finally {
    bridge.close();
  }
}

test("LIVE: capturing a change drafts its boards, and the workspace renders them", async () => {
  // Five real lens drafters over a real harness; generous, this is the whole pipeline.
  test.setTimeout(900_000);
  const repository = seedReviewRepo("board-live-repo-");
  const userData = makeTempDir("board-live-state-");
  const home = makeTempDir("board-live-home-");
  const { application } = await launchRennet({ repository, userData, home, env: liveEnv(false) });
  try {
    const page = await application.firstWindow();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[renderer:error] ${m.text()}`);
    });
    // The first-run welcome is a full-screen gate; clear it or the route never mounts.
    await completeWelcome(page);
    console.log("REVIEW:", await openCapturedReview(page, repository));

    // The workspace mounts on the honest-empty state (no board yet) — the same floor
    // board-lenses.spec drives model-free. This spec's job is to watch it get REPLACED.
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });

    // The drafted board arrives. `article[data-lens]` is a real lens board; before either
    // fix this never appeared — server-side because nothing drafted, client-side because
    // the route asked for a generation the daemon never stamped.
    const board = page.locator("article[data-lens]").first();
    await expect(board).toBeVisible({ timeout: 600_000 });

    // It is stamped with the generation keyed to the review's ACTIVE patchset — the exact
    // string the client asked `board.read` for. A `gen:<patchsetId>`, never the old `"live"`.
    const generation = await board.getAttribute("data-generation");
    console.log("BOARD GENERATION:", generation);
    expect(generation).toMatch(/^gen:/);

    // And the honest-empty is gone — the board replaced it, it did not sit alongside it.
    await expect(page.locator('[data-kind="board-empty"]')).toHaveCount(0);
    await expect(page.locator('[data-kind="board-error"]')).toHaveCount(0);
  } finally {
    await application.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
