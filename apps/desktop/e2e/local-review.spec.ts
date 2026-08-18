import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { git, initRepo, launchRennet, makeTempDir, writeRepoFile } from "./harness";

// The local single-repo review-and-invalidate loop, driven through the CURRENT
// front door: launch lands on the projects list, "Review directly" opens the direct
// repo/PR entry, and "Choose a repository" captures the working tree. The Files view
// shows the real diff; editing the file on disk invalidates the pinned review; and
// "Regenerate affected review" re-captures. (The renderer is also proved hardened:
// no ambient `process`, only the `invoke` bridge.)
test("captures a repository in a hardened renderer and invalidates safely", async () => {
  const repository = makeTempDir("rennet-e2e-repo-");
  const userData = makeTempDir("rennet-e2e-state-");
  const home = makeTempDir("rennet-e2e-home-");
  initRepo(repository);
  writeRepoFile(repository, "review-me.ts", "export const value = 1;\n");
  git(repository, "add", "review-me.ts");
  git(repository, "commit", "-qm", "initial");
  git(repository, "checkout", "-qb", "feature/review-me");
  writeRepoFile(repository, "review-me.ts", "export const value = 2;\n");

  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();

    // The front door is the app's entry: the projects list, headed "Rennet".
    await expect(page.getByRole("heading", { name: "Rennet" })).toBeVisible();
    expect(
      await page.evaluate(() => ({
        process: typeof (globalThis as unknown as { process?: unknown }).process,
        bridge: Object.keys((globalThis as typeof globalThis & { rennet: object }).rennet).sort(),
      })),
    ).toEqual({
      process: "undefined",
      bridge: ["chooseDirectory", "onMenuRun", "platform", "updateMenu", "wsPort"],
    });

    // "Review directly" reveals the legacy repo/PR entry with "Choose a repository".
    await page.getByRole("button", { name: "Review directly" }).click();
    await page.getByRole("button", { name: "Choose a repository" }).click();

    // A captured review opens on Canvases by default; the raw diff is the Files tab.
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByRole("button", { name: /review-me\.ts/ })).toBeVisible();
    await expect(page.locator("pre.diff")).toContainText("export const value = 2;");

    // Editing the file on disk invalidates the pinned review (the freshness watcher).
    writeRepoFile(repository, "review-me.ts", "export const value = 3;\n");
    await expect(page.getByText("Your code changed.")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("pre.diff")).toContainText("export const value = 2;");
    await page.getByRole("button", { name: "Regenerate affected review" }).click();
    await expect(page.locator("pre.diff")).toContainText("export const value = 3;");
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
