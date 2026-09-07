import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

test("inspects a diff symbol through the daemon's committed index", async () => {
  test.setTimeout(120_000);
  const repository = seedReviewRepo("rennet-e2e-symbol-");
  const userData = makeTempDir("rennet-e2e-symbol-state-");
  const home = makeTempDir("rennet-e2e-symbol-home-");
  const { application } = await launchRennet({ repository, userData, home });
  let bridge: WsRennetBridge | undefined;
  try {
    const page = await application.firstWindow();
    await completeWelcome(page);
    const port = await page.evaluate(() =>
      (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
    );
    bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
    await bridge.invoke("repository.choose", { path: repository });
    const { review } = await bridge.invoke("review.capture", {
      commandId: crypto.randomUUID(),
      repoPath: repository,
    });
    await page.evaluate((id) => {
      location.hash = `#/s/${id}?view=diff`;
    }, review.id);
    const token = page.locator('[data-line-state="add"]').getByRole("button", {
      name: "Inspect widget",
      exact: true,
    });
    await token.click();
    const inspector = page.getByRole("complementary", { name: "Symbol: widget" });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("button", { name: "widget.ts:1" }).first()).toBeVisible();
    await expect(
      page.getByText("Indexed at the reviewed commit; local edits are not indexed."),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await expect(token).toBeFocused();
  } finally {
    bridge?.close();
    await application.close();
    for (const path of [repository, userData, home]) rmSync(path, { recursive: true, force: true });
  }
});
