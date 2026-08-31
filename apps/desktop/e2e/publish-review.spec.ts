import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import type { CommandOutput } from "@rennet/protocol";
import { BOARD_DESIGN_SCENARIO, seedBoardFixture } from "./board-fixture";
import { completeWelcome, launchRennet, makeTempDir } from "./harness";
import {
  type CapturedPublishReview,
  captureTeammateReview,
  createPublishProofRepository,
  LOCAL_FORGE_FIXTURE_MARKER,
  LocalForgeRecorder,
  type PublishProofRepository,
  type RunningPublishProofDaemon,
  startPublishProofDaemon,
  waitForCapturedReview,
} from "./publish-proof-fixture";

type ReviewComposition = Extract<CommandOutput<"publish.compose">, { status: "review" }>;
type Verdict = ReviewComposition["post"]["event"];

interface Scenario {
  readonly repository: PublishProofRepository;
  readonly verdict: Verdict;
  captured?: CapturedPublishReview;
  composition?: ReviewComposition;
}

async function connect(page: Page): Promise<WsRennetBridge> {
  const port = await page.evaluate(
    () => (window as unknown as { rennet: { wsPort: number } }).rennet.wsPort,
  );
  return new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
}

async function composeReview(page: Page, reviewId: string): Promise<ReviewComposition> {
  const bridge = await connect(page);
  try {
    const composed = await bridge.invoke("publish.compose", {
      commandId: randomUUID(),
      reviewId,
      mode: "review",
    });
    if (composed.status !== "review") {
      const reason = composed.status === "unavailable" ? composed.reason : "composed as a PR";
      throw new Error(`review ${reviewId} did not compose: ${reason}`);
    }
    return composed;
  } finally {
    bridge.close();
  }
}

async function publicationReceipt(
  page: Page,
  reviewId: string,
  marker: string,
): Promise<CommandOutput<"publish.receipt">> {
  const bridge = await connect(page);
  try {
    return await bridge.invoke("publish.receipt", { reviewId, marker });
  } finally {
    bridge.close();
  }
}

async function openSession(page: Page, captured: CapturedPublishReview): Promise<void> {
  await page.evaluate((sessionId) => {
    location.hash = `#/s/${encodeURIComponent(sessionId)}`;
  }, captured.sessionId);
  await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
}

async function stageSourceBackedReview(
  page: Page,
  captured: CapturedPublishReview,
  dataDir: string,
): Promise<void> {
  await openSession(page, captured);
  await seedBoardFixture(page, captured.repository.repository, dataDir);
  await page.reload();

  const board = page.locator("article[data-lens]");
  await expect(board).toBeVisible({ timeout: 60_000 });
  const rail = page.locator('[data-slot="lens-switcher"] [role="tablist"]');
  expect(
    await rail.locator("[data-lens]").evaluateAll((tabs) => tabs.map((tab) => tab.dataset.lens)),
  ).toEqual(["design", "sequence", "decisions", "flagged", "noise"]);

  const lensEvidence = {
    design: "Widget value specification",
    sequence: "Live sequence",
    decisions: "decisions evidence for",
    flagged: "The widget can return the stale value.",
    noise: "noise evidence for",
  } as const;
  for (const lens of ["design", "sequence", "decisions", "flagged", "noise"] as const) {
    await rail.locator(`[data-lens="${lens}"]`).click();
    await expect(board).toHaveAttribute("data-lens", lens);
    await expect(board).toContainText(lensEvidence[lens]);
  }

  await rail.locator('[data-lens="flagged"]').click();
  await expect(board).toHaveAttribute("data-lens", "flagged");
  const finding = board.locator('[data-kind="finding"]');
  await expect(finding).toHaveCount(1);
  await finding.getByRole("button", { name: "Request This Change", exact: true }).click();

  await rail.locator('[data-lens="design"]').click();
  await expect(board).toHaveAttribute("data-lens", "design");
  const scenario = board.getByText(BOARD_DESIGN_SCENARIO, { exact: true }).first();
  await expect(scenario).toBeVisible();
  await scenario.evaluate((node) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Request Changes", exact: true }).click();
  const body = `Explain the source-backed ${captured.repository.provider} review for ${captured.repository.number}.`;
  await page.getByPlaceholder("What change are you requesting?").fill(body);
  await page.getByRole("button", { name: "Stage", exact: true }).click();

  await page.getByRole("button", { name: "Write Review, 2 staged", exact: true }).click();
  const destination = `${captured.repository.forgeRepository.owner}/${captured.repository.forgeRepository.name}#${captured.repository.number}`;
  await expect(page.getByRole("heading", { name: `Post Review · ${destination}` })).toBeVisible({
    timeout: 60_000,
  });
}

async function selectVerdict(page: Page, verdict: Verdict): Promise<ReviewComposition> {
  const labels: Record<Verdict, string> = {
    APPROVE: "Approve",
    REQUEST_CHANGES: "Request Changes",
    COMMENT: "Comment",
  };
  const reviewId = await reviewIdFromRoute(page);
  const control = page.getByRole("group", { name: "Review verdict" });
  const choice = control.getByRole("button", { name: labels[verdict], exact: true });
  if ((await choice.getAttribute("aria-pressed")) !== "true") await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await composeReview(page, reviewId)).post.event).toBe(verdict);
  return composeReview(page, reviewId);
}

