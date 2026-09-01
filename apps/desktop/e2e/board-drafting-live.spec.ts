import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import {
  fallbackBoardDocument,
  generationIdForPatchset,
  LENS_KINDS,
  type LensAbsenceReason,
  type LensBoard,
  type LensKind,
  type RoundEvent,
  type RoundOperationProgressState,
} from "@rennet/protocol";
import { findHealthyDaemon, readDaemonFile } from "@rennet/server";
import {
  completeWelcome,
  git,
  initRepo,
  launchRennet,
  makeTempDir,
  seedReviewRepo,
  writeRepoFile,
} from "./harness";

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
// restart it dispatches one real request-change round, stops the daemon as soon as the verified
// report becomes readable while lenses are still running, and requires the same report plus the
// eventual successor generation after recovery. A green run closes the owner's read -> ask ->
// round -> reread loop without substituting a mock for the daemon, worker, or lens pipeline.
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

const CORE_KIND_BY_LENS: Partial<
  Readonly<Record<LensKind, LensBoard["elements"][number]["kind"]>>
> = {
  sequence: "order_step",
  decisions: "decision",
  flagged: "finding",
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

interface PageExitDiagnostic {
  readonly label: string;
  readonly kind: "close" | "crash";
}

interface PageDiagnostics {
  readonly exit: () => PageExitDiagnostic | undefined;
}

interface ObservedRoundEvent {
  readonly event: RoundEvent;
  readonly observedAt: number;
}

function rememberRoundEvents(
  observations: ObservedRoundEvent[],
  events: readonly RoundEvent[],
): void {
  const observedAt = Date.now();
  for (const event of events) observations.push({ event, observedAt });
}

function observeRoundEvents(
  bridge: WsRennetBridge,
  reviewId: string,
  observations: ObservedRoundEvent[],
): () => void {
  return bridge.onRoundProgress(reviewId, (event) => {
    observations.push({ event, observedAt: Date.now() });
  });
}

function firstObservedOperationPhase(
  observations: readonly ObservedRoundEvent[],
  operationId: string,
  phase: RoundOperationProgressState["phase"],
): number | undefined {
  return observations.find(
    ({ event }) =>
      event.type === "operation" &&
      event.snapshot.operationId === operationId &&
      event.snapshot.state.phase === phase,
  )?.observedAt;
}

function firstObservedTerminalLenses(
  observations: readonly ObservedRoundEvent[],
  operationId: string,
): number | undefined {
  return observations.find(
    ({ event }) =>
      event.type === "lens" &&
      event.operationId === operationId &&
      event.lanes.every(
        (lane) => lane.status === "done" || lane.status === "absent" || lane.status === "failed",
      ),
  )?.observedAt;
}

function elapsedMs(startedAt: number, observedAt: number | undefined): number | null {
  return observedAt === undefined ? null : observedAt - startedAt;
}

function attachPageDiagnostics(page: Page, label: string): PageDiagnostics {
  let observedExit: PageExitDiagnostic | undefined;
  const reportExit = (kind: PageExitDiagnostic["kind"]): void => {
    if (observedExit !== undefined) return;
    observedExit = { label, kind };
    console.log(`[page:${label}:${kind}] ${page.url()}`);
  };
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log(`[renderer:${label}:error] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    console.log(`[renderer:${label}:pageerror] ${error.message}`);
  });
  page.on("crash", () => reportExit("crash"));
  page.on("close", () => reportExit("close"));
  if (page.isClosed()) reportExit("close");
  return { exit: () => observedExit };
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
      const requiredKind = CORE_KIND_BY_LENS[lens];
      if (requiredKind !== undefined) {
        const rendered = board.locator(`[data-kind="${requiredKind}"]`);
        const sections = board.locator('[data-kind="board-section"]');
        for (let index = 0; index < (await sections.count()); index += 1) {
          if ((await rendered.count()) > 0 && (await rendered.first().isVisible())) break;
          const section = sections.nth(index);
          if ((await section.getAttribute("data-open")) === "false") {
            await section.locator('button[aria-expanded="false"]').first().click();
          }
        }
        await expect(
          rendered.first(),
          `${lens} must visibly render a reachable ${requiredKind}`,
        ).toBeVisible();
      }
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

function hasReachableKind(
  board: LensBoard,
  requiredKind: LensBoard["elements"][number]["kind"],
): boolean {
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    const element = byId.get(id);
    if (element === undefined) return false;
    if (element.kind === requiredKind) return true;
    if (element.kind !== "section" && element.kind !== "order_step") return false;
    return element.data.children.some(visit);
  };
  return board.sections.some((section) => visit(section.ref));
}

function expectCoreUsefulGeneration(terminal: ReadonlyMap<LensKind, TerminalLensEvidence>): void {
  const sequence = terminal.get("sequence");
  expect(sequence?.kind, "Sequence must be a populated board").toBe("board");
  if (sequence?.kind === "board") {
    expect(
      hasReachableKind(sequence.board, "order_step"),
      "Sequence must contain a real reading-order step, not filler prose",
    ).toBe(true);
  }

  const optionalCoreLenses = [
    ["decisions", "no-decisions", "decision"],
    ["flagged", "no-findings", "finding"],
  ] as const satisfies readonly (readonly [
    LensKind,
    LensAbsenceReason,
    LensBoard["elements"][number]["kind"],
  ])[];
  for (const [lens, expectedAbsence, requiredKind] of optionalCoreLenses) {
    const evidence = terminal.get(lens);
    if (evidence?.kind === "absence") {
      expect(evidence.reason, `${lens} must use its typed empty state`).toBe(expectedAbsence);
      continue;
    }
    expect(evidence?.kind, `${lens} must be a populated board or its typed empty state`).toBe(
      "board",
    );
    if (evidence?.kind === "board") {
      expect(
        hasReachableKind(evidence.board, requiredKind),
        `${lens} must contain a real ${requiredKind}, not filler prose`,
      ).toBe(true);
    }
  }
}

function populatedBoardEvidence(
  lens: LensKind,
  options: { readonly semantic?: boolean; readonly reachable?: boolean } = {},
): TerminalLensEvidence {
  const semantic = options.semantic ?? true;
  const reachable = options.reachable ?? true;
  const author = { kind: "lens-agent" as const, id: "oracle-control" };
  let leaf: LensBoard["elements"][number];
  if (!semantic || lens === "design" || lens === "noise") {
    leaf = {
      id: `${lens}-content`,
      kind: "prose",
      data: { author, markdown: `${lens} content` },
    };
  } else if (lens === "sequence") {
    leaf = {
      id: "sequence-step",
      kind: "order_step",
      data: { author, title: "Read the changed path", span: "control-span", children: [] },
    };
  } else if (lens === "decisions") {
    leaf = {
      id: "decision",
      kind: "decision",
      data: {
        author,
        statement: "Keep the operation durable",
        evidence: [],
        alternatives: ["Keep it process-local"],
        why: "The result must survive restart.",
      },
    };
  } else {
    leaf = {
      id: "finding",
      kind: "finding",
      data: {
        author,
        severity: "high",
        concern: "The result disappears after restart.",
        code: [],
        concurrence: [],
        status: "open",
      },
    };
  }
  const root: LensBoard["elements"][number] = {
    id: `${lens}-root`,
    kind: "section",
    data: { author, title: "Review", children: [leaf.id] },
  };
  const elements: LensBoard["elements"] = reachable ? [root, leaf] : [leaf];
  const sections: LensBoard["sections"] = reachable
    ? [{ ref: root.id, gist: "Review", counts: {} }]
    : [];
  return {
    kind: "board",
    board: {
      lens,
      generation: "gen:oracle-control",
      boardId: `board-${lens}`,
      document: fallbackBoardDocument(lens),
      sections,
      elements,
      skippedHunks: [],
    },
  };
}

test("core lens oracle rejects noise-only results and accepts useful core boards", () => {
  const noiseOnly: ReadonlyMap<LensKind, TerminalLensEvidence> = new Map([
    ["design", { kind: "absence", reason: "no-material" }],
    ["sequence", populatedBoardEvidence("sequence", { semantic: false })],
    ["decisions", { kind: "absence", reason: "no-decisions" }],
    ["flagged", { kind: "absence", reason: "no-findings" }],
    ["noise", populatedBoardEvidence("noise")],
  ]);
  expect(() => expectCoreUsefulGeneration(noiseOnly)).toThrow(
    "Sequence must contain a real reading-order step",
  );

  const coreUseful = new Map(noiseOnly);
  coreUseful.set("sequence", populatedBoardEvidence("sequence"));
  expect(() => expectCoreUsefulGeneration(coreUseful)).not.toThrow();

  const paddedDecisions = new Map(coreUseful);
  paddedDecisions.set("decisions", populatedBoardEvidence("decisions", { semantic: false }));
  expect(() => expectCoreUsefulGeneration(paddedDecisions)).toThrow(
    "decisions must contain a real decision",
  );

  const paddedFlagged = new Map(coreUseful);
  paddedFlagged.set("flagged", populatedBoardEvidence("flagged", { semantic: false }));
  expect(() => expectCoreUsefulGeneration(paddedFlagged)).toThrow(
    "flagged must contain a real finding",
  );

  const allCoreBoards = new Map(coreUseful);
  allCoreBoards.set("decisions", populatedBoardEvidence("decisions"));
  allCoreBoards.set("flagged", populatedBoardEvidence("flagged"));
  expect(() => expectCoreUsefulGeneration(allCoreBoards)).not.toThrow();

  const orphanSequence = new Map(coreUseful);
  orphanSequence.set("sequence", populatedBoardEvidence("sequence", { reachable: false }));
  expect(() => expectCoreUsefulGeneration(orphanSequence)).toThrow(
    "Sequence must contain a real reading-order step",
  );
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
  pageDiagnostics: PageDiagnostics,
  observations: ObservedRoundEvent[],
): Promise<void> {
  const assertPageStayedOpen = (): void => {
    const exit = pageDiagnostics.exit();
    if (exit !== undefined) {
      throw new Error(
        `${exit.label} page emitted ${exit.kind} while the successor round was running`,
      );
    }
  };
  await expect
    .poll(
      async () => {
        assertPageStayedOpen();
        const { events } = await bridge.invoke("session.roundEvents", { reviewId });
        rememberRoundEvents(observations, events);
        assertPageStayedOpen();
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

liveTest("LIVE: verified report and successor core boards survive daemon restarts", async () => {
  test.setTimeout(1_800_000);
  const repository = seedReviewRepo("board-live-repo-");
  const userData = makeTempDir("board-live-state-");
  const home = makeTempDir("board-live-home-");
  let launched = await launchRennet({ repository, userData, home, env: liveEnv(false) });
  let bridge: WsRennetBridge | undefined;
  let stopRoundObservation: (() => void) | undefined;
  let activeDaemonPid: number | undefined;
  try {
    let page = await launched.application.firstWindow();
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`[renderer:error] ${message.text()}`);
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
    expectCoreUsefulGeneration(terminal);
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
    activeDaemonPid = firstDaemonPid;
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
    activeDaemonPid = undefined;

    launched = await launchRennet({ repository, userData, home, env: liveEnv(false) });
    page = await launched.application.firstWindow();
    attachPageDiagnostics(page, "replacement");
    const replacementDaemonPid = await healthyDaemonPid(userData);
    activeDaemonPid = replacementDaemonPid;
    expect(replacementDaemonPid).not.toBe(firstDaemonPid);
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, reviewId);
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    bridge = await connect(page);
    const reconstructed = await waitForTerminalLenses(bridge, reviewId, generation);

    expect([...reconstructed.entries()]).toEqual([...terminal.entries()]);
    expectCoreUsefulGeneration(reconstructed);
    await expectTerminalLensesRendered(page, reconstructed);

    const beforeRoundDiff = gitOutput(repository, "diff", "--", REVIEWED_PATH);
    expect(beforeRoundDiff).toContain("+export const widget = 2;");
    const roundBridge = bridge;
    await roundBridge.invoke("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: ROUND_ASK_ID,
        anchor: `${REVIEWED_PATH}:1`,
        type: "request-change",
        body: `Replace the entire contents of ${REVIEWED_PATH} with exactly \`export const widget = 3;\` followed by one newline. Do not change any other file.`,
      },
    });
    const roundObservations: ObservedRoundEvent[] = [];
    stopRoundObservation = observeRoundEvents(roundBridge, reviewId, roundObservations);
    const dispatchedAt = Date.now();
    const dispatched = await roundBridge.invoke("round.dispatch", { reviewId });
    expect(dispatched.dispatched).toBe(true);
    expect(dispatched.acceptedOperation).toBeDefined();
    const operationId = dispatched.acceptedOperation?.operationId;
    if (operationId === undefined) throw new Error("round dispatch returned no operation identity");

    await page.evaluate((id) => {
      location.hash = `#/s/${id}/run`;
    }, reviewId);
    const run = page.locator('[data-screen="session-run"]');
    await expect(run).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () => {
          const { events } = await roundBridge.invoke("session.roundEvents", { reviewId });
          rememberRoundEvents(roundObservations, events);
          const report = events.findLast(
            (event) => event.type === "report" && event.operationId === operationId,
          );
          return report?.type === "report" &&
            report.operationId === operationId &&
            report.operationRevision !== undefined &&
            report.report !== undefined
            ? "verified"
            : "missing";
        },
        { timeout: 900_000, intervals: [250, 500, 1_000, 2_000] },
      )
      .toBe("verified");
    const reportEvents = await roundBridge.invoke("session.roundEvents", { reviewId });
    rememberRoundEvents(roundObservations, reportEvents.events);
    const verifiedReportEvent = reportEvents.events.findLast(
      (event) => event.type === "report" && event.operationId === operationId,
    );
    if (
      verifiedReportEvent?.type !== "report" ||
      verifiedReportEvent.operationId !== operationId ||
      verifiedReportEvent.operationRevision === undefined ||
      verifiedReportEvent.report === undefined
    ) {
      throw new Error("round did not expose its operation-scoped verified report");
    }
    const greeting = page.locator('[data-screen="round-greeting"]');
    await expect(greeting).toBeVisible({ timeout: 60_000 });
    const reportVisibleAt = Date.now();
    await expect(
      greeting.getByRole("button", { name: "View the New Boards", exact: true }),
    ).toHaveCount(0);
    const inFlightEvents = await roundBridge.invoke("session.roundEvents", { reviewId });
    rememberRoundEvents(roundObservations, inFlightEvents.events);
    expect(
      inFlightEvents.events.some(
        (event) =>
          event.type === "report" &&
          event.operationId === operationId &&
          event.reportBoardId === verifiedReportEvent.reportBoardId,
      ),
      "round greeting lost its operation-scoped verified report",
    ).toBe(true);
    expect(verifiedReportEvent.report.boardId).toBe(verifiedReportEvent.reportBoardId);
    await expect(greeting.locator('[data-kind="round-report"]')).toContainText(
      verifiedReportEvent.report.document.title,
    );
    const reportBoardId = verifiedReportEvent.reportBoardId;
    const reportOperationRevision = verifiedReportEvent.operationRevision;
    const newestInFlightLens = inFlightEvents.events.findLast(
      (event) => event.type === "lens" && event.operationId === operationId,
    );
    if (newestInFlightLens !== undefined) {
      if (newestInFlightLens.type !== "lens" || newestInFlightLens.operationId !== operationId) {
        throw new Error("latest same-attempt lens snapshot lost its operation identity");
      }
      expect(
        newestInFlightLens.lanes.some(
          (lane) =>
            lane.status === "queued" || lane.status === "running" || lane.status === "drafted",
        ),
        "the verified report must become visible before every lens reaches a terminal state",
      ).toBe(true);
    }
    const inFlightOperation = inFlightEvents.events.findLast(
      (event) => event.type === "operation" && event.snapshot.operationId === operationId,
    );
    if (inFlightOperation?.type !== "operation") {
      throw new Error("round greeting appeared without its durable operation snapshot");
    }
    expect(["report-drafting", "report-verifying"]).toContain(
      inFlightOperation.snapshot.state.phase,
    );

    const workerSettledAt = firstObservedOperationPhase(
      roundObservations,
      operationId,
      "worker-settled",
    );
    const reportEventObservedAt = roundObservations.find(
      ({ event }) =>
        event.type === "report" &&
        event.operationId === operationId &&
        event.reportBoardId === reportBoardId,
    )?.observedAt;
    expect(reportEventObservedAt).toBeDefined();
    expect(reportEventObservedAt).toBeLessThanOrEqual(reportVisibleAt);
    console.log(
      "ROUND TIMINGS (REPORT VISIBLE):",
      JSON.stringify({
        dispatchedAt,
        workerSettledAt: workerSettledAt ?? null,
        verifiedReportEventAt: reportEventObservedAt ?? null,
        reportVisibleAt,
        dispatchToWorkerSettledMs: elapsedMs(dispatchedAt, workerSettledAt),
        dispatchToVerifiedReportEventMs: elapsedMs(dispatchedAt, reportEventObservedAt),
        dispatchToReportVisibleMs: reportVisibleAt - dispatchedAt,
      }),
    );

    const preRestartEvents = await roundBridge.invoke("session.roundEvents", { reviewId });
    rememberRoundEvents(roundObservations, preRestartEvents.events);
    const newestPreRestartLens = preRestartEvents.events.findLast(
      (event) => event.type === "lens" && event.operationId === operationId,
    );
    if (newestPreRestartLens !== undefined) {
      if (
        newestPreRestartLens.type !== "lens" ||
        newestPreRestartLens.operationId !== operationId
      ) {
        throw new Error("pre-restart lens snapshot lost its operation identity");
      }
      expect(
        newestPreRestartLens.lanes.some(
          (lane) =>
            lane.status === "queued" || lane.status === "running" || lane.status === "drafted",
        ),
        "the daemon restart must interrupt lens regeneration before its terminal snapshot",
      ).toBe(true);
    }
    expect(firstObservedTerminalLenses(roundObservations, operationId)).toBeUndefined();

    stopRoundObservation();
    stopRoundObservation = undefined;
    roundBridge.close();
    bridge = undefined;
    await launched.application.close();
    await expect
      .poll(() => readDaemonFile(userData), { timeout: 30_000, intervals: [50, 100, 250] })
      .toBeNull();
    await expect
      .poll(() => processIsAlive(replacementDaemonPid), {
        timeout: 30_000,
        intervals: [50, 100, 250],
      })
      .toBe(false);
    activeDaemonPid = undefined;

    launched = await launchRennet({ repository, userData, home, env: liveEnv(false) });
    page = await launched.application.firstWindow();
    const resumedPageDiagnostics = attachPageDiagnostics(page, "resumed");
    const resumedDaemonPid = await healthyDaemonPid(userData);
    activeDaemonPid = resumedDaemonPid;
    expect(resumedDaemonPid).not.toBe(replacementDaemonPid);
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, reviewId);
    const resumedBridge = await connect(page);
    bridge = resumedBridge;
    stopRoundObservation = observeRoundEvents(resumedBridge, reviewId, roundObservations);
    await expect
      .poll(
        async () => {
          const { events } = await resumedBridge.invoke("session.roundEvents", { reviewId });
          rememberRoundEvents(roundObservations, events);
          const report = events.findLast(
            (event) => event.type === "report" && event.operationId === operationId,
          );
          return report?.type === "report" &&
            report.operationId === operationId &&
            report.operationRevision !== undefined &&
            report.report !== undefined
            ? report.reportBoardId
            : "missing";
        },
        { timeout: 120_000, intervals: [100, 250, 500, 1_000] },
      )
      .toBe(reportBoardId);
    const recoveredEvents = await resumedBridge.invoke("session.roundEvents", { reviewId });
    rememberRoundEvents(roundObservations, recoveredEvents.events);
    const recoveredReportEvent = recoveredEvents.events.findLast(
      (event) => event.type === "report" && event.operationId === operationId,
    );
    if (
      recoveredReportEvent?.type !== "report" ||
      recoveredReportEvent.operationId !== operationId ||
      recoveredReportEvent.operationRevision === undefined ||
      recoveredReportEvent.report === undefined
    ) {
      throw new Error("daemon restart lost the operation-scoped verified report");
    }
    expect(recoveredReportEvent.reportBoardId).toBe(reportBoardId);
    expect(recoveredReportEvent.operationRevision).toBeGreaterThanOrEqual(reportOperationRevision);
    expect(recoveredReportEvent.report).toEqual(verifiedReportEvent.report);
    const recoveredOperation = recoveredEvents.events.findLast(
      (event) => event.type === "operation" && event.snapshot.operationId === operationId,
    );
    if (recoveredOperation?.type !== "operation") {
      throw new Error("daemon restart lost the durable operation snapshot");
    }
    if (recoveredOperation.snapshot.state.phase === "failed") {
      throw new Error(
        `daemon restart terminalized the resumable round: ${JSON.stringify(recoveredOperation.snapshot.state.failure)}`,
      );
    }
    expect(["report-drafting", "report-verifying"]).toContain(
      recoveredOperation.snapshot.state.phase,
    );
    const resumedGreeting = page.locator('[data-screen="round-greeting"]');
    await expect(resumedGreeting).toBeVisible({ timeout: 60_000 });
    await expect(resumedGreeting.locator('[data-kind="round-report"]')).toContainText(
      recoveredReportEvent.report.document.title,
    );
    await expect(
      resumedGreeting.getByRole("button", { name: "View the New Boards", exact: true }),
    ).toHaveCount(0);
    await waitForReturnedRound(
      resumedBridge,
      reviewId,
      operationId,
      resumedPageDiagnostics,
      roundObservations,
    );
    await expect
      .poll(() => page.evaluate(() => location.hash), {
        timeout: 30_000,
        intervals: [50, 100, 250],
      })
      .toBe(`#/s/${reviewId}`);
    await expect(page.locator('[data-screen="session-run"]')).toHaveCount(0);
    await expect(resumedGreeting).toBeVisible({ timeout: 30_000 });

    const allLensesTerminalAt = firstObservedTerminalLenses(roundObservations, operationId);
    if (allLensesTerminalAt === undefined) {
      throw new Error("returned round has no operation-scoped terminal lens snapshot");
    }
    expect(reportVisibleAt).toBeLessThan(allLensesTerminalAt);
    console.log(
      "ROUND TIMINGS (TERMINAL):",
      JSON.stringify({
        dispatchedAt,
        workerSettledAt: workerSettledAt ?? null,
        reportVisibleAt,
        allLensesTerminalAt,
        dispatchToWorkerSettledMs: elapsedMs(dispatchedAt, workerSettledAt),
        dispatchToReportVisibleMs: reportVisibleAt - dispatchedAt,
        dispatchToAllLensesTerminalMs: allLensesTerminalAt - dispatchedAt,
        reportVisibleToAllLensesTerminalMs: allLensesTerminalAt - reportVisibleAt,
      }),
    );

    const asks = await resumedBridge.invoke("ask.read", { sessionId: reviewId });
    expect(asks.projection.stagedAsks[ROUND_ASK_ID]).toBeUndefined();
    const rounds = await resumedBridge.invoke("session.rounds", { reviewId });
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
    expect(successor.reportBoard).toBe(reportBoardId);
    expect(successor.report).toEqual(verifiedReportEvent.report);

    expect(readFileSync(join(repository, REVIEWED_PATH), "utf8")).toBe(
      "export const widget = 3;\n",
    );
    const afterRoundDiff = gitOutput(repository, "diff", "--", REVIEWED_PATH);
    expect(afterRoundDiff).toContain("+export const widget = 3;");

    const reloaded = await resumedBridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId,
    });
    expect(reloaded.review.activePatchsetId).toBe(successor.resultPatchsetId);
    expect(
      reloaded.review.patchsets.some((patchset) => patchset.id === successor.resultPatchsetId),
    ).toBe(true);
    const successorTerminal = await waitForTerminalLenses(
      resumedBridge,
      reviewId,
      successor.boardGeneration,
    );
    expectCoreUsefulGeneration(successorTerminal);

    await page.reload();
    await expect(resumedGreeting).toBeVisible({ timeout: 60_000 });
    await expect(resumedGreeting.locator('[data-kind="round-report"]')).toContainText(
      recoveredReportEvent.report.document.title,
    );
    const reveal = resumedGreeting.getByRole("button", {
      name: "View the New Boards",
      exact: true,
    });
    await expect(reveal).toBeVisible();
    await reveal.click();
    await expect(resumedGreeting).toHaveCount(0);
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    const selectedSuccessorGeneration = page.locator(
      `[data-kind="generation-switcher"] [data-generation="${successor.boardGeneration}"][aria-selected="true"]`,
    );
    await expect(selectedSuccessorGeneration).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(resumedGreeting).toHaveCount(0);
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    await expect(selectedSuccessorGeneration).toBeVisible({ timeout: 60_000 });
    await expectTerminalLensesRendered(page, successorTerminal);
  } finally {
    stopRoundObservation?.();
    bridge?.close();
    await launched.application.close().catch(() => undefined);
    await expect
      .poll(() => readDaemonFile(userData), {
        timeout: 30_000,
        intervals: [50, 100, 250],
      })
      .toBeNull();
    if (activeDaemonPid !== undefined) {
      const daemonPid = activeDaemonPid;
      await expect
        .poll(() => processIsAlive(daemonPid), {
          timeout: 30_000,
          intervals: [50, 100, 250],
        })
        .toBe(false);
    }
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #548 / #549 — the settlement proofs. The spec above proves the loop survives a
// restart on a one-line change; these two prove what each lens SETTLES on a change
// that actually has something to say, in the launched app, against the real harness.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A representative branch: a real judgement call with a viable alternative (so Decisions
 * has material), several files to read in an order (so Sequence has material), and a
 * bulk mechanical edit beside the substance (so Noise has material). Committed on the
 * feature branch AND left with a working-tree edit, the shape a captured review reads.
 */
