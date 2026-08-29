import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import type { ReviewAskStreamEvent, SessionTranscriptRow, TranscriptBlock } from "@rennet/protocol";
import { completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

// The deterministic suite is zero-spend. This one opt-in journey spends exactly one real
// Claude turn and proves the complete live path: partial frames, ordered tool activity,
// durable app state, fenced code, a code comment, and byte-stable reload. The capture happens
// in a prior harness-disabled launch so its automatic board drafting cannot spend extra turns.
// Run with:
// RENNET_LIVE_E2E=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts f1-live-chat
test.skip(process.env.RENNET_LIVE_E2E !== "1", "live harness spec — set RENNET_LIVE_E2E=1");

const ASK_ID = "live-e2e-widget-2";
const ASK_BODY = "Restore the changed constant to its previous value.";
const COMMENT = "Keep this exact value covered.";
const FINAL_MARKER = "LIVE_CHAT_RECEIPT_PROOF";
const EXPECTED_RECEIPT = `{"receipt":{"kind":"unstage","id":"${ASK_ID}"}}`;
const NO_HARNESS_ANSWER =
  "No coding harness (claude) is installed, so the orchestrator cannot answer.";
const QUESTION = [
  "Inspect the actual diff under review. Discover its changed file, exact old line, exact new line, and the new-side line number.",
  `Then call app_ask_stage exactly once. Use the current review ask-log id supplied by Rennet as sessionId. Use id ${ASK_ID}, type request-change, and body ${ASK_BODY} Set the anchor to the discovered changed file and new-side line in path:line form.`,
  `After the tool returns, name the discovered file, quote the exact old and new lines, include the literal marker ${FINAL_MARKER}, then include a fenced block whose info string is the detected language and path and whose only content is the exact new line.`,
].join("\n");

type CompleteEvent = Extract<ReviewAskStreamEvent, { kind: "ask-complete" }>;

function liveEnv(disableHarness: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (disableHarness) env.RENNET_DISABLE_HARNESS = "1";
  else delete env.RENNET_DISABLE_HARNESS;
  return env;
}

async function connect(page: Page): Promise<WsRennetBridge> {
  const port = await page.evaluate(
    () => (window as unknown as { rennet: { wsPort: number } }).rennet.wsPort,
  );
  return new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
}

async function captureWithoutHarness(
  page: Page,
  repository: string,
): Promise<{ reviewId: string; sessionId: string }> {
  const bridge = await connect(page);
  try {
    await bridge.invoke("repository.choose", { path: repository });
    const { review } = await bridge.invoke("review.capture", {
      commandId: crypto.randomUUID(),
      repoPath: repository,
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const session = (await bridge.invoke("session.list", {})).sessions.find(
        (candidate) => candidate.reviewId === review.id,
      );
      if (session !== undefined) return { reviewId: review.id, sessionId: session.id };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`review ${review.id} never acquired its durable session`);
  } finally {
    bridge.close();
  }
}

async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    location.hash = `#/s/${id}`;
  }, sessionId);
  const composer = page.getByLabel("Message the orchestrator").last();
  const toggle = page.getByRole("button", { name: "Open chat" }).last();
  await expect(composer.or(toggle)).toBeVisible({ timeout: 120_000 });
  if (await toggle.isVisible()) await toggle.click();
  await expect(composer).toBeEnabled({
    timeout: 120_000,
  });
}

async function askAndCollect(
  page: Page,
  bridge: WsRennetBridge,
  reviewId: string,
  question: string,
): Promise<readonly ReviewAskStreamEvent[]> {
  const events: ReviewAskStreamEvent[] = [];
  let settle: ((event: CompleteEvent) => void) | undefined;
  const complete = new Promise<CompleteEvent>((resolve) => {
    settle = resolve;
  });
  const off = bridge.onAskStream(reviewId, (event) => {
    events.push(event);
    if (event.kind === "ask-complete") settle?.(event);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("live ask timed out")), 600_000);
  });
  try {
    const box = page.getByLabel("Message the orchestrator").last();
    await box.fill(question);
    await page.getByLabel("Send").last().click();
    await Promise.race([complete, timedOut]);
    await page.waitForTimeout(1_000);
    return events;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    off();
  }
}

