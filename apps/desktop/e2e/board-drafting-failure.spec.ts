import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { addProject, completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

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
  // The internal-state line an empty board used to print is never what a failure reads as.
  await expect(page.getByText("No board for this generation yet.")).toHaveCount(0);
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

/**
 * Mint a New Chat session for the project and wait until its preparation has stopped. In
 * the model-free environment capture succeeds and drafting fails (no runnable seat), which
 * is a real stopped preparation with a review attached.
 */
async function mintFailedSession(page: Page, repository: string): Promise<string> {
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
    await expect
      .poll(
        async () => {
          const { sessions } = await bridge.invoke("session.list", {});
          const row = sessions.find((candidate) => candidate.id === session.id);
          return row?.reviewId !== undefined && row.preparation?.status === "failed";
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    return session.id;
  } finally {
    bridge.close();
  }
}

test("a stopped preparation reads as one failure block with Retry, over the lens failures", async () => {
  // review-preparation-reliability 3.3. The thin strip that used to sit over the boards is
  // one block: the daemon's plain sentence and Retry, and no stage label. The per-lens
  // failures under it stay reachable, because they are real results of this generation.
  test.setTimeout(180_000);
  const repository = seedReviewRepo("rennet-e2e-prep-failed-");
  const userData = makeTempDir("rennet-e2e-prep-failed-state-");
  const home = makeTempDir("rennet-e2e-prep-failed-home-");
  const { application } = await launchRennet({ repository, userData, home });
  try {
    const page = await application.firstWindow();
    await completeWelcome(page);
    await addProject(page, repository);
    const sessionId = await mintFailedSession(page, repository);
    await page.evaluate((id) => {
      location.hash = `#/s/${encodeURIComponent(id)}`;
    }, sessionId);

    const block = page.locator('[data-testid="preparation-failure"]');
    await expect(block).toBeVisible({ timeout: 60_000 });
    await expect(block).toHaveAttribute("data-status", "failed");
    await expect(block.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(block).not.toContainText(/capture failed|review failed/i);
    await expect(page.getByText("No board for this generation yet.")).toHaveCount(0);
    // Exactly one account of the stop: no second strip, no waiting presence.
    await expect(page.locator('[data-testid="preparation-failure"]')).toHaveCount(1);
    await expect(page.locator('[data-kind="preparation-presence"]')).toHaveCount(0);
    await expect(page.locator('[data-kind="board-failed"]').first()).toBeVisible();
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