async function reviewIdFromRoute(page: Page): Promise<string> {
  const bridge = await connect(page);
  try {
    const sessionId = await sessionIdFromRoute(page);
    const session = (await bridge.invoke("session.list", {})).sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (session?.reviewId === undefined) throw new Error(`session ${sessionId} has no review`);
    return session.reviewId;
  } finally {
    bridge.close();
  }
}

async function sessionIdFromRoute(page: Page): Promise<string> {
  const hash = await page.evaluate(() => location.hash);
  const encodedSessionId = /^#\/s\/([^?]+)/.exec(hash)?.[1];
  if (encodedSessionId === undefined) throw new Error(`expected a session route, got ${hash}`);
  return decodeURIComponent(encodedSessionId);
}

async function assertVisiblePreview(page: Page, composition: ReviewComposition): Promise<void> {
  await expect(page.getByText("Review Body", { exact: true })).toBeVisible();
  await expect(page.getByText(composition.artifact.opener, { exact: true })).toBeVisible();
  for (const note of composition.artifact.bodyNotes) {
    await expect(page.getByText(note.body, { exact: true }).first()).toBeVisible();
  }
  if (composition.post.threads.length > 0) {
    await expect(
      page.getByText(`Review Threads · ${composition.post.threads.length}`, { exact: true }),
    ).toBeVisible();
    for (const thread of composition.post.threads) {
      await expect(page.getByText(thread.body.replaceAll("**", ""), { exact: true })).toBeVisible();
    }
  } else {
    await expect(page.getByText(/^Review Threads ·/)).toHaveCount(0);
  }
}

function expectedGitHubInput(
  captured: CapturedPublishReview,
  composition: ReviewComposition,
): LocalForgeRecorder["githubPublications"][number]["input"] {
  const target = captured.review.postTarget;
  if (target === undefined) throw new Error("captured review has no post target");
  return {
    pullRequestId: target.forgeRef,
    commitOID: target.headOid,
    event: composition.post.event,
    body: composition.post.body,
    threads: composition.post.threads.map((thread) => ({
      path: thread.path,
      line: thread.line,
      ...(thread.startLine === undefined
        ? {}
        : { startLine: thread.startLine, startSide: thread.side }),
      side: thread.side,
      body: thread.body,
    })),
  };
}

function assertExactProviderPublication(
  recorder: LocalForgeRecorder,
  captured: CapturedPublishReview,
  composition: ReviewComposition,
): void {
  const { provider, number } = captured.repository;
  expect(
    recorder.openerDrafts.some(
      (draft) =>
        draft.reviewId === captured.review.id &&
        draft.provider === provider &&
        draft.verdict === composition.post.event &&
        JSON.stringify(draft.lenses) ===
          JSON.stringify(["design", "sequence", "decisions", "flagged", "noise"]),
    ),
  ).toBe(true);
  if (provider === "github") {
    const publications = recorder.githubPublications.filter((entry) => entry.number === number);
    expect(publications).toHaveLength(1);
    expect(publications[0]?.input).toEqual(expectedGitHubInput(captured, composition));
    expect(recorder.gitLabNotes.some((entry) => entry.number === number)).toBe(false);
    return;
  }

  const notes = recorder.gitLabNotes.filter((entry) => entry.number === number);
  expect(notes).toEqual([{ number, body: composition.post.body }]);
  expect(recorder.githubPublications.some((entry) => entry.number === number)).toBe(false);
  const approvals = recorder.gitLabApprovals.filter((entry) => entry.number === number);
  if (composition.post.event === "APPROVE") {
    const target = captured.review.postTarget;
    if (target === undefined) throw new Error("captured review has no post target");
    expect(approvals).toEqual([{ number, sha: target.headOid }]);
  } else {
    expect(approvals).toEqual([]);
  }
}

