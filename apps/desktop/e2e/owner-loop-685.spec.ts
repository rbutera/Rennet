import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { generationIdForPatchset, LENS_KINDS } from "@rennet/protocol";
import {
  OWNER_LOOP_ROUND_ONE_BODY,
  OWNER_LOOP_ROUND_TWO_BODY,
  OWNER_LOOP_SEQUENCE_QUOTE,
  OWNER_LOOP_SOURCE,
  writeOwnerLoopScriptedHarnessPlan,
} from "@rennet/server/testing";
import {
  completeWelcome,
  git,
  initRepo,
  launchRennet,
  makeTempDir,
  modelFreeEnv,
  writeRepoFile,
} from "./harness";

function seedRepo(root: string, name: "target" | "decoy"): void {
  mkdirSync(root, { recursive: true });
  initRepo(root);
  writeRepoFile(root, ".gitignore", ".rennet/\n");
  writeRepoFile(
    root,
    OWNER_LOOP_SOURCE,
    `export const ownerValue = '${name === "target" ? "base" : "decoy-base"}';\n`,
  );
  if (name === "target") {
    writeRepoFile(
      root,
      "package.json",
      `${JSON.stringify({
        private: true,
        scripts: {
          check:
            "node --eval \"const text = require('node:fs').readFileSync('src/owner.ts', 'utf8'); if (!text.includes('round-')) process.exit(1)\"",
        },
      })}\n`,
    );
    writeRepoFile(
      root,
      "openspec/changes/owner-loop/specs/owner/spec.md",
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Keep the owner-loop value source-backed",
        "The system SHALL keep the owner-loop value source-backed.",
        "",
        "#### Scenario: Review the owner loop",
        "WHEN the owner loop is reviewed",
        "THEN the current value remains source-backed.",
        "",
        `Implementation: \`${OWNER_LOOP_SOURCE}\``,
        "",
      ].join("\n"),
    );
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", `${name}: base`);
  git(root, "remote", "add", "origin", `git@github.com:owner/${name}.git`);
  git(root, "checkout", "-qb", "feature/shared");
  writeRepoFile(
    root,
    OWNER_LOOP_SOURCE,
    `export const ownerValue = '${name === "target" ? "reviewed" : "decoy-reviewed"}';\n`,
  );
  git(root, "add", OWNER_LOOP_SOURCE);
  git(root, "commit", "-qm", `${name}: reviewed value`);
  git(root, "checkout", "-q", "main");
}

function seedWorkspace(): { workspace: string; target: string; decoy: string } {
  const workspace = realpathSync(makeTempDir("rennet-e2e-685-workspace-"));
  const target = join(workspace, "target");
  const decoy = join(workspace, "decoy");
  seedRepo(target, "target");
  seedRepo(decoy, "decoy");
  return { workspace, target, decoy };
}

function gateCapableEnv(home: string): NodeJS.ProcessEnv {
  const environment = modelFreeEnv(home);
  const nodeBin = dirname(process.execPath);
  const npm = join(nodeBin, process.platform === "win32" ? "npm.cmd" : "npm");
  if (!existsSync(npm)) throw new Error(`npm is missing beside the test Node binary: ${npm}`);
  return {
    ...environment,
    PATH: [nodeBin, environment.PATH].filter(Boolean).join(delimiter),
  };
}

async function startTestDaemon(options: {
  userData: string;
  home: string;
  planPath: string;
}): Promise<ChildProcess> {
  const desktopPackage: unknown = JSON.parse(
    readFileSync(resolve("apps/desktop/package.json"), "utf8"),
  );
  if (
    typeof desktopPackage !== "object" ||
    desktopPackage === null ||
    !("version" in desktopPackage) ||
    typeof desktopPackage.version !== "string"
  ) {
    throw new Error("apps/desktop/package.json has no version");
  }
  const bundleRoot = makeTempDir("rennet-e2e-685-daemon-");
  const bundlePath = join(bundleRoot, "owner-loop-685-daemon.cjs");
  execFileSync(resolve("node_modules/esbuild/bin/esbuild"), [
    resolve("apps/desktop/e2e/owner-loop-685-daemon.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node24",
    "--external:electron",
    "--external:@anthropic-ai/claude-agent-sdk",
    "--define:import.meta.url=__rennetBundledImportMetaUrl",
    '--banner:js=const __rennetBundledImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    `--outfile=${bundlePath}`,
    "--log-level=warning",
  ]);
  cpSync(resolve("packages/prompts/src/prompts"), join(bundleRoot, "prompts"), {
    recursive: true,
  });
  cpSync(resolve("packages/server/dist/native"), join(bundleRoot, "native"), {
    recursive: true,
  });
  const child = fork(bundlePath, [], {
    cwd: resolve("."),
    env: {
      ...gateCapableEnv(options.home),
      RENNET_USER_DATA: options.userData,
      RENNET_OWNER_LOOP_PLAN: options.planPath,
      RENNET_SERVER_VERSION: desktopPackage.version,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    child.once("message", resolveReady);
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`test daemon exited ${code}: ${stderr}`)));
  });
  child.once("exit", () => rmSync(bundleRoot, { recursive: true, force: true }));
  return child;
}

