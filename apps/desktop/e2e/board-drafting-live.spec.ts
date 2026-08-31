import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import {
  generationIdForPatchset,
  LENS_KINDS,
  type LensAbsenceReason,
  type LensBoard,
  type LensKind,
} from "@rennet/protocol";
import { findHealthyDaemon, readDaemonFile } from "@rennet/server";
import { completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE proof that CAPTURING A CHANGE DRAFTS ITS BOARDS — the core loop, end to end.
//
// `product-and-vision.md` draws it `local --> boards`: you capture a change and you READ
// it as boards. For a long time nothing in the shipped app closed that loop. Two defects,
// one on each side of the wire, and each hid the other:
//
//   1. SERVER — the drafting pipeline had a single caller, the round-regeneration tail,
//      and a round only runs on staged asks, which a reviewer can only stage BY READING A
//      BOARD. So a captured review never got a first board and could not: deadlock. The fix
//      kicks `draftBoardsForReview` off `onReviewOpened` (which `review.capture` fires).
//   2. CLIENT — the review workspace read its boards at the literal generation `"live"`,
//      which no board is ever stamped with (the daemon files every board under
//      `gen:<patchsetId>` and `board.read` matches EXACTLY), so even a drafted board was
//      unreachable. The fix reads at `generationIdForPatchset(review.activePatchsetId)`.
//
// This drives both at once against the real installed harness. It captures over the app's
// daemon socket, waits for every lens to reach one durable terminal result, opens each result
// in the real window, then restarts the app and daemon over the same data directory. After the
// restart it dispatches one real request-change round and requires a changed successor patchset
// plus a new populated board generation. A green run closes the owner's read -> ask -> round ->
// reread loop without substituting a mock for the daemon, coding worker, or lens pipeline.
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic, zero-spend specs use `modelFreeEnv`; this runs a REAL `claude` turn on the
// reviewer's own subscription, drafting five lenses. Opt-in, a cost switch not a gate:
// `RENNET_LIVE_E2E=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts board-drafting-live`.
const liveTest = process.env.RENNET_LIVE_E2E === "1" ? test : test.skip;

const REVIEWED_PATH = "src/widget.ts";
const ROUND_ASK_ID = "live-successor-widget-three";

interface BoardReadResult {
  readonly board: LensBoard | null;
  readonly absence?: LensAbsenceReason;
  readonly failure?: string;
}

type TerminalLensEvidence =
  | {
      readonly kind: "board";
      readonly board: LensBoard;
    }
  | { readonly kind: "absence"; readonly reason: LensAbsenceReason }
  | { readonly kind: "failure"; readonly reason: string };

interface TerminalKindEvidence {
  readonly kind: TerminalLensEvidence["kind"];
}

const ABSENCE_BY_LENS: ReadonlyMap<LensKind, LensAbsenceReason> = new Map([
  ["design", "no-material"],
  ["decisions", "no-decisions"],
  ["flagged", "no-findings"],
  ["noise", "no-noise"],
]);

const ABSENCE_TITLE: Readonly<Record<LensAbsenceReason, string>> = {
  "no-material": "No Design specification applies to this change.",
  "no-decisions": "No material engineering decisions were found.",
  "no-findings": "No review findings were found.",
  "no-noise": "No safely skippable noise was found.",
};

function liveEnv(disableHarness: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // #569
  if (disableHarness) env.RENNET_DISABLE_HARNESS = "1";
  else delete env.RENNET_DISABLE_HARNESS;
  return env;
}

async function connect(page: Page): Promise<WsRennetBridge> {
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  return new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
}

function terminalLensEvidence(
  lens: LensKind,
  generation: string,
  read: BoardReadResult,
): TerminalLensEvidence | undefined {
  const variants = [
    read.board !== null,
    read.absence !== undefined,
    read.failure !== undefined,
  ].filter(Boolean).length;
  if (variants === 0) return undefined;
  if (variants !== 1) {
    throw new Error(`${lens}: expected one terminal board.read result, got ${variants}`);
  }
  if (read.board !== null) {
    if (read.board.lens !== lens || read.board.generation !== generation) {
      throw new Error(
        `${lens}: board identity ${read.board.lens}/${read.board.generation} does not match ${generation}`,
      );
    }
    if (read.board.elements.length === 0) {
      throw new Error(`${lens}: board.read returned a zero-element successful board`);
    }
    return {
      kind: "board",
      board: read.board,
    };
  }
  if (read.absence !== undefined) {
    const expected = ABSENCE_BY_LENS.get(lens);
    if (read.absence !== expected) {
      throw new Error(`${lens}: expected absence ${expected ?? "none"}, got ${read.absence}`);
    }
    return { kind: "absence", reason: read.absence };
  }
  if (read.failure === undefined || read.failure.length === 0) {
    throw new Error(`${lens}: terminal failure has no reason`);
  }
  return { kind: "failure", reason: read.failure };
}

async function waitForTerminalLenses(
  bridge: WsRennetBridge,
  reviewId: string,
  generation: string,
): Promise<ReadonlyMap<LensKind, TerminalLensEvidence>> {
  const terminal = new Map<LensKind, TerminalLensEvidence>();
  await expect
    .poll(
      async () => {
        terminal.clear();
        for (const lens of LENS_KINDS) {
          const read = await bridge.invoke("board.read", { reviewId, generation, lens });
          const evidence = terminalLensEvidence(lens, generation, read);
          if (evidence !== undefined) terminal.set(lens, evidence);
        }
        return terminal.size;
      },
      { timeout: 600_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(LENS_KINDS.length);
  return new Map(terminal);
}

async function expectTerminalLensesRendered(
  page: Page,
  terminal: ReadonlyMap<LensKind, TerminalLensEvidence>,
): Promise<void> {
  const tabs = page.locator('[data-kind="lens-switcher"] [data-lens]');
  await expect(tabs).toHaveCount(LENS_KINDS.length, { timeout: 30_000 });
  for (const lens of LENS_KINDS) {
    const evidence = terminal.get(lens);
    if (evidence === undefined) throw new Error(`${lens}: missing terminal proof evidence`);
    const tab = page.locator(`[data-kind="lens-switcher"] [data-lens="${lens}"]`);
    await expect(tab).toBeVisible();
    await tab.click();
    if (evidence.kind === "board") {
      const board = page.locator(`article[data-lens="${lens}"]`);
      await expect(board).toBeVisible();
      await expect(board).toHaveAttribute("data-generation", evidence.board.generation);
      await expect(board).toContainText(evidence.board.document.title);
    } else if (evidence.kind === "absence") {
      await expect(tab).toHaveAttribute("data-absent", evidence.reason);
      await expect(page.locator('[data-kind="board-absent"]')).toContainText(
        ABSENCE_TITLE[evidence.reason],
      );
    } else {
      await expect(tab).toHaveAttribute("data-failed", "true");
      await expect(page.locator('[data-kind="board-failed"]')).toContainText(evidence.reason);
    }
    await expect(page.locator('[data-kind="board-empty"]')).toHaveCount(0);
    await expect(page.locator('[data-kind="board-error"]')).toHaveCount(0);
  }
}

function expectOptionalEmptyLensesHonest(
  terminal: ReadonlyMap<LensKind, TerminalLensEvidence>,
): void {
  const requiredProof: readonly LensKind[] = ["decisions", "flagged"];
  for (const lens of requiredProof) {
    expect(
      terminal.get(lens)?.kind,
      `${lens} must render a populated board or its typed empty state`,
    ).toMatch(/^(board|absence)$/);
  }
}

function expectPopulatedBoard(terminal: ReadonlyMap<LensKind, TerminalKindEvidence>): void {
  const populated = [...terminal.values()].filter((evidence) => evidence.kind === "board");
  expect(
    populated.length,
    "the terminal lens set must contain at least one populated board",
  ).toBeGreaterThan(0);
}

test("terminal lens oracle rejects an all-empty or failed result", () => {
  const noBoards: ReadonlyMap<LensKind, TerminalKindEvidence> = new Map([
    ["design", { kind: "absence" }],
    ["sequence", { kind: "failure" }],
    ["decisions", { kind: "absence" }],
    ["flagged", { kind: "absence" }],
    ["noise", { kind: "absence" }],
  ]);
  expect(() => expectPopulatedBoard(noBoards)).toThrow("at least one populated board");

  const oneBoard = new Map(noBoards);
  oneBoard.set("sequence", { kind: "board" });
  expect(() => expectPopulatedBoard(oneBoard)).not.toThrow();
});

async function healthyDaemonPid(userData: string): Promise<number> {
  await expect
    .poll(async () => (await findHealthyDaemon(userData)).kind, {
      timeout: 30_000,
      intervals: [50, 100, 250],
    })
    .toBe("healthy");
  const healthy = await findHealthyDaemon(userData);
  if (healthy.kind !== "healthy") {
    throw new Error(`daemon lost health after the successful probe: ${healthy.kind}`);
  }
  expect(readDaemonFile(userData)).toEqual(healthy.claim);
  return healthy.claim.pid;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function gitOutput(repository: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

async function waitForReturnedRound(
  bridge: WsRennetBridge,
  reviewId: string,
  operationId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { events } = await bridge.invoke("session.roundEvents", { reviewId });
        const current = events.findLast(
          (event) => event.type === "operation" && event.snapshot.operationId === operationId,
        );
        if (current?.type !== "operation") return "missing";
        if (current.snapshot.state.phase === "failed") {
          throw new Error(
            `successor round failed: ${JSON.stringify(current.snapshot.state.failure)}`,
          );
        }
        if (current.snapshot.state.phase !== "completed") {
          return current.snapshot.state.phase;
        }
        return current.snapshot.draining === false ? "returned" : "draining";
      },
      { timeout: 900_000, intervals: [500, 1_000, 2_000, 5_000] },
    )
    .toBe("returned");
}

/** Capture `repository` into a review through the app's own daemon, and open its route.
 *  `review.capture` fires `onReviewOpened`, which is what kicks the drafting under test. */
async function openCapturedReview(page: Page, repository: string): Promise<string> {
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  try {
    await bridge.invoke("repository.choose", { path: repository });
    const { review } = await bridge.invoke("review.capture", {
      commandId: crypto.randomUUID(),
      repoPath: repository,
    });
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, review.id);
    return review.id;
  } finally {
    bridge.close();
  }
}

liveTest("LIVE: boards survive restart and a real round produces successor boards", async () => {
  test.setTimeout(1_800_000);
  const repository = seedReviewRepo("board-live-repo-");
  const userData = makeTempDir("board-live-state-");
  const home = makeTempDir("board-live-home-");
  let launched = await launchRennet({ repository, userData, home, env: liveEnv(false) });
  let bridge: WsRennetBridge | undefined;
  try {
    let page = await launched.application.firstWindow();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[renderer:error] ${m.text()}`);
    });
    // The first-run welcome is a full-screen gate; clear it or the route never mounts.
    await completeWelcome(page);
    const reviewId = await openCapturedReview(page, repository);
    console.log("REVIEW:", reviewId);

    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    bridge = await connect(page);
    const loaded = await bridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId,
    });
    const initialPatchset = loaded.review.patchsets.find(
      (patchset) => patchset.id === loaded.review.activePatchsetId,
    );
    if (initialPatchset === undefined) throw new Error("captured review lost its active patchset");
    expect(initialPatchset.intent?.surface).toBe("working-tree");
    expect(initialPatchset.source ?? "local").toBe("local");
    const generation = generationIdForPatchset(loaded.review.activePatchsetId);
    const terminal = await waitForTerminalLenses(bridge, reviewId, generation);
    console.log("LENS TERMINALS:", JSON.stringify([...terminal.entries()], null, 2));
    expectPopulatedBoard(terminal);
    expectOptionalEmptyLensesHonest(terminal);
    await expectTerminalLensesRendered(page, terminal);

    // Positive control: the same review at a stale generation has no terminal result.
    // This proves the successful reads above are keyed to the captured patchset rather
    // than borrowed from any board stored for the review.
    expect(
      await bridge.invoke("board.read", {
        reviewId,
        generation: `${generation}:stale-control`,
        lens: "sequence",
      }),
    ).toEqual({ board: null });

    const firstDaemonPid = await healthyDaemonPid(userData);
    bridge.close();
    bridge = undefined;
    await launched.application.close();
    await expect
      .poll(() => readDaemonFile(userData), { timeout: 30_000, intervals: [50, 100, 250] })
      .toBeNull();
    await expect
      .poll(() => processIsAlive(firstDaemonPid), {
        timeout: 30_000,
        intervals: [50, 100, 250],
      })
      .toBe(false);

    launched = await launchRennet({ repository, userData, home, env: liveEnv(false) });
    page = await launched.application.firstWindow();
    const replacementDaemonPid = await healthyDaemonPid(userData);
    expect(replacementDaemonPid).not.toBe(firstDaemonPid);
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, reviewId);
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    bridge = await connect(page);
    const reconstructed = await waitForTerminalLenses(bridge, reviewId, generation);

    expect([...reconstructed.entries()]).toEqual([...terminal.entries()]);
    expectPopulatedBoard(reconstructed);
    expectOptionalEmptyLensesHonest(reconstructed);
    await expectTerminalLensesRendered(page, reconstructed);

    const beforeRoundDiff = gitOutput(repository, "diff", "--", REVIEWED_PATH);
    expect(beforeRoundDiff).toContain("+export const widget = 2;");
    await bridge.invoke("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: ROUND_ASK_ID,
        anchor: `${REVIEWED_PATH}:1`,
        type: "request-change",
        body: `Replace the entire contents of ${REVIEWED_PATH} with exactly \`export const widget = 3;\` followed by one newline. Do not change any other file.`,
      },
    });
    const dispatched = await bridge.invoke("round.dispatch", { reviewId });
    expect(dispatched.dispatched).toBe(true);
    expect(dispatched.acceptedOperation).toBeDefined();
    const operationId = dispatched.acceptedOperation?.operationId;
    if (operationId === undefined) throw new Error("round dispatch returned no operation identity");
    await waitForReturnedRound(bridge, reviewId, operationId);

    const asks = await bridge.invoke("ask.read", { sessionId: reviewId });
    expect(asks.projection.stagedAsks[ROUND_ASK_ID]).toBeUndefined();
    const rounds = await bridge.invoke("session.rounds", { reviewId });
    const successor = rounds.records.findLast((record) =>
      record.asksDispatched.includes(ROUND_ASK_ID),
    );
    if (successor === undefined) throw new Error("returned round has no durable ledger record");
    expect(successor.outcome).toBe("completed");
    expect(successor.changedPaths).toEqual([REVIEWED_PATH]);
    expect(successor.diff).toContain("-export const widget = 2;");
    expect(successor.diff).toContain("+export const widget = 3;");
    expect(successor.workerCommitRange.to).not.toBe(successor.workerCommitRange.from);
    expect(successor.resultPatchsetId).toBeDefined();
    expect(successor.resultPatchsetId).not.toBe(loaded.review.activePatchsetId);
    expect(successor.boardGeneration).not.toBe(generation);
    expect(successor.mintedPatchsetGeneration).toBe(successor.boardGeneration);

    expect(readFileSync(join(repository, REVIEWED_PATH), "utf8")).toBe(
      "export const widget = 3;\n",
    );
    const afterRoundDiff = gitOutput(repository, "diff", "--", REVIEWED_PATH);
    expect(afterRoundDiff).toContain("+export const widget = 3;");

    const reloaded = await bridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId,
    });
    expect(reloaded.review.activePatchsetId).toBe(successor.resultPatchsetId);
    expect(
      reloaded.review.patchsets.some((patchset) => patchset.id === successor.resultPatchsetId),
    ).toBe(true);
    const successorTerminal = await waitForTerminalLenses(
      bridge,
      reviewId,
      successor.boardGeneration,
    );
    expectPopulatedBoard(successorTerminal);

    await page.reload();
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    await expectTerminalLensesRendered(page, successorTerminal);
  } finally {
    bridge?.close();
    await launched.application.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
