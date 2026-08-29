import { rmSync } from "node:fs";
import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addProject,
  completeWelcome,
  launchRennet,
  makeTempDir,
  openDiffView,
  openWorkingTreeReview,
  seedReviewRepo,
} from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// The Board — the review workspace that replaced the canvas era — in the real app.
//
// #574 deleted `review-canvases.spec.ts` because every surface it asserted had been
// removed in the delete-first cutover. That deletion was right and the suite was
// smaller for it, but the honest accounting was uncomfortable: the suite stopped
// asserting a surface that no longer exists and gained NOTHING asserting the one that
// replaced it. This is the other half. The replacement is `board/board-view.tsx`,
// mounted from `app/review-workspace-route.tsx:249`; it had jsdom coverage and no
// launched-app coverage at all.
//
// MODEL-FREE, like the rest of the free suite (`RENNET_DISABLE_HARNESS=1`): no harness
// runs, so nothing drafts a board. That is not a limitation to work around here — it IS
// the case worth driving, because it is what every reviewer sees in the seconds before
// a board arrives, and the surface has to be honest in it rather than blank. Assertions
// are on STRUCTURE and on the honest-absent state, never on model output.
// ─────────────────────────────────────────────────────────────────────────────

test("the board is the review workspace, and is honest when no board is drafted", async () => {
  test.setTimeout(300_000);

  const repository = seedReviewRepo("rennet-e2e-board-");
  const userData = makeTempDir("rennet-e2e-board-state-");
  const home = makeTempDir("rennet-e2e-board-home-");
  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();
    await completeWelcome(page);
    await addProject(page, repository);
    await openWorkingTreeReview(page);

    // The board is the DEFAULT view of a session route — no `?view` needed to reach it.
    const board = page.locator('[data-kind="lens-board-view"]');
    await expect(board).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`REVIEW · ${basename(repository)}`)).toBeVisible();

    // The honest-absent state, and the reason this spec drives the model-free floor rather
    // than treating it as a gap: with no harness there is no board, and the surface SAYS SO
    // ("No board for this generation yet.") instead of rendering an empty frame that reads
    // as a board with nothing in it. Observed, not assumed — this is what the app rendered.
    await expect(page.locator('[data-kind="board-empty"]')).toBeVisible({ timeout: 30_000 });

    // ⚠️ THE NEXT TWO ARE ABSENCE ASSERTIONS, and their limits are worth stating rather than
    // discovering later: each passes vacuously if its selector ever drifts from the component.
    // A control run (flipping both to `toBe(1)`) confirms they evaluate against a genuinely
    // empty DOM — `Expected: 1, Received: 0` — so they are not silently erroring. What that
    // control does NOT prove is that the selectors would still match a REAL switcher or error
    // panel if one appeared; only a fixture that drafts a board could show that, and none
    // exists model-free. Provenance is pinned instead: `board/lens-switcher.tsx:49-51`
    // (role/aria-label/data-kind) and `board/board-view.tsx:116`.
    //
    // The contract itself is C05 6.2's absent-not-disabled rule: a lens with no board is not
    // in the switcher at all, so with no boards there is no switcher — never a row of dead
    // segments implying content that was never drafted.
    expect(await page.getByRole("tablist", { name: "Lens" }).count()).toBe(0);
    // An absent board and an UNREADABLE one are different facts. Nothing failed here, so the
    // error panel must not be standing in for the empty state.
    expect(await page.locator('[data-kind="board-error"]').count()).toBe(0);

    // The session-view pill round-trips without losing the review: board → diff → board, and
    // the same review is still underneath. `?view` is a refinement of one location, so a
    // toggle must never re-resolve to a different session.
    await openDiffView(page);
    await expect(board).toHaveCount(0);
    await page.getByRole("button", { name: "Back to board" }).click();
    await expect(board).toBeVisible();
    await expect(page.getByText(`REVIEW · ${basename(repository)}`)).toBeVisible();
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
