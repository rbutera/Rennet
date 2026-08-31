import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import {
  generationIdForPatchset,
  LENS_KINDS,
  type LensAbsenceReason,
  type LensBoard,
  type LensKind,
} from "@rennet/protocol";
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
// in the real window, then restarts the app and daemon over the same data directory. A green
// run proves populated, absent, and failed results survive as distinct `board.read` answers.
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic, zero-spend specs use `modelFreeEnv`; this runs a REAL `claude` turn on the
// reviewer's own subscription, drafting five lenses. Opt-in, a cost switch not a gate:
// `RENNET_LIVE_E2E=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts board-drafting-live`.
test.skip(process.env.RENNET_LIVE_E2E !== "1", "live harness spec — set RENNET_LIVE_E2E=1");

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

test("LIVE: all five lens outcomes render and survive an app and daemon restart", async () => {
  test.setTimeout(900_000);
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
    const generation = generationIdForPatchset(loaded.review.activePatchsetId);
    const terminal = await waitForTerminalLenses(bridge, reviewId, generation);
    console.log("LENS TERMINALS:", JSON.stringify([...terminal.entries()], null, 2));
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

    bridge.close();
    bridge = undefined;
    await launched.application.close();
    launched = await launchRennet({ repository, userData, home, env: liveEnv(false) });
    page = await launched.application.firstWindow();
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, reviewId);
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    bridge = await connect(page);
    const reconstructed = await waitForTerminalLenses(bridge, reviewId, generation);

    expect([...reconstructed.entries()]).toEqual([...terminal.entries()]);
    expectOptionalEmptyLensesHonest(reconstructed);
    await expectTerminalLensesRendered(page, reconstructed);
  } finally {
    bridge?.close();
    await launched.application.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
