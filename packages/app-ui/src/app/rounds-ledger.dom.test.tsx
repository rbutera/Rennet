// @vitest-environment happy-dom
//
// The rounds ledger (C09 cluster 6, task 6.3). Driven through the real `ReviewWorkspace`
// over a completed-round rounds source + the fixture board source. Load-bearing claims:
//   - `?view=rounds` renders the ledger and its selected round's report;
//   - rounds list newest-first, and selecting a row renders that round's report;
//   - the round's FROZEN generation is reachable through C5's `GenerationSwitcher`;
//   - a `?view=rounds` deep-link with NO completed round falls back to the board.
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BoardSourceProvider } from "../board/board-data";
import { BridgeProvider } from "../data";
import type { RoundsSource } from "../rounds/rounds-data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount } from "../test/dom";
import { fixtureBoardSource } from "../test/fixtures/boards";
import {
  completedRoundRecord,
  FIXTURE_REPORT_BOARDS,
  fixtureCompletedRoundsSource,
} from "../test/fixtures/rounds";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

const review = {
  id: "led-1",
  activePatchsetId: "ps-1",
  repositoryRoot: "/home/dev/rennet",
} as unknown as Review;

afterEach(() => act(() => store().runActions.resetRun()));

/** Mount the workspace at `path` over a rounds source (default: one completed round) and
 *  the fixture board source (which carries gen1 + gen2). */
function renderWorkspace(path: string, source?: RoundsSource) {
  const history = memoryHistory(path);
  const r = mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <BoardSourceProvider value={fixtureBoardSource}>
          {source ? (
            <RoundsSourceProvider value={source}>
              <ReviewWorkspace review={review} />
            </RoundsSourceProvider>
          ) : (
            <ReviewWorkspace review={review} />
          )}
        </BoardSourceProvider>
      </Router>
    </BridgeProvider>,
  );
  return { r, history };
}

describe("the rounds ledger (C09 cluster 6)", () => {
  it("renders the ledger and its selected round's report at ?view=rounds", () => {
    const { r } = renderWorkspace("/s/s-1?view=rounds", fixtureCompletedRoundsSource);
    expect(r.container.querySelector('[data-screen="rounds-ledger"]')).not.toBeNull();
    // One row for the completed round…
    expect(r.container.querySelector('[data-round="1"]')).not.toBeNull();
    // …and its report renders beneath (the shared RoundReportBoard + its derived tally).
    expect(r.container.querySelector('[data-kind="round-report"]')).not.toBeNull();
    expect(r.getByTestId("report-tally").textContent).toContain("addressed");
  });

  it("lists rounds newest-first and renders the selected row's report", async () => {
    // Two rounds (same report board) — newest (round 2) leads and is selected on open.
    const twoRounds: RoundsSource = {
      roundState: () => ({ phase: "absent" }),
      roundRecords: () => [completedRoundRecord, completedRoundRecord],
      reportBoard: (id) => FIXTURE_REPORT_BOARDS[id],
    };
    const { r } = renderWorkspace("/s/s-1?view=rounds", twoRounds);

    const rows = r.container.querySelectorAll('[data-testid="rounds-ledger-rows"] [data-round]');
    expect([...rows].map((el) => el.getAttribute("data-round"))).toEqual(["2", "1"]);
    // Newest is current on open; selecting round 1 moves the selection (and keeps a report).
    expect(r.container.querySelector('[data-round="2"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
    await r.user.click(r.container.querySelector('[data-round="1"]') as HTMLElement);
    expect(r.container.querySelector('[data-round="1"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(r.container.querySelector('[data-kind="round-report"]')).not.toBeNull();
  });

  it("reaches the round's frozen generation through the generation switcher", async () => {
    const { r } = renderWorkspace("/s/s-1?view=rounds", fixtureCompletedRoundsSource);
    // The switcher is present with the frozen (gen1) predecessor alongside the live (gen2).
    const switcher = r.container.querySelector('[data-kind="generation-switcher"]');
    expect(switcher).not.toBeNull();
    const frozenTab = switcher?.querySelector('[data-generation="gen1"][data-frozen="true"]');
    expect(frozenTab).not.toBeNull();
    // Drilling to it renders the frozen generation's board — reachable, not just labelled.
    await r.user.click(frozenTab as HTMLElement);
    expect(r.container.querySelector('article[data-generation="gen1"]')).not.toBeNull();
  });

  it("falls back to the board on a ?view=rounds deep-link with no completed round", () => {
    // No rounds source ⇒ the honest-absent default ⇒ empty ledger ⇒ fall back to the board.
    const { r } = renderWorkspace("/s/s-1?view=rounds");
    expect(r.container.querySelector('[data-screen="rounds-ledger"]')).toBeNull();
    expect(r.container.querySelector('[data-kind="lens-board-view"]')).not.toBeNull();
  });
});

describe("the round-diff link resolves the SELECTED round, never silently the latest (finding 2)", () => {
  // A producer-shaped landed round: the worker minted `gen`, and the round reported against it,
  // so `mintedPatchsetGeneration === boardGeneration` (server/src/runtime/rounds.ts:319).
  const landedRound = (gen: string): RoundRecord => ({
    asksDispatched: ["ask-1"],
    workerCommitRange: { from: "commit-from", to: "commit-to" },
    mintedPatchsetGeneration: gen,
    boardGeneration: gen,
    reportBoard: "report-round-1",
  });

  // A review whose ACTIVE patchset carries a recognizable file — if the link regressed to
  // "latest", this filename would render in the diff surface. It must not.
  const reviewWithPatchset = {
    id: "led-diff",
    activePatchsetId: "ps-latest",
    repositoryRoot: "/home/dev/rennet",
    patchsets: [
      {
        id: "ps-latest",
        files: [
          {
            path: "LATEST_PATCHSET_MARKER.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            binary: false,
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
        ],
      },
    ],
  } as unknown as Review;

  it("clicking an older round's Round-diff carries ITS generation and shows no latest diff", async () => {
    const twoRounds: RoundsSource = {
      roundState: () => ({ phase: "absent" }),
      roundRecords: () => [landedRound("g1"), landedRound("g2")], // oldest→newest
      reportBoard: (id) => FIXTURE_REPORT_BOARDS[id],
    };
    const history = memoryHistory("/s/s-1?view=rounds");
    const r = mount(
      <BridgeProvider bridge={new MemoryBridge({})}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <BoardSourceProvider value={fixtureBoardSource}>
            <RoundsSourceProvider value={twoRounds}>
              <ReviewWorkspace review={reviewWithPatchset} />
            </RoundsSourceProvider>
          </BoardSourceProvider>
        </Router>
      </BridgeProvider>,
    );

    // Select the OLDER round (round 1 = g1), then follow its Round-diff link.
    await r.user.click(r.container.querySelector('[data-round="1"]') as HTMLElement);
    const link = r.getByTestId("round-diff-link");
    expect(link.getAttribute("data-round-generation")).toBe("g1"); // the selected round's identity
    await r.user.click(link);

    // The URL carries the round's generation, and the diff surface is the honest round-diff
    // state for g1 — NOT the latest patchset (its marker file must be absent).
    expect(history.history.at(-1)).toContain("round=g1");
    const pending = r.container.querySelector('[data-testid="round-diff-pending"]');
    expect(pending?.getAttribute("data-round-generation")).toBe("g1");
    expect(r.container.textContent).not.toContain("LATEST_PATCHSET_MARKER.ts");
  });
});