function transcriptRows(events: readonly ReviewAskStreamEvent[]): readonly SessionTranscriptRow[] {
  const states = events.filter((event) => event.kind === "ask-state");
  return states.at(-1)?.rows ?? [];
}

test("LIVE 6.2: one real turn streams, acts once, and survives reload", async () => {
  test.setTimeout(900_000);
  const repository = seedReviewRepo("f1-live-repo-");
  const userData = makeTempDir("f1-live-state-");
  const home = makeTempDir("f1-live-home-");
  try {
    const setup = await launchRennet({
      repository,
      userData,
      home,
      env: liveEnv(true),
    });
    let identity: { reviewId: string; sessionId: string };
    try {
      const page = await setup.application.firstWindow();
      await completeWelcome(page);
      identity = await captureWithoutHarness(page, repository);
    } finally {
      await setup.application.close();
    }

    const live = await launchRennet({
      repository,
      userData,
      home,
      env: liveEnv(false),
    });
    const bridge = await (async () => {
      const page = await live.application.firstWindow();
      await openSession(page, identity.sessionId);
      return connect(page);
    })();
    try {
      const page = await live.application.firstWindow();
      const events = await askAndCollect(page, bridge, identity.reviewId, QUESTION);

      const deltas = events.filter((event) => event.kind === "ask-delta" && event.delta.length > 0);
      expect(deltas.length).toBeGreaterThan(1);
      const completions = events.filter((event) => event.kind === "ask-complete");
      expect(completions).toHaveLength(1);
      expect(completions[0]?.finalBody).toContain("src/widget.ts");
      expect(completions[0]?.finalBody).toContain("export const widget = 1;");
      expect(completions[0]?.finalBody).toContain("export const widget = 2;");
      const completionIndex = events.findIndex((event) => event.kind === "ask-complete");
      expect(events.findIndex((event) => event.kind === "ask-state")).toBeGreaterThanOrEqual(0);
      expect(events.findIndex((event) => event.kind === "ask-state")).toBeLessThan(completionIndex);

      const rows = transcriptRows(events);
      const answer = rows.find(
        (row): row is Extract<SessionTranscriptRow, { kind: "turn" }> =>
          row.kind === "turn" && row.speaker === "orchestrator",
      );
      expect(answer).toBeDefined();
      expect(answer?.status).toBe("complete");
      const terminalBlocks = answer?.blocks ?? [];
      const actionIndex = terminalBlocks.findIndex(
        (block) => block.kind === "action" && block.label === "app_ask_stage",
      );
      const markerIndex = terminalBlocks.findIndex(
        (block) => block.kind === "text" && block.text.includes(FINAL_MARKER),
      );
      const codeIndex = terminalBlocks.findIndex((block) => block.kind === "code");
      expect(actionIndex).toBeGreaterThanOrEqual(0);
      expect(markerIndex).toBeGreaterThan(actionIndex);
      expect(codeIndex).toBeGreaterThan(markerIndex);
      expect(
        terminalBlocks
          .filter((block) => block.kind === "thought" || block.kind === "action")
          .every((block) => block.status === "complete"),
      ).toBe(true);
      const actions = terminalBlocks.filter(
        (block): block is Extract<TranscriptBlock, { kind: "action" }> =>
          block.kind === "action" && block.label === "app_ask_stage",
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ status: "complete" });
      expect(actions[0]?.doneDetail).toBe(EXPECTED_RECEIPT);
      const code = answer?.blocks?.find(
        (block): block is Extract<TranscriptBlock, { kind: "code" }> => block.kind === "code",
      );
      expect(code).toMatchObject({
        path: "src/widget.ts",
        lang: "ts",
        code: "export const widget = 2;",
      });

      const staged = await bridge.invoke("ask.read", { sessionId: identity.reviewId });
      expect(Object.keys(staged.projection.stagedAsks)).toEqual([ASK_ID]);
      expect(staged.projection.stagedAsks[ASK_ID]).toMatchObject({
        anchor: "src/widget.ts:1",
        type: "request-change",
        body: ASK_BODY,
      });

      const dock = page.locator(".rennet-chat-dock");
      await expect(dock.getByText(FINAL_MARKER, { exact: false })).toBeVisible();
      await expect(dock.locator('[data-line="1"]').filter({ hasText: "widget = 2" })).toBeVisible();
      await dock.getByLabel("Comment on line 1").click();
      await dock.getByPlaceholder("Leave a comment on this line…").fill(COMMENT);
      await dock.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () => {
          const projection = await bridge.invoke("ask.read", { sessionId: identity.reviewId });
          return projection.projection.lineComments["src/widget.ts"]?.["1"];
        })
        .toBe(COMMENT);

      await page.reload();
      await openSession(page, identity.sessionId);
      const reloadedDock = page.locator(".rennet-chat-dock");
      await expect(reloadedDock.getByText(QUESTION, { exact: true })).toHaveCount(1);
      await expect(reloadedDock.getByText(FINAL_MARKER, { exact: false })).toHaveCount(1);
      await expect(reloadedDock.getByText("app_ask_stage", { exact: false })).toHaveCount(1);
      await expect(
        reloadedDock.locator('[data-line="1"]').filter({ hasText: "widget = 2" }),
      ).toHaveCount(1);
      await expect(reloadedDock.getByLabel("Edit comment on line 1")).toBeVisible();

      const reattached = await bridge.invoke("review.reattach", {
        commandId: crypto.randomUUID(),
        reviewId: identity.reviewId,
      });
      const messages = reattached.threads.flatMap((thread) => thread.messages);
      expect(messages.filter((message) => message.author === "you")).toHaveLength(1);
      expect(messages.filter((message) => message.author === "harness")).toHaveLength(1);
      expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
      const persistedHarness = messages.find((message) => message.author === "harness");
      expect(persistedHarness?.body).toBe(completions[0]?.finalBody);
      expect(persistedHarness?.rows).toEqual(rows);
      const persistedActions = messages
        .flatMap((message) => message.rows ?? [])
        .flatMap((row) => (row.kind === "turn" ? (row.blocks ?? []) : []))
        .filter((block) => block.kind === "action" && block.label === "app_ask_stage");
      expect(persistedActions).toHaveLength(1);
      const persistedAction = persistedActions[0];
      if (persistedAction?.kind !== "action") throw new Error("expected persisted app action");
      expect(persistedAction.doneDetail).toBe(EXPECTED_RECEIPT);
    } finally {
      bridge.close();
      await live.application.close();
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("LIVE 6.2 control: a disabled harness names the missing binary", async () => {
  test.setTimeout(600_000);
  const repository = seedReviewRepo("f1-control-repo-");
  const userData = makeTempDir("f1-control-state-");
  const home = makeTempDir("f1-control-home-");
  const launched = await launchRennet({ repository, userData, home, env: liveEnv(true) });
  try {
    const page = await launched.application.firstWindow();
    await completeWelcome(page);
    const identity = await captureWithoutHarness(page, repository);
    await openSession(page, identity.sessionId);
    const bridge = await connect(page);
    try {
      const events = await askAndCollect(page, bridge, identity.reviewId, QUESTION);
      const completions = events.filter((event) => event.kind === "ask-complete");
      expect(completions).toHaveLength(1);
      expect(completions[0]?.finalBody).toBe(NO_HARNESS_ANSWER);
      await expect(page.getByText(NO_HARNESS_ANSWER, { exact: true })).toBeVisible();
      expect(
        transcriptRows(events).flatMap((row) => (row.kind === "turn" ? (row.blocks ?? []) : [])),
      ).toEqual([]);
    } finally {
      bridge.close();
    }
  } finally {
    await launched.application.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
