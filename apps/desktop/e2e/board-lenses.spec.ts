import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { AskLogStore } from "@rennet/adapters";
import {
  BOARD_DESIGN_DECOY_PATH,
  BOARD_DESIGN_SCENARIO,
  BOARD_DESIGN_SPEC_PATH,
  BOARD_IMPLEMENTATION_PATH,
  BOARD_TEST_PATH,
  seedBoardFixture,
} from "./board-fixture";
import {
  addProject,
  completeWelcome,
  git,
  launchRennet,
  makeTempDir,
  openDiffView,
  openWorkingTreeReview,
  seedReviewRepo,
  writeRepoFile,
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
    // panel if one appeared. The positive persisted-board journey below supplies that
    // complementary proof; this test remains the honest-absence half of the contract.
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

function currentHash(page: Parameters<typeof seedBoardFixture>[0]): Promise<string> {
  return page.evaluate(() => location.hash);
}

async function expectQuery(
  page: Parameters<typeof seedBoardFixture>[0],
  expected: Record<string, string>,
): Promise<void> {
  const hash = await currentHash(page);
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  expect(Object.fromEntries(query)).toEqual(expected);
}

async function installScrollProbe(page: Parameters<typeof seedBoardFixture>[0]): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { rennetE2eScrollTargets: string[] };
    target.rennetE2eScrollTargets = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(
      options?: boolean | ScrollIntoViewOptions,
    ) {
      target.rennetE2eScrollTargets.push(this.id);
      original.call(this, options);
    };
  });
}

async function scrollTargets(page: Parameters<typeof seedBoardFixture>[0]): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { rennetE2eScrollTargets?: string[] }).rennetE2eScrollTargets ?? [],
  );
}

