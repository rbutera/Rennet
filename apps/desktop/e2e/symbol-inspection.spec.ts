import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import {
  completeWelcome,
  git,
  launchRennet,
  makeTempDir,
  seedReviewRepo,
  writeRepoFile,
} from "./harness";

test("inspects a diff symbol through the daemon's committed index", async () => {
  test.setTimeout(120_000);
  const repository = seedReviewRepo("rennet-e2e-symbol-");
  writeRepoFile(repository, "src/widget.ts", "export const renamed = 2;\n");
  git(repository, "add", "src/widget.ts");
  git(repository, "commit", "-qm", "Rename widget");
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
      name: "Inspect renamed",
      exact: true,
    });
    const code = page.getByRole("group", { name: "Code, use arrow keys to inspect symbols" });
    await code.focus();
    await page.keyboard.press("ArrowRight");
    await expect(code.locator("button[data-symbol]").first()).toBeFocused();
    expect(
      await code
        .locator("button[data-symbol]")
        .evaluateAll(
          (buttons) =>
            buttons.filter((button) => button instanceof HTMLButtonElement && button.tabIndex >= 0)
              .length,
        ),
    ).toBe(0);
    await token.click();
    const inspector = page.getByRole("complementary", { name: "Symbol: renamed" });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("button", { name: "widget.ts:1" }).first()).toBeVisible();
    await expect(
      page.getByText("Indexed at the reviewed commit; local edits are not indexed."),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await expect(token).toBeFocused();
    await page
      .locator('[data-line-state="del"]')
      .getByRole("button", { name: "Inspect widget", exact: true })
      .click();
    const deleted = page.getByRole("complementary", { name: "Symbol: widget" });
    await expect(deleted.getByRole("button", { name: "widget.ts:1" }).first()).toBeVisible();
    await expect(
      page.getByText("Indexed at the base commit; local edits are not indexed."),
    ).toBeVisible();
  } finally {
    bridge?.close();
    await application.close();
    for (const path of [repository, userData, home]) rmSync(path, { recursive: true, force: true });
  }
});
