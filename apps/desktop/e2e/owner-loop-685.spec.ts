import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { LENS_KINDS } from "@rennet/protocol";
import {
  OWNER_LOOP_ROUND_ONE_ASK,
  OWNER_LOOP_ROUND_ONE_BODY,
  OWNER_LOOP_ROUND_TWO_ASK,
  OWNER_LOOP_ROUND_TWO_BODY,
  OWNER_LOOP_SOURCE,
  writeOwnerLoopScriptedHarnessPlan,
} from "../../../packages/server/src/owner-loop-proof-fixture";
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
  writeRepoFile(
    root,
    OWNER_LOOP_SOURCE,
    `export const ownerValue = '${name === "target" ? "base" : "decoy-base"}';\n`,
  );
  if (name === "target") {
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
  const workspace = makeTempDir("rennet-e2e-685-workspace-");
  const target = join(workspace, "target");
  const decoy = join(workspace, "decoy");
  seedRepo(target, "target");
  seedRepo(decoy, "decoy");
  return { workspace, target, decoy };
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
      ...modelFreeEnv(options.home),
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
  const port = await page.evaluate(
    () => (window as unknown as { rennet: { wsPort: number } }).rennet.wsPort,
  );
  return new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
}

async function stageAsk(
  bridge: WsRennetBridge,
  sessionId: string,
  ask: { id: string; body: string },
): Promise<void> {
  await bridge.invoke("ask.stage", {
    sessionId,
    ask: {
      id: ask.id,
      anchor: `${OWNER_LOOP_SOURCE}:1`,
      type: "request-change",
      body: ask.body,
    },
  });
}

async function dispatchVisibleRound(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue, 1 staged" }).click();
  await page.getByRole("button", { name: "Dispatch Round" }).click();
  await expect(page.locator('[data-screen="session-run"]')).toBeVisible({ timeout: 30_000 });
  const greeting = page.locator('[data-screen="round-greeting"]');
  await expect(greeting).toBeVisible({ timeout: 180_000 });
  await greeting.getByRole("button", { name: "View the New Boards" }).click();
  await expect(page.locator("article[data-lens]")).toBeVisible({ timeout: 30_000 });
}

test("#685: launched owner loop survives two rounds and a daemon-preserving app restart", async () => {
  test.setTimeout(600_000);
  const { workspace, target, decoy } = seedWorkspace();
  const userData = makeTempDir("rennet-e2e-685-state-");
  const home = makeTempDir("rennet-e2e-685-home-");
  const { planPath, invocationLog } = writeOwnerLoopScriptedHarnessPlan(workspace);
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

    await page
      .locator('[data-slot="toggle-group"]')
      .getByRole("button", { name: "Map", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Context Map" })).toBeVisible();
    const projects = await bridge.invoke("projects.list", {});
    const map = await bridge.invoke("project.contextMap", {
      projectId: projects.projects[0]?.id ?? "",
      repository: "owner/target",
      forgeRepository: { forge: "github", owner: "owner", name: "target" },
    });
    expect(map.status).toBe("ok");
    if (map.status !== "ok") throw new Error(`target Context Map returned ${map.status}`);
    expect(map.map.files.map((file) => file.path)).toContain(OWNER_LOOP_SOURCE);
    await page.getByRole("button", { name: "Back to board" }).click();

    await stageAsk(bridge, reviewId, {
      id: OWNER_LOOP_ROUND_ONE_ASK,
      body: OWNER_LOOP_ROUND_ONE_BODY,
    });
    await dispatchVisibleRound(page);
    const afterRoundOne = await bridge.invoke("session.rounds", { reviewId });
    expect(afterRoundOne.records).toHaveLength(1);
    const initialGeneration = `gen:${initialReview.review.activePatchsetId}`;
    expect(afterRoundOne.records[0]?.frozenPredecessor).toBe(initialGeneration);

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
    bridge = await bridgeFor(page);
    expect((await bridge.invoke("session.rounds", { reviewId })).records).toHaveLength(1);

    await stageAsk(bridge, reviewId, {
      id: OWNER_LOOP_ROUND_TWO_ASK,
      body: OWNER_LOOP_ROUND_TWO_BODY,
    });
    await dispatchVisibleRound(page);
    const finalRounds = await bridge.invoke("session.rounds", { reviewId });
    expect(finalRounds.records).toHaveLength(2);
    expect(finalRounds.records[1]?.frozenPredecessor).toBe(finalRounds.records[0]?.boardGeneration);
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
    expect(
      readFileSync(invocationLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((record) => record.kind === "edit")
        .map((record) => record.stepId),
    ).toEqual(["round-one-edit", "round-two-edit"]);
  } finally {
    bridge?.close();
    await launched.application.close().catch(() => undefined);
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    rmSync(workspace, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