async function bridgeFor(page: Page): Promise<WsRennetBridge> {
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  return new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
}

function assertProductionBundleBoundary(): void {
  const markers = [
    "scripted-harness",
    "owner-loop-685",
    "RENNET_OWNER_LOOP_PLAN",
    "685-scripted-v1",
  ];
  for (const path of [
    resolve("packages/server/dist/rennet.cjs"),
    resolve("apps/desktop/dist/server/index.cjs"),
  ]) {
    const productionBundle = readFileSync(path, "utf8");
    for (const marker of markers) expect(productionBundle).not.toContain(marker);
  }
}

async function expectFiveSourceBackedBoards(
  page: Page,
  bridge: WsRennetBridge,
  reviewId: string,
  generation: string,
  patchsetId: string,
): Promise<void> {
  for (const lens of LENS_KINDS) {
    const tab = page.locator(`[data-kind="lens-switcher"] [data-lens="${lens}"]`);
    await expect(tab).toBeVisible();
    await tab.click();
    const board = page.locator(`article[data-lens="${lens}"]`);
    await expect(board).toBeVisible({ timeout: 30_000 });
    const read = await bridge.invoke("board.read", { reviewId, generation, lens });
    expect(read.failure).toBeUndefined();
    expect(read.absence).toBeUndefined();
    expect(read.board?.generation).toBe(generation);
    expect(read.board?.elements.length).toBeGreaterThan(0);
    await expect(board).toContainText(read.board?.document.title ?? "missing board title");
    await expect(board.locator(`[title*="${OWNER_LOOP_SOURCE}"]`).first()).toBeVisible();
    const refs = read.board?.elements.filter((element) => element.kind === "code_ref") ?? [];
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((element) => element.data.path === OWNER_LOOP_SOURCE)).toBe(true);
    expect(refs.some((element) => element.data.patchset_id === patchsetId)).toBe(true);
  }
}

async function stageAskFromSequenceBoard(
  page: Page,
  bridge: WsRennetBridge,
  sessionId: string,
  body: string,
): Promise<string> {
  const before = await bridge.invoke("ask.read", { sessionId });
  const stagedBefore = new Set(Object.keys(before.projection.stagedAsks));
  await page.locator('[data-kind="lens-switcher"] [data-lens="sequence"]').click();
  const quote = page.getByText(OWNER_LOOP_SEQUENCE_QUOTE, { exact: true }).first();
  await expect(quote).toBeVisible();
  await quote.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Request Changes", exact: true }).click();
  await page.getByPlaceholder("What change are you requesting?").fill(body);
  await page.getByRole("button", { name: "Stage", exact: true }).click();
  const after = await bridge.invoke("ask.read", { sessionId });
  const stagedIds = Object.keys(after.projection.stagedAsks).filter((id) => !stagedBefore.has(id));
  expect(stagedIds).toHaveLength(1);
  const id = stagedIds[0];
  if (id === undefined) throw new Error("board request-change did not mint an ask");
  expect(after.projection.stagedAsks[id]).toMatchObject({
    id,
    anchor: OWNER_LOOP_SEQUENCE_QUOTE,
    type: "request-change",
    body,
    threadId: id,
  });
  expect(after.projection.quoteThreads[id]).toMatchObject({
    anchor: OWNER_LOOP_SEQUENCE_QUOTE,
    target: "sequence-step",
    lifecycle: "attached",
  });
  return id;
}

