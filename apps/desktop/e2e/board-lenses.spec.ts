import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AskLogStore, SessionStore } from "@rennet/adapters";
import { WsRennetBridge } from "@rennet/client";
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
  seedReviewRepo,
  writeRepoFile,
} from "./harness";

test("the board reports a failed drafting attempt without disguising it as empty", async () => {
  test.setTimeout(120_000);
  const repository = seedReviewRepo("rennet-e2e-board-");
  const userData = makeTempDir("rennet-e2e-board-state-");
  const home = makeTempDir("rennet-e2e-board-home-");
  const { application } = await launchRennet({ repository, userData, home });
  try {
    const page = await application.firstWindow();
    await completeWelcome(page);
    await addProject(page, repository);
    await openFixtureReview(page, repository, userData);
    const board = page.locator('[data-kind="lens-board-view"]');
    await expect(board).toBeVisible();
    await expect(board.locator('[data-kind="board-failed"]')).toContainText("no runnable seat");
    await expect(board.locator('[data-kind="board-empty"]')).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Lens" }).getByRole("tab")).toHaveCount(5);
    await openDiffView(page);
    await expect(board).toHaveCount(0);
    await page.getByRole("button", { name: "Back to board" }).click();
    await expect(board.locator('[data-kind="board-failed"]')).toBeVisible();
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

async function openFixtureReview(
  page: Parameters<typeof seedBoardFixture>[0],
  repository: string,
  userData: string,
): Promise<void> {
  // This journey starts with captured evidence. New Chat's target-picker journey
  // has separate coverage; use its production mint/capture command here.
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
          const captured = sessions.find((candidate) => candidate.id === session.id);
          return captured?.reviewId !== undefined && captured.preparation?.status === "failed";
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const sessions = new SessionStore(join(userData, "sessions"));
    sessions.setPreparation(session.id, undefined);
    await page.evaluate((id) => {
      location.hash = `#/s/${encodeURIComponent(id)}`;
    }, session.id);
    await page.reload();
  } finally {
    bridge.close();
  }
}

async function revealCitation(
  page: Parameters<typeof seedBoardFixture>[0],
  name: string,
): Promise<void> {
  const chip = page.getByRole("button", { name, exact: true });
  if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
}

async function openBoardSections(page: Parameters<typeof seedBoardFixture>[0]): Promise<void> {
  const toggles = page.locator(
    'article[data-lens] [data-kind="board-section"] button[aria-label^="Toggle "][aria-expanded="false"]',
  );
  for (const toggle of await toggles.all()) await toggle.click();
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
    await openFixtureReview(page, repository, userData);
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
    const [railSlotBox, viewControlsBox] = await Promise.all([
      topBar.locator('[data-slot="lens-switcher"]').boundingBox(),
      topBar.getByRole("group", { name: "Session view" }).boundingBox(),
    ]);
    if (!railSlotBox || !viewControlsBox) throw new Error("review navigation has no layout");
    expect(railSlotBox.x).toBeGreaterThanOrEqual(topBarBox.x);
    expect(
      railSlotBox.x + railSlotBox.width <= viewControlsBox.x ||
        railSlotBox.y >= viewControlsBox.y + viewControlsBox.height,
    ).toBe(true);

    const flaggedTab = rail.locator('[data-lens="flagged"]');
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");
    await expect(flaggedTab.locator("[data-testid=lens-open-count]")).toHaveText("1");
    await expect(flaggedTab.locator("[data-testid=lens-delta-pip]")).toHaveCount(0);
    await flaggedTab.click();
    await expect(board).toHaveAttribute("data-lens", "flagged");
    await openBoardSections(page);
    const finding = board.locator('[data-kind="finding"]');
    await expect(finding).toHaveCount(1);

    if ((await finding.locator("button[aria-expanded]").getAttribute("aria-expanded")) === "false")
      await finding.locator("button[aria-expanded]").click();
    await finding.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(flaggedTab.locator("[data-testid=lens-open-count]")).toHaveCount(0);
    await expect(flaggedTab).toHaveAccessibleName(/^Flagged, 0 open(?:, changed this round)?$/);
    await expect
      .poll(() => Object.values(askLog.readProjection(fixture.reviewId).findingDispositions))
      .toContainEqual(expect.objectContaining({ disposition: "dismissed" }));
    await page.reload();
    await expect(board).toHaveAttribute("data-lens", "flagged", { timeout: 60_000 });
    await openBoardSections(page);
    await expect(finding).toHaveAttribute("data-status", "dismissed");
    if ((await finding.locator("button[aria-expanded]").getAttribute("aria-expanded")) === "false")
      await finding.locator("button[aria-expanded]").click();
    await finding.getByRole("button", { name: "Dismissed · Undo" }).click();
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");

    if ((await finding.locator("button[aria-expanded]").getAttribute("aria-expanded")) === "false")
      await finding.locator("button[aria-expanded]").click();
    await finding.getByRole("button", { name: "Request This Change" }).click();
    await expect(flaggedTab.locator("[data-testid=lens-open-count]")).toHaveCount(0);
    await expect(finding.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
    await expect
      .poll(() => Object.values(askLog.readProjection(fixture.reviewId).stagedAsks))
      .toContainEqual(
        expect.objectContaining({ body: "Return the reviewed value from the implementation." }),
      );
    await page.reload();
    await expect(board).toHaveAttribute("data-lens", "flagged", { timeout: 60_000 });
    await openBoardSections(page);
    if ((await finding.locator("button[aria-expanded]").getAttribute("aria-expanded")) === "false")
      await finding.locator("button[aria-expanded]").click();
    await finding.getByRole("button", { name: "Staged · Request Change" }).click();
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");
    try {
      await expect
        .poll(() => Object.keys(askLog.readProjection(fixture.reviewId).stagedAsks))
        .toEqual([]);
    } catch (error) {
      await test.info().attach("persisted-ask-events", {
        body: JSON.stringify(askLog.read(fixture.reviewId)),
        contentType: "application/json",
      });
      throw error;
    }
    await page.reload();
    await expect(board).toHaveAttribute("data-lens", "flagged", { timeout: 60_000 });
    await openBoardSections(page);
    if ((await finding.locator("button[aria-expanded]").getAttribute("aria-expanded")) === "false")
      await finding.locator("button[aria-expanded]").click();
    await expect(finding.getByRole("button", { name: "Request This Change" })).toBeVisible();
    await expect(flaggedTab).toHaveAccessibleName("Flagged, 1 open");

    if ((await finding.locator("button[aria-expanded]").getAttribute("aria-expanded")) === "false")
      await finding.locator("button[aria-expanded]").click();
    await finding.getByRole("button", { name: "Discuss", exact: true }).click();
    await expect(page.locator('[data-slot="chat-dock"]')).toHaveAttribute("data-open", "true");
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
    await expect
      .poll(() => Object.values(askLog.readProjection(fixture.reviewId).quoteThreads))
      .toContainEqual(
        expect.objectContaining({ anchor: "Return the reviewed value from the implementation." }),
      );

    const beforeDesign = await page.evaluate(() => history.length);
    await rail.getByRole("tab", { name: /^Design(?:,|$)/ }).click();
    expect(await page.evaluate(() => history.length)).toBe(beforeDesign);
    await expectQuery(page, { lens: "design" });
    await expect(board).toHaveAttribute("data-lens", "design");
    await expect(board.getByRole("heading", { name: "Design", level: 1 })).toBeVisible();
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

    const sequenceTab = rail.getByRole("tab", { name: /^Sequence(?:,|$)/ });
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
      .not.toBe("none");
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
    await openBoardSections(page);
    await revealCitation(page, "widget.ts:1");
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
    await expect(page.locator(`[id="diff-${BOARD_IMPLEMENTATION_PATH}"]`)).toBeInViewport();

    await rail.getByRole("tab", { name: "Sequence" }).click();
    await openBoardSections(page);
    await revealCitation(page, "widget.ts:1");
    const beforeCounterpart = await currentHash(page);
    await page.getByRole("button", { name: "View test", exact: true }).click();
    await expect(
      page
        .locator(`[data-evidence-path="${BOARD_TEST_PATH}"]`)
        .filter({ has: page.getByRole("button", { name: "Back to review", exact: true }) }),
    ).toContainText("import { widget }");
    expect(await currentHash(page)).toBe(beforeCounterpart);
    await page.getByRole("button", { name: "Back to review", exact: true }).click();
    await expect(page.locator(`[data-evidence-path="${BOARD_IMPLEMENTATION_PATH}"]`)).toBeVisible();
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("review activity and code evidence remain usable across navigation", async () => {
  test.setTimeout(240_000);
  const repository = seedReviewRepo("rennet-e2e-experience-");
  const context = Array.from(
    { length: 45 },
    (_, index) => `export const context${index} = ${index};`,
  ).join("\n");
  writeRepoFile(repository, BOARD_IMPLEMENTATION_PATH, `export const widget = 1;\n${context}\n`);
  writeRepoFile(
    repository,
    "checks/behaviour.test.ts",
    "import { widget } from '../src/widget';\nvoid widget;\n",
  );
  git(repository, "add", BOARD_IMPLEMENTATION_PATH, "checks/behaviour.test.ts");
  git(repository, "commit", "-qm", "capture unchanged context and a differently named test");
  git(repository, "branch", "-f", "main", "HEAD");
  writeRepoFile(repository, BOARD_IMPLEMENTATION_PATH, `export const widget = 2;\n${context}\n`);
  writeRepoFile(repository, BOARD_TEST_PATH, "import { widget } from './widget';\nvoid widget;\n");
  writeRepoFile(
    repository,
    BOARD_DESIGN_SPEC_PATH,
    "# Widget value specification\n\nThe widget SHALL expose the reviewed value.\n",
  );
  const userData = makeTempDir("rennet-e2e-experience-state-");
  const home = makeTempDir("rennet-e2e-experience-home-");
  const { application } = await launchRennet({ repository, userData, home });
  try {
    const page = await application.firstWindow();
    await completeWelcome(page);
    await addProject(page, repository);
    await openFixtureReview(page, repository, userData);
    const fixture = await seedBoardFixture(page, repository, userData);
    const sessions = new SessionStore(join(userData, "sessions"));
    sessions.rename(fixture.sessionId, "Review experience fixture");
    sessions.setPreparation(fixture.sessionId, {
      status: "drafting",
      reviewId: fixture.reviewId,
      lanes: [
        { id: "design", label: "Design", status: "done", verdict: "reworked" },
        {
          id: "sequence",
          label: "Sequence",
          status: "running",
          latest: {
            kind: "text",
            text: "Reading the implementation and its tests",
            at: Date.now(),
          },
        },
        { id: "decisions", label: "Decisions", status: "running" },
        { id: "flagged", label: "Flagged", status: "running" },
        { id: "noise", label: "Noise", status: "waiting" },
      ],
    });
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });
    const board = page.locator("article[data-lens]");
    const tabs = page.getByRole("tablist", { name: "Lens" });
    for (const name of ["Design", "Sequence", "Decisions", "Flagged", "Noise"]) {
      await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}(?:,|$)`) })).toContainText(
        name,
      );
    }
    const noise = tabs.getByRole("tab", { name: /Noise/ });
    await expect(noise).toHaveAttribute("aria-disabled", "true");
    await noise.focus();
    await expect(
      page.getByText("Noise reviews what remains once the other lenses have finished."),
    ).toBeVisible();
    const reviewing = page.getByRole("button", { name: "Reviewing the change", exact: true });
    await expect(reviewing).toBeDisabled();
    // The motion claim is the computed animation under each media preference below; the
    // arc's geometry is a visual choice, not a behaviour, and is not pinned here.
    const orbit = reviewing.locator("svg.animate-spin");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect
      .poll(() => orbit.evaluate((element) => getComputedStyle(element).animationName))
      .not.toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() => orbit.evaluate((element) => getComputedStyle(element).animationName))
      .toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).click();
    await expect(
      board.getByRole("heading", { level: 1, name: "Sequence", exact: true }),
    ).toBeVisible();
    const bullets = board.getByRole("list").filter({ hasText: "Existing callers" });
    await expect(bullets.getByRole("listitem")).toHaveCount(2);
    await expect(bullets).toHaveCSS("list-style-type", "disc");
    await expect(bullets).toHaveCSS("gap", "8px");
    await expect(page.getByRole("dialog", { name: "Sequence activity details" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /activity details$/ })).toHaveCount(1);
    await expect(
      page
        .getByRole("dialog", { name: "Sequence activity details" })
        .getByRole("button", { name: "Open transcript", exact: true }),
    ).toBeDisabled();
    for (const action of ["Checking callers", "Comparing tests", "Writing the reading sequence"]) {
      const preparation = sessions.load(fixture.sessionId)?.preparation;
      if (preparation?.status !== "drafting") throw new Error("fixture stopped drafting");
      sessions.setPreparation(fixture.sessionId, {
        ...preparation,
        lanes: preparation.lanes.map((lane) =>
          lane.id === "sequence"
            ? { ...lane, latest: { kind: "text", text: action, at: Date.now() } }
            : lane,
        ),
      });
      await expect(page.getByText(action, { exact: true })).toBeVisible();
    }
    const skipTips = page.getByRole("button", { name: "Skip all tips", exact: true });
    if (await skipTips.isVisible()) await skipTips.click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: test.info().outputPath("reviewing-dark.png") });
    const [activityBox, triggerBox] = await Promise.all([
      page.getByLabel("Sequence activity details", { exact: true }).boundingBox(),
      tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).boundingBox(),
    ]);
    if (!activityBox || !triggerBox) throw new Error("activity or trigger has no layout");
    expect(activityBox.y - (triggerBox.y + triggerBox.height)).toBeGreaterThanOrEqual(0);
    expect(activityBox.y - (triggerBox.y + triggerBox.height)).toBeLessThanOrEqual(16);
    await expect(tabs.getByRole("button")).toHaveCount(0);
    await tabs.getByRole("tab", { name: /^Decisions(?:,|$)/ }).hover();
    await expect(page.getByRole("dialog", { name: "Decisions activity details" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Sequence activity details" })).toBeHidden();
    await page.mouse.move(400, 500);
    await expect(page.getByRole("dialog", { name: "Sequence activity details" })).toBeVisible();
    await tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).hover();
    const preparation = sessions.load(fixture.sessionId)?.preparation;
    if (preparation?.status !== "drafting") throw new Error("fixture stopped drafting");
    sessions.setPreparation(fixture.sessionId, {
      ...preparation,
      lanes: preparation.lanes.map((lane) =>
        lane.id === "sequence"
          ? { id: "sequence", label: "Sequence", status: "done", verdict: "reworked" }
          : lane,
      ),
    });
    await expect(page.getByText("Review complete", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("activity-complete.png") });
    const completedActivity = page.getByRole("dialog", { name: "Sequence activity details" });
    await expect(completedActivity).not.toHaveAttribute("data-completing", "true");
    await expect(completedActivity).toHaveAttribute("data-open", "");
    await expect(completedActivity).toBeVisible();
    await page.mouse.move(400, 500);
    await expect(completedActivity).toBeHidden();
    await tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).hover();
    await expect(page.getByRole("dialog", { name: "Sequence activity details" })).toBeVisible();
    await page
      .getByRole("dialog", { name: "Sequence activity details" })
      .getByRole("button", { name: "Close activity" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Sequence activity details" })).toBeHidden();
    const sidebar = page.locator('[data-region="sidebar"]');
    const sessionRow = sidebar.getByRole("button", { name: /Review experience fixture/ });
    await expect(sessionRow.getByRole("status", { name: "Reviewing the change" })).toBeVisible();
    await sessionRow.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(sessionRow).toBeFocused();
    await expect(
      page.getByRole("tooltip", { name: "Reviewing the change", exact: true }),
    ).toBeVisible();
    await sidebar
      .getByRole("button", { name: "New Chat", exact: true })
      .and(sidebar.locator("button:not([aria-haspopup])"))
      .click();
    await expect(sessionRow.getByRole("status", { name: "Reviewing the change" })).toBeVisible();
    await sessionRow.click();
    await tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).click();
    await tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).hover();
    await expect(page.getByRole("dialog", { name: "Sequence activity details" })).toBeVisible();
    await expect(page.getByText("Writing the reading sequence", { exact: true })).toBeVisible();
    await page
      .getByRole("dialog", { name: "Sequence activity details" })
      .getByRole("button", { name: "Close activity" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Sequence activity details" })).toBeHidden();
    await sidebar
      .getByRole("button", { name: "New Chat", exact: true })
      .and(sidebar.locator("button:not([aria-haspopup])"))
      .click();
    sessions.setPreparation(fixture.sessionId, undefined);
    await expect(sessionRow.getByRole("status", { name: "Review ready" })).toBeVisible({
      timeout: 15_000,
    });
    await sessionRow.click();
    await expect(sessionRow.getByRole("status", { name: "Review ready" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await tabs.getByRole("tab", { name: /^Design(?:,|$)/ }).click();
    const section = board.locator('[data-kind="board-section"]').first();
    const toggle = section.getByRole("button", { name: "Toggle Widget value", exact: true });
    if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    await section
      .getByRole("button", { name: "Expose the reviewed widget value", exact: true })
      .click();
    await expect(
      section.getByRole("heading", { name: "Expose the reviewed widget value", exact: true }),
    ).toBeVisible();
    await tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).click();
    await openBoardSections(page);
    await revealCitation(page, "widget.ts:1");
    const evidence = page.locator(`[data-evidence-path="${BOARD_IMPLEMENTATION_PATH}"]`);
    await expect(evidence.locator('[data-diff-kind="del"]')).toContainText(
      "export const widget = 1;",
    );
    await expect(evidence.locator('[data-diff-kind="add"]')).toContainText(
      "export const widget = 2;",
    );
    await expect(evidence.locator('[data-line-state="cited"]')).toHaveCount(0);
    writeRepoFile(repository, BOARD_IMPLEMENTATION_PATH, "export const widget = 999;\n");
    await evidence.getByRole("button", { name: "Full file", exact: true }).click();
    await expect(evidence).toContainText("export const widget = 2;");
    await expect(evidence).not.toContainText("widget = 999");
    const codeScroller = evidence.locator("[data-code-scroll]");
    await expect
      .poll(() => codeScroller.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await codeScroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(evidence).toContainText("context44");
    await evidence.locator("summary", { hasText: "View tests" }).click();
    await evidence.getByRole("button", { name: "checks/behaviour.test.ts", exact: true }).click();
    const testEvidence = page.locator('[data-evidence-path="checks/behaviour.test.ts"]');
    await expect(testEvidence).toContainText("import { widget }");
    await testEvidence.getByRole("button", { name: "Back to review", exact: true }).click();
    await expect(evidence).toContainText("context44");
    await codeScroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await evidence.locator('[data-code-side="base"][data-code-line="1"]').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Request Changes", exact: true }).click();
    const request = page.getByPlaceholder("What change are you requesting?");
    await request.fill("Keep the old value until its callers are migrated.");
    await request.press("Meta+Enter");
    const asks = new AskLogStore(join(userData, "asks"));
    await expect
      .poll(() => Object.values(asks.readProjection(fixture.reviewId).stagedAsks))
      .toContainEqual(
        expect.objectContaining({
          body: "Keep the old value until its callers are migrated.",
          codeRef: {
            patchsetId: fixture.patchsetId,
            path: BOARD_IMPLEMENTATION_PATH,
            side: "base",
            startLine: 1,
            endLine: 1,
          },
        }),
      );
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 900, height: 800 });
    const narrowHeader = page.locator('[data-slot="session-top-bar"]');
    await expect
      .poll(async () => {
        const [header, rail, controls] = await Promise.all([
          narrowHeader.boundingBox(),
          narrowHeader.locator('[data-slot="lens-switcher"]').boundingBox(),
          narrowHeader.getByRole("group", { name: "Session view" }).boundingBox(),
        ]);
        return (
          header !== null &&
          rail !== null &&
          controls !== null &&
          rail.y >= controls.y + controls.height - 1 &&
          rail.width >= header.width - 25
        );
      })
      .toBe(true);
    for (const name of ["Design", "Sequence", "Decisions", "Flagged", "Noise"]) {
      await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}(?:,|$)`) })).toContainText(
        name,
      );
    }
    if (await skipTips.isVisible()) await skipTips.click();
    await page.screenshot({ path: test.info().outputPath("narrow-rail.png") });
    for (const name of ["Design", "Sequence", "Decisions", "Flagged", "Noise"]) {
      const tab = tabs.getByRole("tab", { name: new RegExp(`^${name}(?:,|$)`) });
      await tab.focus();
      await expect(tab).toBeInViewport({ ratio: 1 });
    }
    await tabs.getByRole("tab", { name: /^Sequence(?:,|$)/ }).focus();
    await page.screenshot({ path: test.info().outputPath("evidence-light.png") });
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
