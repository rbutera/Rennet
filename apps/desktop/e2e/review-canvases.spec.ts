import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { launchRennet, makeTempDir, seedOpenSpecRepo } from "./harness";

// The Canvases surface, end to end in a launched app: opening a review, the review
// lenses (Decisions / Flagged / Noise), the structured OpenSpec viewer on the Spec
// angle, the raw diff on the Files view, the symbol inspector from a clicked
// identifier, and stepping back to Projects.
//
// Assertions are MODEL-AGNOSTIC: they check that each surface MOUNTS and that the
// model-free OpenSpec parse renders its real structure — never model output — so
// they hold whether the deterministic floor or a live turn produced the canvases
// (see harness.ts `modelFreeEnv` for why full hermeticity is a follow-up). The
// generous timeouts tolerate a live turn if one is discovered despite the env.

/** Land on the front door, open the direct entry, and capture the test repo. */
async function openReviewDirectly(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Rennet" })).toBeVisible();
  await page.getByRole("button", { name: "Review directly" }).click();
  await page.getByRole("button", { name: "Choose a repository" }).click();
  // A captured review opens on Canvases; the lens tabs appear once the set loads.
  await expect(page.getByRole("tab", { name: "Decisions" })).toBeVisible({ timeout: 60_000 });
}

test("renders every review lens and the structured OpenSpec viewer", async () => {
  test.setTimeout(120_000);

  const { repository, changeName } = seedOpenSpecRepo("rennet-e2e-canvas-");
  const userData = makeTempDir("rennet-e2e-state-");
  const home = makeTempDir("rennet-e2e-home-");

  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();
    await openReviewDirectly(page);

    // Decisions is the default lens; its canvas mounts.
    await expect(page.locator(".decisions-canvas")).toBeVisible();

    // Flagged: its own index surface mounts (findings, or the honest empty/failed state).
    await page.getByRole("tab", { name: "Flagged" }).click();
    await expect(page.locator(".flagged-canvas")).toBeVisible();

    // Noise: the grouped-churn surface mounts (groups, or the honest empty/failed state).
    await page.getByRole("tab", { name: "Noise" }).click();
    await expect(page.locator(".noise-canvas")).toBeVisible();

    // Spec: the structured OpenSpec viewer renders the review's REAL change — this is
    // the model-free parse, so its content is deterministic.
    await page.getByRole("tab", { name: "Spec" }).click();
    await expect(page.locator(".openspec-view")).toBeVisible();
    await expect(page.locator(".ospec-name")).toHaveText(changeName);
    await expect(page.getByRole("heading", { name: "Proposal" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Spec deltas" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "The counter advances by the caller's step" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    // Files: the raw diff of the reviewed code file.
    await page.getByRole("tab", { name: "Files" }).click();
    await page.getByRole("button", { name: /counter\.ts/ }).click();
    await expect(page.locator("pre.diff")).toContainText("step + 1");

    // Dispose: step back out of the review to the projects front door.
    await page.getByRole("button", { name: "Back to projects" }).click();
    await expect(page.getByRole("heading", { name: "Rennet" })).toBeVisible();
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("opens the symbol inspector from a clicked identifier", async () => {
  test.setTimeout(120_000);

  const { repository } = seedOpenSpecRepo("rennet-e2e-symbol-");
  const userData = makeTempDir("rennet-e2e-state-");
  const home = makeTempDir("rennet-e2e-home-");

  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();
    await openReviewDirectly(page);

    // The Sequence lens lists the deterministic decomposition's elements (no model
    // needed), so a substantive code change always yields a selectable element.
    // Selecting one renders its real diff in the code view.
    await page.getByRole("tab", { name: "Sequence" }).click();
    await page.locator(".flat-element-select").first().click();
    await expect(page.locator(".diff-zoom .code-view")).toBeVisible({ timeout: 30_000 });

    // Clicking a code identifier opens the in-app symbol inspector (wireframes #8).
    await page.locator("button.rtok-symbol").first().click();
    const inspector = page.locator(".symbol-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText("SYMBOL")).toBeVisible();

    // The inspector closes cleanly.
    await page.getByRole("button", { name: "Close symbol inspector" }).click();
    await expect(inspector).toHaveCount(0);
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