async function dispatchVisibleRound(
  page: Page,
  askBody: string,
  expectedExitCount: number,
  expectedHarness: string,
): Promise<void> {
  await page
    .getByRole("button", { name: `Continue, ${expectedExitCount} staged`, exact: true })
    .click();
  await page.getByRole("button", { name: "Dispatch Round" }).click();
  await expect(page.locator('[data-screen="session-run"]')).toBeVisible({ timeout: 30_000 });
  const greeting = page.locator('[data-screen="round-greeting"]');
  await expect(greeting).toBeVisible({ timeout: 180_000 });
  // #681 acceptance: the DISPLAYED provenance names the harness that actually ran, with
  // its live version. The Codex journey asserts the same locator says "Codex", so a
  // hardcoded provider or an assumed default fails one of the two legs.
  await expect(greeting.getByTestId("round-run-receipt")).toContainText(
    `using ${expectedHarness} 685-scripted-v1`,
  );
  await expect(greeting.getByTestId("round-run-receipt")).toContainText("Passed npm run check");
  await expect(greeting.locator('[data-kind="round-report"]')).toBeVisible();
  const outcome = greeting.locator('[data-kind="round_outcome"]');
  await expect(outcome).toHaveCount(1);
  await expect(outcome).toContainText(askBody);
  await expect(outcome).toHaveAttribute("data-status", "addressed");
  await greeting.getByRole("button", { name: "View the New Boards" }).click();
  await expect(page.locator("article[data-lens]")).toBeVisible({ timeout: 30_000 });
}

/**
 * The launched owner loop on ONE resolved harness. Parameterized for #681/C14 D3: the
 * scripted plan declares the provider, the composition root routes the test port by its
 * descriptor, and the OTHER provider is genuinely absent — so the Codex journey proves a
 * Codex-resolved host end to end (round one, restart, round two) rather than a Claude
 * round wearing a Codex label. `expectedHarness` is the displayed name in the receipt.
 */