function seedRepresentativeRepo(prefix: string): string {
  const repository = makeTempDir(prefix);
  initRepo(repository);
  writeRepoFile(
    repository,
    "src/tokens.ts",
    [
      "export interface Token {",
      "  value: string;",
      "  expiresAt: number;",
      "}",
      "",
      "export function isExpired(token: Token, now: number): boolean {",
      "  return token.expiresAt <= now;",
      "}",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    repository,
    "src/client.ts",
    [
      'import { isExpired, type Token } from "./tokens";',
      "",
      "export async function request(token: Token, now: number, send: () => Promise<number>) {",
      '  if (isExpired(token, now)) throw new Error("expired token");',
      "  return send();",
      "}",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    repository,
    "src/labels.ts",
    ["export const LABELS = {", "  a: 1,", "  b: 2,", "};", ""].join("\n"),
  );
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  git(repository, "checkout", "-qb", "feature/token-refresh");

  // SUBSTANCE — refresh-then-retry instead of failing fast. A judgement call with a
  // viable alternative (fail fast and let the caller re-authenticate).
  writeRepoFile(
    repository,
    "src/tokens.ts",
    [
      "export interface Token {",
      "  value: string;",
      "  expiresAt: number;",
      "  refresh?: () => Promise<Token>;",
      "}",
      "",
      "export function isExpired(token: Token, now: number): boolean {",
      "  return token.expiresAt <= now;",
      "}",
      "",
      "/** Refresh an expired token when it knows how to; otherwise hand it back unchanged. */",
      "export async function refreshed(token: Token, now: number): Promise<Token> {",
      "  if (!isExpired(token, now) || token.refresh === undefined) return token;",
      "  return token.refresh();",
      "}",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    repository,
    "src/client.ts",
    [
      'import { isExpired, refreshed, type Token } from "./tokens";',
      "",
      "export async function request(token: Token, now: number, send: () => Promise<number>) {",
      "  // We refresh before the call rather than failing fast, so a caller holding a",
      "  // stale token does not have to re-authenticate for a routine expiry.",
      "  const usable = await refreshed(token, now);",
      '  if (isExpired(usable, now)) throw new Error("expired token");',
      "  return send();",
      "}",
      "",
    ].join("\n"),
  );
  // MECHANICAL NOISE — a pure reindent/reorder of a constant table beside the substance.
  writeRepoFile(
    repository,
    "src/labels.ts",
    ["export const LABELS = {", "    b: 2,", "    a: 1,", "};", ""].join("\n"),
  );
  return repository;
}

/**
 * A mechanically noisy change: one small substantive edit beside generated-lockfile churn
 * and a mechanical rename across a file — the categories the Noise prompt names outright.
 */
function seedNoisyRepo(prefix: string): string {
  const repository = makeTempDir(prefix);
  initRepo(repository);
  const lock = (revision: number): string =>
    [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  .:",
      "    dependencies:",
      ...Array.from(
        { length: 40 },
        (_unused, index) => `      pkg-${index}:\n        version: 1.0.${revision}`,
      ),
      "",
    ].join("\n");
  writeRepoFile(repository, "pnpm-lock.yaml", lock(0));
  writeRepoFile(
    repository,
    "src/session-context.ts",
    [
      "export interface SessionContext {",
      "  id: string;",
      "}",
      "",
      "export function readSessionContext(context: SessionContext): string {",
      "  return context.id;",
      "}",
      "",
      "export function describeSessionContext(context: SessionContext): string {",
      "  return `session ${readSessionContext(context)}`;",
      "}",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    repository,
    "src/timeout.ts",
    ["export function timeoutMs(): number {", "  return 1_000;", "}", ""].join("\n"),
  );
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  git(repository, "checkout", "-qb", "feature/timeout");

  // NOISE 1 — regenerated lockfile: forty mechanical version bumps.
  writeRepoFile(repository, "pnpm-lock.yaml", lock(1));
  // NOISE 2 — a mechanical rename, SessionContext -> ScopedSession, nothing else.
  writeRepoFile(
    repository,
    "src/session-context.ts",
    [
      "export interface ScopedSession {",
      "  id: string;",
      "}",
      "",
      "export function readScopedSession(session: ScopedSession): string {",
      "  return session.id;",
      "}",
      "",
      "export function describeScopedSession(session: ScopedSession): string {",
      "  return `session ${readScopedSession(session)}`;",
      "}",
      "",
    ].join("\n"),
  );
  // SUBSTANCE — the one hunk that is not skip-safe.
  writeRepoFile(
    repository,
    "src/timeout.ts",
    [
      "export function timeoutMs(): number {",
      "  // Five seconds covers the slowest observed cold start.",
      "  return 5_000;",
      "}",
      "",
    ].join("\n"),
  );
  return repository;
}

/** A signal-only change: substance, and nothing mechanically skippable beside it. */
function seedSignalOnlyRepo(prefix: string): string {
  const repository = makeTempDir(prefix);
  initRepo(repository);
  writeRepoFile(
    repository,
    "src/retry.ts",
    ["export function attempts(): number {", "  return 1;", "}", ""].join("\n"),
  );
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  git(repository, "checkout", "-qb", "feature/retry-budget");
  writeRepoFile(
    repository,
    "src/retry.ts",
    [
      "export function attempts(): number {",
      "  // Three attempts covers a single transient failure without stacking latency.",
      "  return 3;",
      "}",
      "",
    ].join("\n"),
  );
  return repository;
}

/** Every `code_ref` on a settled board, in board order. */
function codeRefsOf(board: LensBoard): readonly {
  readonly patchset_id: string;
  readonly path: string;
  readonly side: "base" | "head";
  readonly start_line: number;
  readonly end_line: number;
}[] {
  return board.elements.flatMap((element) =>
    element.kind === "code_ref"
      ? [
          element.data as unknown as {
            patchset_id: string;
            path: string;
            side: "base" | "head";
            start_line: number;
            end_line: number;
          },
        ]
      : [],
  );
}

/**
 * Prove a board's anchors NAVIGATE: every citation names the captured patchset, and
 * hydrating it through `patchset.readSpan` returns the cited lines from that patchset's
 * own patch text. A span outside the captured diff is refused by name, so a hydrated
 * span IS the navigation the reviewer performs when they click the anchor.
 */
async function expectAnchorsNavigate(
  bridge: WsRennetBridge,
  board: LensBoard,
  patchsetId: string,
  label: string,
): Promise<number> {
  const refs = codeRefsOf(board);
  expect(refs.length, `${label} cited no code, so it anchors nothing`).toBeGreaterThan(0);
  for (const ref of refs) {
    expect(ref.patchset_id, `${label} cited a foreign patchset`).toBe(patchsetId);
    const span = await bridge.invoke("patchset.readSpan", {
      patchsetId,
      path: ref.path,
      side: ref.side,
      startLine: ref.start_line,
      endLine: ref.end_line,
    });
    expect(
      span.lines.length,
      `${label} anchor ${ref.path}:${ref.start_line}-${ref.end_line} hydrated no lines`,
    ).toBeGreaterThan(0);
  }
  return refs.length;
}

/** Capture one repository in a launched app and return every lens's terminal settlement. */
async function settleLensesInLaunchedApp(
  repository: string,
  prefix: string,
  inspect: (context: {
    readonly bridge: WsRennetBridge;
    readonly page: Page;
    readonly reviewId: string;
    readonly patchsetId: string;
    readonly terminal: ReadonlyMap<LensKind, TerminalLensEvidence>;
  }) => Promise<void>,
): Promise<void> {
  const userData = makeTempDir(`${prefix}-state-`);
  const home = makeTempDir(`${prefix}-home-`);
  const launched = await launchRennet({ repository, userData, home, env: liveEnv(false) });
  let bridge: WsRennetBridge | undefined;
  try {
    const page = await launched.application.firstWindow();
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`[renderer:error] ${message.text()}`);
    });
    await completeWelcome(page);
    const reviewId = await openCapturedReview(page, repository);
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    bridge = await connect(page);
    const loaded = await bridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId,
    });
    const patchsetId = loaded.review.activePatchsetId;
    const generation = generationIdForPatchset(patchsetId);
    const terminal = await waitForTerminalLenses(bridge, reviewId, generation);
    console.log(`${prefix} LENS TERMINALS:`, JSON.stringify([...terminal.entries()], null, 2));
    await expectTerminalLensesRendered(page, terminal);
    await inspect({ bridge, page, reviewId, patchsetId, terminal });
  } finally {
    bridge?.close();
    await launched.application.close();
  }
}