test("a persisted board owns lens, generation, and captured-code navigation in the launched app", async () => {
  test.setTimeout(300_000);

  const repository = seedReviewRepo("rennet-e2e-board-positive-");
  writeRepoFile(
    repository,
    BOARD_DESIGN_DECOY_PATH,
    "# Earlier widget specification\n\nThe widget SHALL expose the old value.\n",
  );
  git(repository, "add", BOARD_DESIGN_DECOY_PATH);
  git(repository, "commit", "-qm", "spec: preserve earlier widget contract");
  git(repository, "branch", "-f", "main", "HEAD");
  writeRepoFile(
    repository,
    BOARD_DESIGN_SPEC_PATH,
    [
      "# Widget value specification",
      "",
      "## Why",
      "Reviewers need the specification and implementation evidence in one reading path.",
      "",
      "## MODIFIED Requirements",
      "",
      "### Requirement: Expose the reviewed widget value",
      "The widget SHALL expose the reviewed value.",
      "",
      "#### Scenario: Reading the widget",
      BOARD_DESIGN_SCENARIO,
      "",
    ].join("\n"),
  );
  writeRepoFile(repository, BOARD_TEST_PATH, "import { widget } from './widget';\nvoid widget;\n");
  const userData = makeTempDir("rennet-e2e-board-positive-state-");
  const home = makeTempDir("rennet-e2e-board-positive-home-");
  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();
    await completeWelcome(page);
    await addProject(page, repository);
    await openWorkingTreeReview(page);
    const fixture = await seedBoardFixture(page, repository, userData);
    const askLog = new AskLogStore(join(userData, "asks"));
    await page.reload();
    expect((await currentHash(page)).split("?")[0]).toBe(
      `#/s/${encodeURIComponent(fixture.sessionId)}`,
    );

    const board = page.locator("article[data-lens]");
    await expect(board).toHaveAttribute("data-generation", fixture.liveGeneration, {
      timeout: 60_000,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    const topBar = page.locator('[data-slot="session-top-bar"]');
    const rail = topBar.locator('[data-slot="lens-switcher"] [role="tablist"]');
    await expect(rail).toBeVisible();
    expect(
      await rail.locator("[data-lens]").evaluateAll((tabs) => tabs.map((tab) => tab.dataset.lens)),
    ).toEqual(["design", "sequence", "decisions", "flagged", "noise"]);
    const [topBarBox, railBox] = await Promise.all([topBar.boundingBox(), rail.boundingBox()]);
    if (topBarBox === null || railBox === null) throw new Error("lens rail has no layout box");
    expect(
      Math.abs(topBarBox.x + topBarBox.width / 2 - (railBox.x + railBox.width / 2)),
    ).toBeLessThan(2);

    const flaggedTab = rail.locator('[data-lens="flagged"]');
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");
    await expect(flaggedTab.locator("[data-testid=lens-open-count]")).toHaveText("1");
    await expect(flaggedTab.locator("[data-testid=lens-delta-pip]")).toHaveCount(0);
    await flaggedTab.click();
    await expect(board).toHaveAttribute("data-lens", "flagged");
    const finding = board.locator('[data-kind="finding"]');
    await expect(finding).toHaveCount(1);

    await finding.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(flaggedTab.locator("[data-testid=lens-open-count]")).toHaveCount(0);
    await expect(flaggedTab).toHaveAccessibleName(/^Flagged, 0 open(?:, changed this round)?$/);
    await page.reload();
    await expect(board).toHaveAttribute("data-lens", "flagged", { timeout: 60_000 });
    await expect(finding).toHaveAttribute("data-status", "dismissed");
    await finding.locator("button[aria-expanded]").click();
    await finding.getByRole("button", { name: "Dismissed · Undo" }).click();
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");

    await finding.getByRole("button", { name: "Request This Change" }).click();
    await expect(flaggedTab.locator("[data-testid=lens-open-count]")).toHaveCount(0);
    await expect(finding.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(board).toHaveAttribute("data-lens", "flagged", { timeout: 60_000 });
    await finding.getByRole("button", { name: "Staged · Request Change" }).click();
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");
    await expect
      .poll(() => Object.keys(askLog.readProjection(fixture.reviewId).stagedAsks))
      .toEqual([]);
    await page.reload();
    await expect(board).toHaveAttribute("data-lens", "flagged", { timeout: 60_000 });
    await expect(finding.getByRole("button", { name: "Request This Change" })).toBeVisible();
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");

    await finding.getByRole("button", { name: "Discuss", exact: true }).click();
    const chatComposer = page.getByLabel("Message the orchestrator");
    await expect(chatComposer).toBeVisible();
    await expect(chatComposer).toBeFocused();
    await expect
      .poll(() => Object.values(askLog.readProjection(fixture.reviewId).quoteThreads))
      .toContainEqual(
        expect.objectContaining({
          kind: "explain",
          anchor: "Return the reviewed value from the implementation.",
        }),
      );
    await page.reload();
    await expect(board).toHaveAttribute("data-lens", "flagged", { timeout: 60_000 });
    await page.getByRole("button", { name: "Open chat" }).click();
    await expect(
      page
        .locator(".rennet-chat-dock")
        .getByText("“Return the reviewed value from the implementation.”", { exact: true }),
    ).toBeVisible();

    const beforeDesign = await page.evaluate(() => history.length);
    await rail.getByRole("tab", { name: /Design/ }).click();
    expect(await page.evaluate(() => history.length)).toBe(beforeDesign);
    await expectQuery(page, { lens: "design" });
    await expect(board).toHaveAttribute("data-lens", "design");
    await expect(
      board.getByRole("heading", { name: "Widget value specification", level: 1 }),
    ).toBeVisible();
    await expect(
      board.getByText(
        "Reviewers need the specification and implementation evidence in one reading path.",
      ),
    ).toBeVisible();
    const stats = board.locator('[data-kind="board-stats"]');
    await expect(stats.getByText("Requirements", { exact: true })).toBeVisible();
    await expect(stats.getByText("1", { exact: true })).toBeVisible();
    await expect(stats.getByText("Capabilities", { exact: true })).toBeVisible();
    await expect(stats.getByText("0 new / 1 modified", { exact: true })).toBeVisible();
    const designSection = board.locator(
      '[data-kind="board-section"][data-section-id^="design-section:"]',
    );
    await expect(designSection).toBeVisible();
    const designSectionId = `design-section:${fixture.liveGeneration}:design`;
    await expect(designSection).toHaveAttribute("id", designSectionId);
    await expect(designSection).toHaveAttribute("data-section-id", designSectionId);
    const artifactSource = board.locator(
      `[data-kind="artifact-chip"][data-source-path="${BOARD_DESIGN_SPEC_PATH}"]`,
    );
    await expect(artifactSource).toBeVisible();
    await expect(artifactSource).toHaveAttribute("href", `#${designSectionId}`);
    await expect(artifactSource).toHaveAttribute("data-target-id", designSectionId);
    await expect(artifactSource).toHaveAttribute("aria-label", "Jump to widget/spec.md");
    await page.setViewportSize({ width: 1440, height: 480 });
    const boardScroller = page
      .locator(".min-h-0.flex-1.overflow-y-auto")
      .filter({ has: page.locator('[data-kind="lens-board-view"]') });
    await expect(boardScroller).toHaveCount(1);
    await boardScroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const beforeAnchorScroll = await boardScroller.evaluate((element) => element.scrollTop);
    expect(beforeAnchorScroll).toBe(0);
    await installScrollProbe(page);
    const beforeArtifactJump = await currentHash(page);
    const beforeArtifactHistory = await page.evaluate(() => history.length);
    await artifactSource.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error("artifact source is not an element");
      element.click();
    });
    expect(await currentHash(page)).toBe(beforeArtifactJump);
    expect(await page.evaluate(() => history.length)).toBe(beforeArtifactHistory);
    await expect.poll(() => scrollTargets(page)).toContain(designSectionId);
    await expect
      .poll(() => boardScroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeAnchorScroll);
    await expect
      .poll(async () => {
        const [sectionBox, scrollerBox, headerBox] = await Promise.all([
          designSection.boundingBox(),
          boardScroller.boundingBox(),
          topBar.boundingBox(),
        ]);
        if (sectionBox === null || scrollerBox === null || headerBox === null) return false;
        const unobscuredTop = Math.max(scrollerBox.y, headerBox.y + headerBox.height);
        return sectionBox.y >= unobscuredTop - 1;
      })
      .toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    const capabilityGrid = board.getByRole("navigation", { name: "Design capabilities" });
    const capability = capabilityGrid.getByRole("link", { name: "Jump to widget-value" });
    await expect(capability).toHaveAttribute("href", `#${designSectionId}`);
    await expect(capability).toHaveAttribute("data-capability", "widget-value");
    await expect(capability).toHaveAttribute("data-spec-delta", "modified");
    await expect(capability).toContainText("1 requirement · 1 scenario");
    await installScrollProbe(page);
    const beforeCapabilityJump = await currentHash(page);
    const beforeCapabilityHistory = await page.evaluate(() => history.length);
    await capability.click();
    expect(await currentHash(page)).toBe(beforeCapabilityJump);
    expect(await page.evaluate(() => history.length)).toBe(beforeCapabilityHistory);
    await expect.poll(() => scrollTargets(page)).toContain(designSectionId);
    await expect(
      designSection.locator(
        `[data-kind="source-chip"][data-source-path="${BOARD_DESIGN_SPEC_PATH}"][data-source-line="6"]`,
      ),
    ).toBeVisible();
    await expect(board.locator(`[data-source-path="${BOARD_DESIGN_DECOY_PATH}"]`)).toHaveCount(0);
    await expect(
      board.getByRole("heading", { name: "Expose the reviewed widget value" }),
    ).toBeVisible();
    await expect(board.getByText(BOARD_DESIGN_SCENARIO)).toBeVisible();
    await expect(board.getByText("covered by 2 hunks · 1 test")).toBeVisible();
    const requirement = board.locator('[data-kind="requirement"][data-spec-delta="modified"]');
    await expect(requirement).toBeVisible();
    await expect(
      requirement.locator('[data-kind="spec-delta"][data-spec-delta="modified"]'),
    ).toBeVisible();
    await expect(
      board.locator(
        `[data-kind="related-file-chip"][data-source-path="${BOARD_IMPLEMENTATION_PATH}"]`,
      ),
    ).toBeVisible();
    await expect(
      board.locator(`[data-kind="related-file-chip"][data-source-path="${BOARD_TEST_PATH}"]`),
    ).toBeVisible();

    const sequenceTab = rail.getByRole("tab", { name: /Sequence/ });
    const sequenceLabel = sequenceTab.locator("span").last();
    const containerThreshold = await page.evaluate(
      () => 46 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect(topBarBox.width).toBeGreaterThan(containerThreshold);
    expect(await sequenceLabel.evaluate((label) => getComputedStyle(label).display)).not.toBe(
      "none",
    );

    await page.setViewportSize({ width: 720, height: 900 });
    await expect
      .poll(async () => (await topBar.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(containerThreshold);
    await expect
      .poll(() => sequenceLabel.evaluate((label) => getComputedStyle(label).display))
      .toBe("none");
    await expect(sequenceTab).toBeVisible();
    await expect(sequenceTab).toHaveAccessibleName(/Sequence/);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(() => sequenceLabel.evaluate((label) => getComputedStyle(label).display))
      .not.toBe("none");

    const beforeLens = await page.evaluate(() => history.length);
    await rail.getByRole("tab", { name: "Sequence" }).click();
    expect(await page.evaluate(() => history.length)).toBe(beforeLens);
    await expectQuery(page, { lens: "sequence" });
    await expect(board).toHaveAttribute("data-lens", "sequence");

    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await expectQuery(page, { view: "diff", lens: "sequence" });
    await expect(rail.getByRole("tab", { selected: true })).toHaveCount(0);

    await page.getByRole("button", { name: "History", exact: true }).click();
    await expectQuery(page, { view: "rounds", lens: "sequence" });
    const generations = page.getByRole("tablist", { name: "Generation" });
    await expect(generations).toBeVisible();
    await expect(generations.getByRole("tab")).toHaveCount(2);
    const beforeGeneration = await page.evaluate(() => history.length);
    await generations.getByRole("tab", { name: /Generation 1/ }).click();
    expect(await page.evaluate(() => history.length)).toBe(beforeGeneration);
    await expectQuery(page, {
      view: "rounds",
      lens: "sequence",
      generation: fixture.frozenGeneration,
    });
    await expect(board).toHaveAttribute("data-generation", fixture.frozenGeneration);

    await rail.getByRole("tab", { name: "Flagged" }).click();
    await expectQuery(page, { generation: fixture.frozenGeneration });
    await expect(board).toHaveAttribute("data-lens", "flagged");
    await expect(board).toHaveAttribute("data-generation", fixture.frozenGeneration);

    await rail.getByRole("tab", { name: "Sequence" }).click();
    await expectQuery(page, { lens: "sequence", generation: fixture.frozenGeneration });
    await page.getByRole("button", { name: "widget.ts:1" }).click();
    const implementation = page.getByRole("button", {
      name: BOARD_IMPLEMENTATION_PATH,
      exact: true,
    });
    await expect(implementation).toBeVisible();
    await expect(page.getByRole("button", { name: "View test", exact: true })).toBeVisible();

    await installScrollProbe(page);
    const beforeFilename = await page.evaluate(() => history.length);
    await implementation.click();
    expect(await page.evaluate(() => history.length)).toBe(beforeFilename);
    await expectQuery(page, {
      view: "diff",
      lens: "sequence",
      generation: fixture.frozenGeneration,
      file: BOARD_IMPLEMENTATION_PATH,
    });
    await expect(page.locator(`[id="diff-${BOARD_IMPLEMENTATION_PATH}"]`)).toBeVisible();
    await expect.poll(() => scrollTargets(page)).toContain(`diff-${BOARD_IMPLEMENTATION_PATH}`);

    await rail.getByRole("tab", { name: "Sequence" }).click();
    await page.getByRole("button", { name: "widget.ts:1" }).click();
    await installScrollProbe(page);
    const beforeCounterpart = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: "View test", exact: true }).click();
    expect(await page.evaluate(() => history.length)).toBe(beforeCounterpart);
    await expectQuery(page, {
      view: "diff",
      lens: "sequence",
      generation: fixture.frozenGeneration,
      file: BOARD_TEST_PATH,
    });
    await expect(page.locator(`[id="diff-${BOARD_TEST_PATH}"]`)).toBeVisible();
    await expect.poll(() => scrollTargets(page)).toContain(`diff-${BOARD_TEST_PATH}`);
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