async function runLaunchedOwnerLoop(
  harness: "claude-code" | "codex",
  expectedHarness: "Claude Code" | "Codex",
): Promise<void> {
  test.setTimeout(600_000);
  assertProductionBundleBoundary();
  const { workspace, target, decoy } = seedWorkspace();
  const userData = makeTempDir("rennet-e2e-685-state-");
  const home = makeTempDir("rennet-e2e-685-home-");
  const { planPath, invocationLog } = writeOwnerLoopScriptedHarnessPlan(workspace, harness);
  const daemon = await startTestDaemon({ userData, home, planPath });
  let launched = await launchRennet({
    repository: workspace,
    userData,
    home,
    env: modelFreeEnv(home),
  });
  let bridge: WsRennetBridge | undefined;
  try {
    let page = await launched.application.firstWindow();
    await completeWelcome(page);
    await page.getByRole("button", { name: "Add Project" }).first().click();
    await expect(page.getByRole("navigation", { name: "Current path" })).toBeVisible();
    const pathBar = page.getByRole("textbox", { name: "Directory path" });
    await pathBar.fill(workspace);
    await pathBar.press("Enter");
    const add = page.getByRole("button", { name: "Add", exact: true });
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.locator('[data-screen="project-indexing"]')).toBeVisible({ timeout: 60_000 });
    const startReview = page.getByRole("button", { name: "Start a Review" });
    await expect(startReview).toBeVisible({ timeout: 180_000 });
    await startReview.click();
    await expect(page.locator('[data-screen="new-chat"]')).toBeVisible();
    const targetRow = page
      .locator('[data-row="target"]', { hasText: /feature\/shared/ })
      .filter({ hasText: "owner/target" });
    await expect(targetRow).toHaveCount(1);
    await targetRow.click();

    await expect(page.locator('[data-screen="session-preparation"]')).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("article[data-lens]")).toBeVisible({ timeout: 180_000 });
    expect(
      await page
        .locator('[data-kind="lens-switcher"] [data-lens]')
        .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-lens"))),
    ).toEqual([...LENS_KINDS]);
    bridge = await bridgeFor(page);
    const sessions = await bridge.invoke("session.list", {});
    const session = sessions.sessions.find((candidate) => candidate.reviewId !== undefined);
    expect(session?.reviewId).toBeTruthy();
    const reviewId = session?.reviewId ?? "";
    const initialReview = await bridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId,
    });
    expect(initialReview.review.repositoryRoot).toBe(target);
    const initialGeneration = generationIdForPatchset(initialReview.review.activePatchsetId);
    await expectFiveSourceBackedBoards(
      page,
      bridge,
      reviewId,
      initialGeneration,
      initialReview.review.activePatchsetId,
    );

    const roundOneThreadId = await stageAskFromSequenceBoard(
      page,
      bridge,
      reviewId,
      OWNER_LOOP_ROUND_ONE_BODY,
    );
    await dispatchVisibleRound(page, OWNER_LOOP_ROUND_ONE_BODY, 1, expectedHarness);
    const afterRoundOne = await bridge.invoke("session.rounds", { reviewId });
    expect(afterRoundOne.records).toHaveLength(1);
    const roundOneGeneration = afterRoundOne.records[0]?.boardGeneration ?? "";
    const roundOnePatchset = afterRoundOne.records[0]?.resultPatchsetId ?? "";
    expect(roundOnePatchset).not.toBe("");
    await expectFiveSourceBackedBoards(
      page,
      bridge,
      reviewId,
      roundOneGeneration,
      roundOnePatchset,
    );
    expect(roundOneGeneration).not.toBe(initialGeneration);
    expect(afterRoundOne.records[0]?.frozenPredecessor).toBe(initialGeneration);
    const afterRoundOneAsks = await bridge.invoke("ask.read", { sessionId: reviewId });
    expect(afterRoundOneAsks.projection.quoteThreads[roundOneThreadId]).toMatchObject({
      anchor: OWNER_LOOP_SEQUENCE_QUOTE,
      target: "sequence-step",
      generation: roundOneGeneration,
      lifecycle: "attached",
    });
    await page.locator('[data-kind="lens-switcher"] [data-lens="sequence"]').click();
    await expect(
      page.locator('[data-quote-target="sequence-step"] [data-quote-highlight]'),
    ).toHaveAttribute("data-thread-count", "1");

    bridge.close();
    bridge = undefined;
    const closed = launched.application.waitForEvent("close");
    launched.application.process().kill("SIGTERM");
    await closed;
    launched = await launchRennet({
      repository: workspace,
      userData,
      home,
      env: modelFreeEnv(home),
    });
    page = await launched.application.firstWindow();
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, reviewId);
    await expect(page.locator("article[data-lens]")).toBeVisible({ timeout: 60_000 });
    bridge = await bridgeFor(page);
    expect((await bridge.invoke("session.rounds", { reviewId })).records).toHaveLength(1);
    const afterRestartAsks = await bridge.invoke("ask.read", { sessionId: reviewId });
    expect(afterRestartAsks.projection.quoteThreads[roundOneThreadId]).toMatchObject({
      anchor: OWNER_LOOP_SEQUENCE_QUOTE,
      target: "sequence-step",
      generation: roundOneGeneration,
      lifecycle: "attached",
    });
    await page.locator('[data-kind="lens-switcher"] [data-lens="sequence"]').click();
    await expect(
      page.locator('[data-quote-target="sequence-step"] [data-quote-highlight]'),
    ).toHaveAttribute("data-thread-count", "1");

    const roundTwoThreadId = await stageAskFromSequenceBoard(
      page,
      bridge,
      reviewId,
      OWNER_LOOP_ROUND_TWO_BODY,
    );
    await dispatchVisibleRound(page, OWNER_LOOP_ROUND_TWO_BODY, 2, expectedHarness);
    const finalRounds = await bridge.invoke("session.rounds", { reviewId });
    expect(finalRounds.records).toHaveLength(2);
    // Durable half of the same acceptance: every round's receipt names the harness that
    // ran it, and the session stayed pinned to it across the restart (no silent switch).
    expect(finalRounds.records.map((record) => record.run?.harness)).toEqual([
      { id: harness, version: "685-scripted-v1" },
      { id: harness, version: "685-scripted-v1" },
    ]);
    expect(finalRounds.records[1]?.frozenPredecessor).toBe(finalRounds.records[0]?.boardGeneration);
    const finalGeneration = finalRounds.records[1]?.boardGeneration ?? "";
    const finalPatchset = finalRounds.records[1]?.resultPatchsetId ?? "";
    expect(finalPatchset).not.toBe("");
    await expectFiveSourceBackedBoards(page, bridge, reviewId, finalGeneration, finalPatchset);
    const finalAsks = await bridge.invoke("ask.read", { sessionId: reviewId });
    for (const threadId of [roundOneThreadId, roundTwoThreadId]) {
      expect(finalAsks.projection.quoteThreads[threadId]).toMatchObject({
        anchor: OWNER_LOOP_SEQUENCE_QUOTE,
        target: "sequence-step",
        generation: finalGeneration,
        lifecycle: "attached",
      });
    }
    await page.locator('[data-kind="lens-switcher"] [data-lens="sequence"]').click();
    const sequenceBoard = page.locator('article[data-lens="sequence"]');
    const sequenceHighlight = page.locator(
      '[data-quote-target="sequence-step"] [data-quote-highlight]',
    );
    await expect(sequenceBoard).toHaveAttribute("data-generation", finalGeneration);
    await expect(sequenceHighlight).toHaveAttribute("data-thread-count", "2");
    const generations = page.locator('[data-kind="generation-switcher"] [role="tab"]');
    await expect(generations).toHaveCount(3);
    const initialTab = page.locator(
      `[data-kind="generation-switcher"] [data-generation="${initialGeneration}"]`,
    );
    const roundOneTab = page.locator(
      `[data-kind="generation-switcher"] [data-generation="${roundOneGeneration}"]`,
    );
    const finalTab = page.locator(
      `[data-kind="generation-switcher"] [data-generation="${finalGeneration}"]`,
    );
    await expect(initialTab).toHaveAttribute("data-frozen", "true");
    await expect(roundOneTab).toHaveAttribute("data-frozen", "true");
    await expect(finalTab).not.toHaveAttribute("data-frozen", "true");
    await initialTab.click();
    await expect(sequenceBoard).toHaveAttribute("data-generation", initialGeneration);
    await expect(sequenceBoard).toContainText(OWNER_LOOP_SOURCE);
    await expect(sequenceHighlight).toHaveCount(0);
    await roundOneTab.click();
    await expect(sequenceBoard).toHaveAttribute("data-generation", roundOneGeneration);
    await expect(sequenceBoard).toContainText(OWNER_LOOP_SOURCE);
    await expect(sequenceHighlight).toHaveCount(0);
    await finalTab.click();
    await expect(sequenceBoard).toHaveAttribute("data-generation", finalGeneration);
    await expect(sequenceHighlight).toHaveAttribute("data-thread-count", "2");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: target }).toString()).toBe(
      "main\n",
    );
    expect(readFileSync(join(target, OWNER_LOOP_SOURCE), "utf8")).toBe(
      "export const ownerValue = 'base';\n",
    );
    expect(
      execFileSync("git", ["show", `main:${OWNER_LOOP_SOURCE}`], { cwd: target }).toString(),
    ).toBe("export const ownerValue = 'base';\n");
    expect(
      execFileSync("git", ["show", `feature/shared:${OWNER_LOOP_SOURCE}`], {
        cwd: target,
      }).toString(),
    ).toBe("export const ownerValue = 'round-two';\n");
    expect(
      execFileSync("git", ["show", `feature/shared:${OWNER_LOOP_SOURCE}`], {
        cwd: decoy,
      }).toString(),
    ).toBe("export const ownerValue = 'decoy-reviewed';\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: target }).toString()).toBe("");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: decoy }).toString()).toBe("");
    const ledger = readFileSync(invocationLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; stepId: string; harness: string });
    expect(
      ledger.filter((record) => record.kind === "edit").map((record) => record.stepId),
    ).toEqual(["round-one-edit", "round-two-edit"]);
    // The EXECUTING half of #681's provenance acceptance. The receipt asserted during each
    // round reads the RESOLVER's stamp (`runResolvedCodingHarnessTurn` stamps
    // `resolution.selection` on the outcome), so it stays green even if the seat underneath
    // executes as a different provider — the stamp and the execution have a common cause
    // only when nothing lies between them. This reads each turn's OWN session
    // (`HarnessSession.harness`, written into the scripted ledger by the run callback) and
    // is therefore independent of the stamp.
    //
    // ⚠️ NOT CONTROL-PROVEN HERE, and saying so is the point. On 2026-09-01 this spec could
    // not be run to this line at all: BOTH legs fail at round one, in `report-drafting`,
    // with "Round report outcome … cites src/owner.ts, not the asked path Read
    // `src/owner.ts` first." — a pre-existing `verifyAskPath` defect
    // (`packages/server/src/runtime/round-report-verification.ts`), reproduced identically
    // with every file this branch touches reverted to its base commit. So no mutation of
    // the seat could be watched reddening THIS assertion; it is written to be right, not
    // yet observed being right.
    // The mechanism it stands on IS control-proven, one level down, in
    // `packages/server/src/scripted-harness-plan.test.ts` ("records the executing session's
    // own provider in the ledger, not the plan's"): constructing the session as
    // `claude-code` while the descriptor stays `codex` leaves the resolver — and therefore
    // the receipt above — green, and reddens the ledger reading. What remains unproven is
    // only that this spec reaches here, which the `verifyAskPath` fix settles.
    expect(ledger.length).toBeGreaterThan(0);
    expect([...new Set(ledger.map((record) => record.harness))]).toEqual([harness]);
  } finally {
    bridge?.close();
    await launched.application.close().catch(() => undefined);
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    rmSync(workspace, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("#685: launched owner loop survives two rounds and a daemon-preserving app restart", () =>
  runLaunchedOwnerLoop("claude-code", "Claude Code"));

test("#681: the same launched owner loop runs both rounds on a Codex-only host", () =>
  runLaunchedOwnerLoop("codex", "Codex"));