liveTest(
  "LIVE: a representative branch draws Sequence and Decisions with navigating anchors (#548)",
  async () => {
    test.setTimeout(1_800_000);
    await settleLensesInLaunchedApp(
      seedRepresentativeRepo("board-live-representative-repo-"),
      "board-live-representative",
      async ({ bridge, patchsetId, terminal }) => {
        for (const lens of ["sequence", "decisions"] as const) {
          const evidence = terminal.get(lens);
          expect(
            evidence?.kind,
            `${lens} settled ${evidence?.kind ?? "nothing"}: ${JSON.stringify(evidence)}`,
          ).toBe("board");
        }
        const sequence = terminal.get("sequence");
        const decisions = terminal.get("decisions");
        if (sequence?.kind !== "board" || decisions?.kind !== "board") {
          throw new Error("core boards did not settle as boards");
        }
        expect(hasReachableKind(sequence.board, "order_step")).toBe(true);
        expect(hasReachableKind(decisions.board, "decision")).toBe(true);
        // The anchors navigate into the CAPTURED patchset, not a working tree.
        const anchored =
          (await expectAnchorsNavigate(bridge, sequence.board, patchsetId, "Sequence")) +
          (await expectAnchorsNavigate(bridge, decisions.board, patchsetId, "Decisions"));
        console.log(`board-live-representative ANCHORS HYDRATED: ${anchored}`);
        // Positive control: the same spans against a patchset that does not exist are
        // refused BY NAME rather than hydrated from anywhere else — the message names the
        // missing patchset, so this refusal cannot be confused with an uncaptured file, an
        // uncaptured line, or a read that simply failed.
        const ref = codeRefsOf(sequence.board)[0];
        if (ref === undefined) throw new Error("Sequence cited no code to control against");
        await expect(
          bridge.invoke("patchset.readSpan", {
            patchsetId: `${patchsetId}-absent-control`,
            path: ref.path,
            side: ref.side,
            startLine: ref.start_line,
            endLine: ref.end_line,
          }),
        ).rejects.toThrow(`patchset ${patchsetId}-absent-control`);
      },
    );
  },
);