async function postOnceAndExpectReceipt(
  page: Page,
  captured: CapturedPublishReview,
): Promise<void> {
  await page.getByRole("button", { name: "Post Review", exact: true }).click();
  const destination = `${captured.repository.forgeRepository.owner}/${captured.repository.forgeRepository.name}#${captured.repository.number}`;
  await expect(page.getByText(`Review posted to ${destination}`, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function assertByteDriftRefused(
  page: Page,
  recorder: LocalForgeRecorder,
  captured: CapturedPublishReview,
  composition: ReviewComposition,
): Promise<void> {
  const bridge = await connect(page);
  try {
    await expect(
      bridge.invoke("publish.review", {
        commandId: randomUUID(),
        reviewId: captured.review.id,
        artifact: composition.artifact,
        post: { ...composition.post, body: `${composition.post.body}\nTAMPERED_AFTER_PREVIEW` },
        payload: composition.payload,
        compositionId: composition.compositionId,
        dryRun: false,
      }),
    ).rejects.toThrow(/preview|match|changed/i);
  } finally {
    bridge.close();
  }
  expect(
    recorder.publicationMutationCount(captured.repository.provider, captured.repository.number),
  ).toBe(0);
  expect(recorder.acceptedCount(captured.repository.provider, captured.repository.number)).toBe(0);
}

async function runOrdinaryPublication(
  page: Page,
  recorder: LocalForgeRecorder,
  scenario: Scenario,
  dataDir: string,
): Promise<void> {
  const captured = scenario.captured;
  if (captured === undefined) throw new Error("scenario has no captured review");
  await stageSourceBackedReview(page, captured, dataDir);
  const composition = await selectVerdict(page, scenario.verdict);
  scenario.composition = composition;
  await assertVisiblePreview(page, composition);
  await assertByteDriftRefused(page, recorder, captured, composition);

  const githubBefore = recorder.githubPublications.length;
  const gitLabBefore = recorder.gitLabNotes.length;
  recorder.delayNextPublication(captured.repository.provider, captured.repository.number, 150);
  const post = page.getByRole("button", { name: "Post Review", exact: true });
  await post.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  const destination = `${captured.repository.forgeRepository.owner}/${captured.repository.forgeRepository.name}#${captured.repository.number}`;
  await expect(page.getByText(`Review posted to ${destination}`, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(recorder.githubPublications.length - githubBefore).toBe(
    captured.repository.provider === "github" ? 1 : 0,
  );
  expect(recorder.gitLabNotes.length - gitLabBefore).toBe(
    captured.repository.provider === "gitlab" ? 1 : 0,
  );
  expect(
    recorder.publicationMutationCount(captured.repository.provider, captured.repository.number),
  ).toBe(1);
  expect(recorder.acceptedCount(captured.repository.provider, captured.repository.number)).toBe(1);
  assertExactProviderPublication(recorder, captured, composition);
}

async function runMovedHeadPublication(
  page: Page,
  daemon: RunningPublishProofDaemon,
  recorder: LocalForgeRecorder,
  scenario: Scenario,
  dataDir: string,
): Promise<CapturedPublishReview> {
  const original = scenario.captured;
  if (original === undefined) throw new Error("scenario has no captured review");
  await stageSourceBackedReview(page, original, dataDir);
  const oldComposition = await selectVerdict(page, scenario.verdict);
  await assertVisiblePreview(page, oldComposition);
  recorder.advanceHead(original.repository.provider, original.repository.number);

  await page.getByRole("button", { name: "Post Review", exact: true }).click();
  const providerNoun = original.repository.provider === "github" ? "pull-request" : "merge-request";
  const refusal = page.getByRole("alert");
  await expect(refusal).toContainText(`Publish refused: the ${providerNoun} head moved from`);
  await expect(refusal).toContainText(original.repository.oldHeadOid);
  await expect(refusal).toContainText(original.repository.newHeadOid);
  await expect(page.getByRole("button", { name: "Post Review", exact: true })).toBeEnabled();
  const reviewLatest = page.getByRole("button", { name: "Review latest revision", exact: true });
  await expect(reviewLatest).toBeVisible();
  expect(
    recorder.publicationMutationCount(original.repository.provider, original.repository.number),
  ).toBe(0);
  expect(recorder.acceptedCount(original.repository.provider, original.repository.number)).toBe(0);
  if (oldComposition.marker === undefined) throw new Error("composition marker is missing");
  expect(await publicationReceipt(page, original.review.id, oldComposition.marker)).toEqual({
    status: "missing",
  });
  expect(await composeReview(page, original.review.id)).toEqual(oldComposition);

  await reviewLatest.click();
  await expect(page.locator('[data-screen="session-preparation"]')).toBeVisible({ timeout: 5_000 });
  const recapturedSessionId = await sessionIdFromRoute(page);
  expect(recapturedSessionId).not.toBe(original.sessionId);
  const recaptured = await waitForCapturedReview(
    daemon,
    dataDir,
    original.repository,
    recapturedSessionId,
  );
  expect(recaptured.review.id).not.toBe(original.review.id);
  expect(recaptured.review.activePatchsetId).not.toBe(original.review.activePatchsetId);
  expect(recaptured.review.postTarget).toEqual({
    ...original.review.postTarget,
    headOid: original.repository.newHeadOid,
  });

  const bridge = await connect(page);
  try {
    const sessions = (await bridge.invoke("session.list", {})).sessions;
    expect(sessions.find((session) => session.id === original.sessionId)?.archived).toBe(true);
    expect(sessions.find((session) => session.id === recaptured.sessionId)).toMatchObject({
      projectId: original.repository.projectId,
      claim: { branch: original.repository.headRef, prNumber: original.repository.number },
      repository: `${original.repository.forgeRepository.owner}/${original.repository.forgeRepository.name}`,
      forgeRepository: original.repository.forgeRepository,
      reviewId: recaptured.review.id,
    });
    const persistedOriginal = await bridge.invoke("review.load", {
      commandId: randomUUID(),
      reviewId: original.review.id,
    });
    expect(persistedOriginal.review.postTarget).toEqual(original.review.postTarget);
  } finally {
    bridge.close();
  }
  expect(await composeReview(page, original.review.id)).toEqual(oldComposition);
  expect(await publicationReceipt(page, original.review.id, oldComposition.marker)).toEqual({
    status: "missing",
  });

  await page.reload();
  await stageSourceBackedReview(page, recaptured, dataDir);
  const newComposition = await selectVerdict(page, scenario.verdict);
  await assertVisiblePreview(page, newComposition);
  expect(newComposition.compositionId).not.toBe(oldComposition.compositionId);
  expect(newComposition.payload).not.toBe(oldComposition.payload);
  expect(newComposition.post.body).not.toBe(oldComposition.post.body);
  await postOnceAndExpectReceipt(page, recaptured);
  expect(
    recorder.publicationMutationCount(recaptured.repository.provider, recaptured.repository.number),
  ).toBe(1);
  expect(recorder.acceptedCount(recaptured.repository.provider, recaptured.repository.number)).toBe(
    1,
  );
  assertExactProviderPublication(recorder, recaptured, newComposition);
  scenario.captured = recaptured;
  scenario.composition = newComposition;
  return recaptured;
}

async function runRetryPublication(
  page: Page,
  recorder: LocalForgeRecorder,
  scenario: Scenario,
  dataDir: string,
): Promise<void> {
  const captured = scenario.captured;
  if (captured === undefined) throw new Error("scenario has no captured review");
  await stageSourceBackedReview(page, captured, dataDir);
  const composition = await selectVerdict(page, scenario.verdict);
  scenario.composition = composition;
  await assertVisiblePreview(page, composition);

  const localFailure = `controlled ${captured.repository.provider} local forge failure`;
  recorder.failNextRead(captured.repository.provider, captured.repository.number, localFailure);
  await page.getByRole("button", { name: "Post Review", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(localFailure);
  await expect(
    page.getByRole("button", { name: "Review latest revision", exact: true }),
  ).toHaveCount(0);
  expect(
    recorder.publicationMutationCount(captured.repository.provider, captured.repository.number),
  ).toBe(0);
  expect(recorder.acceptedCount(captured.repository.provider, captured.repository.number)).toBe(0);

  recorder.loseNextPublicationResponse(captured.repository.provider, captured.repository.number);
  await page.getByRole("button", { name: "Post Review", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    captured.repository.provider === "github"
      ? "controlled GitHub response loss after acceptance"
      : "GitLab is unreachable right now. Check the selected host and try again.",
  );
  expect(
    recorder.publicationMutationCount(captured.repository.provider, captured.repository.number),
  ).toBe(1);
  expect(recorder.acceptedCount(captured.repository.provider, captured.repository.number)).toBe(1);

  await postOnceAndExpectReceipt(page, captured);
  expect(
    recorder.publicationMutationCount(captured.repository.provider, captured.repository.number),
  ).toBe(1);
  expect(recorder.acceptedCount(captured.repository.provider, captured.repository.number)).toBe(1);
  assertExactProviderPublication(recorder, captured, composition);
}

function productionBundleText(): string {
  const roots = ["main", "preload", "renderer", "browser", "server"].map((directory) =>
    resolve("apps/desktop/dist", directory),
  );
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) visit(child);
      else if ([".cjs", ".css", ".html", ".js", ".json"].includes(extname(child))) {
        files.push(child);
      }
    }
  };
  for (const root of roots) visit(root);
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

test("launched GitHub and GitLab reviews preserve exact bytes, identity, retry, and receipts", async () => {
  test.setTimeout(900_000);
  const dataDir = makeTempDir("rennet-e2e-publish-proof-state-");
  const home = makeTempDir("rennet-e2e-publish-proof-home-");
  const recorder = new LocalForgeRecorder();
  const scenarios: Scenario[] = [];
  for (const provider of ["github", "gitlab"] as const) {
    const first = provider === "github" ? 101 : 201;
    for (const [offset, verdict] of [
      [0, "APPROVE"],
      [1, "REQUEST_CHANGES"],
      [2, "COMMENT"],
    ] as const) {
      scenarios.push({
        repository: createPublishProofRepository(dataDir, recorder, provider, first + offset),
        verdict,
      });
    }
  }

  let daemon = await startPublishProofDaemon(dataDir, home, recorder);
  let application: ElectronApplication | undefined;
  try {
    for (const scenario of scenarios) {
      scenario.captured = await captureTeammateReview(daemon, dataDir, scenario.repository);
      expect(scenario.captured.review.postTarget).toMatchObject({
        repo: scenario.repository.forgeRepository,
        number: scenario.repository.number,
        headOid: scenario.repository.oldHeadOid,
        viewerDidAuthor: false,
      });
    }

    ({ application } = await launchRennet({
      repository: scenarios[0]?.repository.repository ?? "",
      userData: dataDir,
      home,
      ownsDaemon: false,
    }));
    let page = await application.firstWindow();
    await completeWelcome(page);

    for (const provider of ["github", "gitlab"] as const) {
      const providerScenarios = scenarios.filter(
        (scenario) => scenario.repository.provider === provider,
      );
      const approve = providerScenarios.find((scenario) => scenario.verdict === "APPROVE");
      const moved = providerScenarios.find((scenario) => scenario.verdict === "REQUEST_CHANGES");
      const retry = providerScenarios.find((scenario) => scenario.verdict === "COMMENT");
      if (approve === undefined || moved === undefined || retry === undefined) {
        throw new Error(`incomplete ${provider} proof matrix`);
      }
      await runOrdinaryPublication(page, recorder, approve, dataDir);
      await runMovedHeadPublication(page, daemon, recorder, moved, dataDir);
      await runRetryPublication(page, recorder, retry, dataDir);
    }

    await application.close();
    application = undefined;
    daemon.stop();
    daemon = await startPublishProofDaemon(dataDir, home, recorder);
    ({ application } = await launchRennet({
      repository: scenarios[0]?.repository.repository ?? "",
      userData: dataDir,
      home,
      ownsDaemon: false,
    }));
    page = await application.firstWindow();

    for (const scenario of scenarios) {
      const captured = scenario.captured;
      const composition = scenario.composition;
      if (captured === undefined || composition?.marker === undefined) {
        throw new Error("published scenario is incomplete");
      }
      await openSession(page, captured);
      await page.getByRole("button", { name: /^Write Review(?:, \d+ staged)?$/ }).click();
      const destination = `${captured.repository.forgeRepository.owner}/${captured.repository.forgeRepository.name}#${captured.repository.number}`;
      await expect(page.getByText(`Review posted to ${destination}`, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole("button", { name: "Post Review", exact: true })).toHaveCount(0);
      expect(await publicationReceipt(page, captured.review.id, composition.marker)).toMatchObject({
        status: "posted",
        receipt: {
          marker: composition.marker,
          verdict: scenario.verdict,
          lineCommentCount: composition.post.threads.length,
        },
      });
      expect(
        recorder.publicationMutationCount(scenario.repository.provider, scenario.repository.number),
      ).toBe(1);
      expect(recorder.acceptedCount(scenario.repository.provider, scenario.repository.number)).toBe(
        1,
      );
    }

    const fixtureSource = readFileSync(
      resolve("apps/desktop/e2e/publish-proof-fixture.ts"),
      "utf8",
    );
    expect(fixtureSource).toContain(LOCAL_FORGE_FIXTURE_MARKER);
    expect(productionBundleText()).not.toContain(LOCAL_FORGE_FIXTURE_MARKER);
  } finally {
    await application?.close();
    daemon.stop();
    for (const scenario of scenarios) {
      rmSync(scenario.repository.repository, { recursive: true, force: true });
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
