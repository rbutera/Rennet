import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

async function captureReview(page: Page, repository: string): Promise<string> {
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

async function expectTerminalFailure(page: Page): Promise<string> {
  const failure = page.locator('[data-kind="board-failed"]');
  await expect(failure).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-kind="board-empty"]')).toHaveCount(0);
  await expect(page.locator('[data-kind="board-error"]')).toHaveCount(0);
  const failedTabs = page.locator('[data-kind="lens-switcher"] [data-failed="true"]');
  // Design settles `no-spec` in this fixture and has no tab at all; the four
  // harness-backed lenses fail and each must remain reachable through the switcher.
  await expect(failedTabs).toHaveCount(4);
  const sequence = page.locator(
    '[data-kind="lens-switcher"] [data-failed="true"][data-lens="sequence"]',
  );
  await expect(sequence).toHaveAccessibleName("Sequence, failed to generate");
  await sequence.click();
  await expect(failure).toBeVisible();
  const reason = (await failure.textContent()) ?? "";
  expect(reason.length).toBeGreaterThan(0);
  return reason;
}

test("a failed board generation settles visibly and survives an app restart", async () => {
  test.setTimeout(180_000);
  const repository = seedReviewRepo("rennet-e2e-board-failed-");
  const userData = makeTempDir("rennet-e2e-board-failed-state-");
  const home = makeTempDir("rennet-e2e-board-failed-home-");
  let launched = await launchRennet({ repository, userData, home });

  try {
    let page = await launched.application.firstWindow();
    await completeWelcome(page);
    const reviewId = await captureReview(page, repository);
    const firstReason = await expectTerminalFailure(page);

    await launched.application.close();
    launched = await launchRennet({ repository, userData, home });
    page = await launched.application.firstWindow();
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, reviewId);

    expect(await expectTerminalFailure(page)).toBe(firstReason);
  } finally {
    await launched.application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
