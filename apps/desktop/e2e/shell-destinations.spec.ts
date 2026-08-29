import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  addProject,
  completeWelcome,
  launchRennet,
  makeTempDir,
  openWorkingTreeReview,
  seedReviewRepo,
} from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// Two shell controls that fired into a void, EXECUTED in the real app rather than reasoned
// about (AGENTS.md: "control-flow claims get executed").
//
//   • the session top-bar's **Map** toggle — `?view=map` had no branch in the workspace
//     route, so the toggle lit up, the URL changed, and the board the reviewer was already
//     reading stayed on screen. What makes this invisible from a screenshot is precisely
//     that SOMETHING is rendered; the assertion has to be that it is a DIFFERENT something.
//   • **⌘N** — it pushed a dialog id nothing mounts, so the screen never moved. A real key
//     press through the real window is the only way to prove the chord reaches the one key
//     owner at all, past whatever the focused element does with it.
//
// The Escape half of the ⌘N defect (a phantom `openDialogs` entry eating the next Escape)
// is proved in `keybindings.dom.test.tsx`, which can observe `preventDefault` on the event
// itself. Playwright cannot see a consumed key, only its absent effect, so asserting it
// here would be an assertion that passes for the wrong reason.
// ─────────────────────────────────────────────────────────────────────────────

test("the Map toggle and ⌘N reach real destinations", async () => {
  test.setTimeout(300_000);

  const repository = seedReviewRepo("rennet-e2e-shell-");
  const userData = makeTempDir("rennet-e2e-state-");
  const home = makeTempDir("rennet-e2e-home-");
  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();
    await completeWelcome(page);
    await addProject(page, repository);
    await openWorkingTreeReview(page);

    // On the board: its own eyebrow is the marker for "the default view is on screen".
    const board = page.getByText(/^REVIEW ·/);
    const map = page.locator(".context-map-title");
    await expect(board).toBeVisible();
    await expect(map).toHaveCount(0);

    // ── Map ──────────────────────────────────────────────────────────────────
    await page
      .locator('[data-slot="toggle-group"]')
      .getByRole("button", { name: "Map", exact: true })
      .click();
    // The context map mounted…
    await expect(map).toBeVisible({ timeout: 60_000 });
    // …and — the load-bearing half — the board it replaced is GONE. Without this the spec
    // would pass against the broken build, because the broken build renders the board.
    await expect(board).toHaveCount(0);

    // Back returns to the board rather than leaving the session for New Chat.
    await page.getByRole("button", { name: "Back to board" }).click();
    await expect(board).toBeVisible();
    await expect(map).toHaveCount(0);

    // ── ⌘N ───────────────────────────────────────────────────────────────────
    await page.keyboard.press("Meta+n");
    await expect(page.locator('[data-screen="new-chat"]')).toBeVisible({ timeout: 30_000 });
    // The surface it left is gone, not overlaid — the old ⌘N left the reviewer exactly here.
    await expect(board).toHaveCount(0);
  } finally {
    await application.close();
    for (const dir of [repository, userData, home]) rmSync(dir, { recursive: true, force: true });
  }
});