liveTest(
  "LIVE: Noise settles a board on a noisy change and no-noise on a signal-only one (#549)",
  async () => {
    test.setTimeout(1_800_000);
    await settleLensesInLaunchedApp(
      seedNoisyRepo("board-live-noisy-repo-"),
      "board-live-noisy",
      ({ terminal }) => {
        const noise = terminal.get("noise");
        expect(
          noise?.kind,
          `Noise settled ${noise?.kind ?? "nothing"} on a mechanically noisy change: ${JSON.stringify(noise)}`,
        ).toBe("board");
        if (noise?.kind !== "board") throw new Error("Noise did not settle a board");
        expect(
          noise.board.elements.some((element) => element.kind === "noise_verdict"),
          "Noise settled a board with no verdict on it",
        ).toBe(true);
        return Promise.resolve();
      },
    );

    await settleLensesInLaunchedApp(
      seedSignalOnlyRepo("board-live-signal-repo-"),
      "board-live-signal",
      async ({ terminal }) => {
        const noise = terminal.get("noise");
        // The absence is a SUCCESS, not a failure: the seat ran and honestly reported that
        // every changed hunk is on the substantive reading path.
        expect(
          noise?.kind,
          `Noise settled ${noise?.kind ?? "nothing"} on a signal-only change: ${JSON.stringify(noise)}`,
        ).toBe("absence");
        if (noise?.kind === "absence") expect(noise.reason).toBe("no-noise");
      },
    );
  },
);
