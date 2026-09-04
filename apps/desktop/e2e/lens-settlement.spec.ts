import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import {
  generationIdForPatchset,
  type LensAbsenceReason,
  type LensBoard,
  type LensKind,
} from "@rennet/protocol";
import {
  LENS_SETTLEMENT_FLAGGED_FINDING,
  LENS_SETTLEMENT_FLAGGED_SECTION,
  LENS_SETTLEMENT_GENERATED,
  LENS_SETTLEMENT_GENERATED_SENTINEL,
  LENS_SETTLEMENT_SEQUENCE_STEP,
  LENS_SETTLEMENT_SOURCE,
  LENS_SETTLEMENT_SOURCE_SENTINEL,
  type ScriptedNoiseSettlement,
  writeLensSettlementScriptedHarnessPlan,
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
import { startTestDaemon } from "./scripted-daemon";

// ─────────────────────────────────────────────────────────────────────────────
// The launched-app LENS SETTLEMENT proofs (#548 / #549), HERMETIC: the real app, the
// real daemon, the real board service and the real pipeline, with a scripted harness
// plan standing in for the provider seats. No `claude`, no `codex`, no network.
//
// What each proves, and what it cannot:
//
//   #548 — Sequence and Decisions settle populated boards and their anchors are hydrated
//   through `patchset.readSpan`, which serves from the captured patchset's own patch text
//   and refuses a span it does not hold, so a hydrated anchor is the reviewer's own
//   navigation, performed. Flagged carries the reference half: both seats answer the one
//   plan, so they raise the same finding at the same location, the reconciler collapses
//   one into the other, and the collapsed finding's section is left citing an id the
//   merged board no longer holds. That happens AFTER lint (lint resolves references in
//   the draft it sees; the merge runs later), so the board service would reject the whole
//   write. A Flagged board on screen means the merge repointed the citer.
//
//   An in-draft dangling reference is NOT what this exercises: lint catches that one and
//   the ladder settles it long before the write boundary. The write-boundary admission
//   pass itself is proven against the real board service in
//   `packages/server/src/runtime/lens-pipeline.test.ts`.
//
//   #549 — the Noise seat either draws a real skip-safe group or emits the empty board
//   that is its honest "nothing here is skippable". The first settles a populated board;
//   the second settles the `no-noise` absence, and the window renders it as a successful
//   result rather than a failure or an eternal "no board yet".
//
// What this does NOT prove: that a REAL provider seat draws these boards. That leg needs
// a real-harness run and Rai's consent to spend it; it is written but unrun in
// `board-drafting-live.spec.ts` behind `RENNET_LIVE_E2E=1`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reviewed repository for one leg.
 *
 * `populated` has both halves the noisy proof needs: a substantive edit to the reviewed
 * source, and generated output beside it for the Noise lane to own. `no-noise` is SOURCE
 * ONLY — no generated file was ever committed, so the change genuinely contains nothing
 * skip-safe. Running the signal-only leg over the noisy repository proved only that the
 * script had been told to answer empty; the absence has to be true of the change.
 *
 * Each file carries its own sentinel on the cited line, so a hydrated span names WHICH
 * file it came from rather than matching a word both files share.
 */
function seedSettlementRepo(noise: ScriptedNoiseSettlement): string {
  const repository = makeTempDir("rennet-e2e-settlement-repo-");
  const source = (value: string) =>
    `export const ${LENS_SETTLEMENT_SOURCE_SENTINEL} = '${value}';\n`;
  const generated = (value: string) => `{ "${LENS_SETTLEMENT_GENERATED_SENTINEL}": "${value}" }\n`;
  initRepo(repository);
  writeRepoFile(repository, ".gitignore", ".rennet/\n");
  writeRepoFile(repository, LENS_SETTLEMENT_SOURCE, source("base"));
  if (noise === "populated") {
    writeRepoFile(repository, LENS_SETTLEMENT_GENERATED, generated("base"));
  }
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  git(repository, "checkout", "-qb", "feature/settlement");
  writeRepoFile(repository, LENS_SETTLEMENT_SOURCE, source("reviewed"));
  if (noise === "populated") {
    writeRepoFile(repository, LENS_SETTLEMENT_GENERATED, generated("reviewed"));
  }
  return repository;
}

interface BoardReadResult {
  readonly board: LensBoard | null;
  readonly absence?: LensAbsenceReason;
  readonly failure?: string;
}

async function bridgeFor(page: Page): Promise<WsRennetBridge> {
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  return new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
}

/** Capture the repository through the app's own daemon and open its review route. */
async function captureReview(page: Page, repository: string): Promise<string> {
  const bridge = await bridgeFor(page);
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

/** Poll one lens until it has a durable terminal result (board, absence, or failure). */
async function settledLens(
  bridge: WsRennetBridge,
  reviewId: string,
  generation: string,
  lens: LensKind,
): Promise<BoardReadResult> {
  let latest: BoardReadResult = { board: null };
  await expect
    .poll(
      async () => {
        latest = (await bridge.invoke("board.read", {
          reviewId,
          generation,
          lens,
        })) as BoardReadResult;
        if (latest.board !== null) return "board";
        if (latest.absence !== undefined) return "absence";
        return latest.failure === undefined ? "pending" : "failure";
      },
      { timeout: 180_000, intervals: [250, 500, 1_000] },
    )
    .not.toBe("pending");
  return latest;
}

interface SettlementRun {
  readonly page: Page;
  readonly bridge: WsRennetBridge;
  readonly reviewId: string;
  readonly patchsetId: string;
  readonly generation: string;
}

/** Launch the app against a scripted daemon, capture the fixture, and hand back the seam. */
async function runSettlement(
  noise: ScriptedNoiseSettlement,
  inspect: (run: SettlementRun) => Promise<void>,
): Promise<void> {
  const repository = seedSettlementRepo(noise);
  // The fixture, not the script, decides whether this change has churn to skip.
  expect(
    existsSync(join(repository, LENS_SETTLEMENT_GENERATED)),
    "the signal-only leg must review a source-only change",
  ).toBe(noise === "populated");
  const userData = makeTempDir("rennet-e2e-settlement-state-");
  const home = makeTempDir("rennet-e2e-settlement-home-");
  const { planPath } = writeLensSettlementScriptedHarnessPlan(userData, noise);
  // Both providers from the one plan: the Flagged lens is the council's only dual seat,
  // and its merge is what produces the post-lint reference shape under test.
  const daemon = await startTestDaemon({ userData, home, planPath, dualSeat: true });
  const launched = await launchRennet({
    repository,
    userData,
    home,
    env: modelFreeEnv(home),
  });
  let bridge: WsRennetBridge | undefined;
  try {
    const page = await launched.application.firstWindow();
    await completeWelcome(page);
    const reviewId = await captureReview(page, repository);
    await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 60_000 });
    bridge = await bridgeFor(page);
    const loaded = await bridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId,
    });
    const patchsetId = loaded.review.activePatchsetId;
    await inspect({
      page,
      bridge,
      reviewId,
      patchsetId,
      generation: generationIdForPatchset(patchsetId),
    });
  } finally {
    bridge?.close();
    await launched.application.close();
    daemon.kill("SIGTERM");
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("Sequence and Decisions settle with anchors into the captured patchset (#548)", async () => {
  test.setTimeout(300_000);
  await runSettlement("populated", async ({ page, bridge, reviewId, generation, patchsetId }) => {
    const sequence = await settledLens(bridge, reviewId, generation, "sequence");
    expect(sequence.failure, "Sequence failed instead of settling a board").toBeUndefined();
    const board = sequence.board;
    if (board === null) throw new Error("Sequence settled without a board");

    const step = board.elements.find((element) => element.kind === "order_step");
    expect(step?.data.title).toBe(LENS_SETTLEMENT_SEQUENCE_STEP);

    // The anchor NAVIGATES: `patchset.readSpan` serves the cited lines from the captured
    // patchset's own patch text and refuses a span it does not hold.
    const cited = board.elements.find(
      (element) => element.kind === "code_ref" && element.id === step?.data.span,
    );
    if (cited?.kind !== "code_ref") throw new Error("the repaired span names no code_ref");
    // The seat never sends a patchset id — the host stamps it once, on the board it
    // persists — so this is the one place the proof can see that it was stamped at all.
    expect(cited.data.patchset_id).toBe(patchsetId);
    const hydrated = await bridge.invoke("patchset.readSpan", {
      patchsetId,
      path: cited.data.path,
      side: cited.data.side,
      startLine: cited.data.start_line,
      endLine: cited.data.end_line,
    });
    // The SOURCE file's own sentinel, which appears in no other file of this fixture —
    // "settlement" alone is in the path, the generated table and the branch name, so it
    // would pass on content served from the wrong file.
    expect(cited.data.path).toBe(LENS_SETTLEMENT_SOURCE);
    expect(hydrated.lines.join("\n")).toContain(LENS_SETTLEMENT_SOURCE_SENTINEL);
    expect(hydrated.lines.join("\n")).not.toContain(LENS_SETTLEMENT_GENERATED_SENTINEL);

    // Wrong-span control, INSIDE the same held patchset: the other changed file of this
    // very capture serves its own line, so the assertion above is about the span that was
    // cited and not about "this patchset returns something".
    const otherFile = await bridge.invoke("patchset.readSpan", {
      patchsetId,
      path: LENS_SETTLEMENT_GENERATED,
      side: "head",
      startLine: 1,
      endLine: 1,
    });
    expect(otherFile.lines.join("\n")).toContain(LENS_SETTLEMENT_GENERATED_SENTINEL);
    expect(otherFile.lines.join("\n")).not.toContain(LENS_SETTLEMENT_SOURCE_SENTINEL);

    // Positive control: the same span against a patchset the daemon does not hold is
    // refused BY NAME — the message names the missing patchset, so a reader can tell this
    // refusal from "that file is not in the capture" or a generic read failure.
    await expect(
      bridge.invoke("patchset.readSpan", {
        patchsetId: `${patchsetId}-absent-control`,
        path: cited.data.path,
        side: cited.data.side,
        startLine: cited.data.start_line,
        endLine: cited.data.end_line,
      }),
    ).rejects.toThrow(`patchset ${patchsetId}-absent-control`);

    // Decisions settles its own board on the same generation — the second core reading
    // surface #548's acceptance names.
    const decisions = await settledLens(bridge, reviewId, generation, "decisions");
    expect(decisions.failure).toBeUndefined();
    expect(
      decisions.board?.elements.some((element) => element.kind === "decision"),
      "Decisions settled without a decision",
    ).toBe(true);

    // Both are readable in the window, not merely over the wire.
    await page.locator('[data-kind="lens-switcher"] [data-lens="sequence"]').click();
    await expect(page.locator('[data-kind="board-failed"]')).toHaveCount(0);
    await expect(page.locator('[data-kind="lens-board-view"]')).toContainText("Settlement");
  });
});

test("the dual-seat merge's collapsed finding is repointed, so Flagged is writable (#548)", async () => {
  test.setTimeout(300_000);
  await runSettlement("populated", async ({ bridge, reviewId, generation }) => {
    const flagged = await settledLens(bridge, reviewId, generation, "flagged");
    // Before the merge repointed its citer, this write was rejected wholesale by the
    // board service and the reviewer got a failed lens instead of the finding.
    expect(flagged.failure, "Flagged failed instead of settling the merged board").toBeUndefined();
    const board = flagged.board;
    if (board === null) throw new Error("Flagged settled without a board");

    // Two seats, one location: the findings collapsed into a single row.
    const findings = board.elements.filter((element) => element.kind === "finding");
    expect(findings).toHaveLength(1);
    const survivor = findings[0];
    if (survivor === undefined) throw new Error("Flagged settled with no finding");

    // The collapsed seat's section still names a finding — the SURVIVING one. A section
    // citing the consumed id is exactly the `bad-ref` the service refuses.
    const section = board.elements.find(
      (element) =>
        element.kind === "section" && element.id.endsWith(LENS_SETTLEMENT_FLAGGED_SECTION),
    );
    if (section?.kind !== "section") throw new Error("Flagged settled with no section");
    expect(section.data.children).toContain(survivor.id);
    // The consumed id is gone from the board, so nothing may still cite it.
    const liveIds = new Set(board.elements.map((element) => element.id));
    for (const child of section.data.children) expect(liveIds.has(child)).toBe(true);
    expect(survivor.id.endsWith(LENS_SETTLEMENT_FLAGGED_FINDING)).toBe(true);
  });
});

test("Noise settles a board on skip-safe churn and no-noise on a signal-only change (#549)", async () => {
  test.setTimeout(300_000);
  // The CONTROL for the signal-only leg below: the same seat, over a change that really
  // does carry generated churn, must draw a verdict board. Without it, "no board" would
  // read as a settlement in both directions.
  await runSettlement("populated", async ({ bridge, reviewId, generation }) => {
    const noise = await settledLens(bridge, reviewId, generation, "noise");
    expect(noise.failure, "Noise failed on a change with skip-safe churn").toBeUndefined();
    expect(noise.absence).toBeUndefined();
    const verdicts = noise.board?.elements.filter((element) => element.kind === "noise_verdict");
    expect(verdicts?.length, "Noise settled a board with no verdict on it").toBeGreaterThan(0);
  });

  // The signal-only leg reviews a SOURCE-ONLY repository (see `seedSettlementRepo`): the
  // change contains nothing skip-safe, so the empty board the seat returns is a true
  // report about this change rather than the script answering empty over generated churn.
  await runSettlement("no-noise", async ({ page, bridge, reviewId, generation }) => {
    const noise = await settledLens(bridge, reviewId, generation, "noise");
    // A SUCCESS, not a failure and not an eternal "no board yet": the seat ran and
    // honestly reported that nothing in the change is safely skippable.
    expect(noise.failure, `Noise failed instead of settling no-noise: ${noise.failure}`).toBe(
      undefined,
    );
    expect(noise.board).toBeNull();
    expect(noise.absence).toBe("no-noise");

    // The window says so in the reviewer's own words, on a lens tab that stays reachable.
    const tab = page.locator('[data-kind="lens-switcher"] [data-lens="noise"]');
    await expect(tab).toHaveAttribute("data-absent", "no-noise");
    await tab.click();
    await expect(page.locator('[data-kind="board-absent"]')).toContainText(
      "No safely skippable noise was found.",
    );
    await expect(page.locator('[data-kind="board-failed"]')).toHaveCount(0);
    await expect(page.locator('[data-kind="board-empty"]')).toHaveCount(0);
  });
});
