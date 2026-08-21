import { rmSync } from "node:fs";
import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { launchRennet, makeTempDir, seedReviewRepo } from "./harness";

// The full add-a-project journey (wireframes #1/#2/#37), end to end in a launched
// app: the front door's add flow (type → path → worktree config → confirm), the
// processing screen (the initial context dump, to a done state), the project-detail
// unified smart list (local work rows from real git), and opening a row into a
// review workspace. All of it is model-free — git + the deterministic snapshot
// build — so it drives without a live model turn.
test("adds a project, processes it, lists local work, and opens a review", async () => {
  test.setTimeout(120_000);

  const repository = seedReviewRepo("rennet-e2e-addproj-");
  const userData = makeTempDir("rennet-e2e-state-");
  const home = makeTempDir("rennet-e2e-home-");

  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();

    // Front door, empty projects list → the add-a-project card.
    await expect(page.getByRole("heading", { name: "Rennet" })).toBeVisible();
    await page.getByRole("button", { name: "Add a project" }).click();

    // Step 1: the add flow defaults to the project-repo kind, so the card is
    // already selected before any click.
    await expect(page.getByRole("button", { name: /Project repo/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Point at a single repo. The source switcher defaults to Local, and the in-app directory
    // browser (source-aware project selection) replaces the native picker: type the fixture path
    // into its path bar to navigate there, then continue. No native dialog anywhere.
    await page.getByRole("button", { name: /Project repo/ }).click();
    await expect(page.getByRole("button", { name: /^Local/ })).toBeVisible();
    const pathBar = page.getByRole("textbox", { name: "Directory path" });
    await pathBar.fill(repository);
    await pathBar.press("Enter");
    // The breadcrumb shows the repo's own directory once the browser resolved the typed path —
    // proof the flow's path is now the fixture, not the daemon's home it opened on.
    await expect(
      page.getByRole("button", { name: basename(repository), exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2: worktree config — the discovered repo is included by default; confirm.
    await expect(page.getByText(/^Found in/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();

    // The processing screen: the initial context dump renders and reaches a done
    // state, offering to open the freshly-processed project.
    await expect(page.locator(".processing")).toBeVisible();
    const openProject = page.getByRole("button", { name: /^Open / });
    await expect(openProject).toBeVisible({ timeout: 60_000 });
    await openProject.click();

    // Project detail: the unified smart list renders real local work as rows.
    await expect(page.locator(".project-detail")).toBeVisible();
    await expect(page.getByRole("button", { name: /^All/ })).toBeVisible();
    const rows = page.locator(".smart-row");
    await expect(rows.first()).toBeVisible();

    // Opening a row captures the project's working tree into a review workspace.
    await rows.first().locator(".smart-row-open").click();
    await expect(page.getByRole("tab", { name: "Canvases" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
