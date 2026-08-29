import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { RENNET_PRELOAD_KEYS } from "../src/preload/contract";
import {
  addProject,
  completeWelcome,
  git,
  initRepo,
  launchRennet,
  makeTempDir,
  openDiffView,
  openWorkingTreeReview,
  writeRepoFile,
} from "./harness";

// The local single-repo review-and-invalidate loop, driven through the CURRENT front door:
// past the first-run welcome, add the project, "Start a Review", and the New Chat list's
// Current Checkout row captures the working tree. The Diff view shows the real patchset;
// editing the file on disk stales the pinned review; and Regenerate re-captures. (The
// renderer is also proved hardened: no ambient `process`, only the `invoke` bridge.)
//
// The invalidation half is the reason this spec is not replaceable by the New Chat journey
// spec: it is the only DRIVEN record of the freshness loop (#38, restored by #576), and the
// notice is information rather than a gate — nothing is blocked, and every view stays as
// reachable as it was.
test("captures a repository in a hardened renderer and invalidates safely", async () => {
  test.setTimeout(300_000);

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

    // The hardened renderer, asserted BEFORE the welcome is settled: the preload boundary
    // is a property of the window, not of any screen inside it.
    expect(
      await page.evaluate(() => ({
        process: typeof (globalThis as unknown as { process?: unknown }).process,
        bridge: Object.keys((globalThis as typeof globalThis & { rennet: object }).rennet).sort(),
      })),
    ).toEqual({
      process: "undefined",
      // The exact contract, imported from the preload's own key list (#386): a new
      // capability updates contract.ts and this assertion follows — while anything
      // exposed WITHOUT being declared there still fails the equality.
      bridge: [...RENNET_PRELOAD_KEYS].sort(),
    });
    // Independent public-surface allowlist (review finding): the contract import
    // above only proves the two implementation artifacts agree with each other.
    // This literal is the boundary's OWN record — expanding `window.rennet`
    // must consciously edit this spec, not just contract.ts.
    expect([...RENNET_PRELOAD_KEYS].sort()).toEqual([
      "applyUpdate",
      "listWslDistros",
      "logWslConnect",
      "onUpdateReady",
      "openFullDiskAccessSettings",
      "platform",
      "resolveDaemonForPath",
      "version",
      "wsPort",
    ]);

    await completeWelcome(page);
    // The front door with no projects yet: the add-a-project entry, not a projects list.
    await expect(page.locator('[data-screen="add-project-entry"]')).toBeVisible();

    await addProject(page, repository);
    await openWorkingTreeReview(page);
    await openDiffView(page);

    // The captured working-tree edit, in the changed-files rail and in the diff itself.
    await expect(
      page
        .getByRole("navigation", { name: "Changed files" })
        .getByRole("button", { name: /review-me\.ts/ }),
    ).toBeVisible();
    const added = page.locator('#diff-review-me\\.ts [data-line-state="add"]');
    await expect(added).toContainText("export const value = 2;");

    // Editing the file on disk stales the pinned review, and coming back to the window is what
    // asks. The save happens ONCE. #574 re-saved inside the retry to step around #601 (the
    // watcher losing the first save after a capture); that is fixed, so the workaround is gone
    // and this is one save again, as a reviewer would make it.
    //
    // ⚠️ This spec is NOT a control for #601 and cannot be made into one at this fixture size.
    // Verified by execution, not by reading: with the #601 fix reverted, this spec still passed.
    // The defect needs the daemon's watcher to still be walking the tree when the save lands,
    // and this repository is ONE file — the walk is over in about five milliseconds, long
    // before the save below. The control that does show the harm drives a 1,000-file repository
    // through the real daemon: `packages/server/src/freshness-first-save.test.ts`.
    //
    // The FOCUS is still retried, and only the focus: the ask fires on a window focus event, and
    // one focus can land before the daemon's diff has come back. That is a poll for an answer,
    // not a second attempt at the thing under test. What is NOT retried is the assertion — the
    // notice must appear, or this fails.
    const stale = page.getByTestId("review-stale");
    writeRepoFile(repository, "review-me.ts", "export const value = 3;\n");
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(stale).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    // The old tree is still what is on screen — the notice says so, and does not swap it.
    await expect(added).toContainText("export const value = 2;");

    await stale.getByRole("button", { name: /Regenerate/ }).click();
    await expect(added).toContainText("export const value = 3;", { timeout: 60_000 });
    await expect(stale).toHaveCount(0);
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
