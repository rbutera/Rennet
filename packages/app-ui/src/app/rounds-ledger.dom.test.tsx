// @vitest-environment happy-dom
//
// The rounds ledger (C09 cluster 6, task 6.3). Driven through the real `ReviewWorkspace`
// over a completed-round rounds source + the fixture board source. Load-bearing claims:
//   - `?view=rounds` renders the ledger and its selected round's report;
//   - rounds list newest-first, and selecting a row renders that round's report;
//   - a producer-shaped `RoundRecord` carries a single generation, so the
//     `GenerationSwitcher` stays hidden (frozen-predecessor reachability is
//     parked as a B9 `RoundRecord` predecessor-field gap — see proposal F3);
//   - a `?view=rounds` deep-link with NO completed round falls back to the board.
import type { Review, RoundRecord } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import type { RoundsSource } from "../rounds/rounds-data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { fixtureBoardRead } from "../test/fixtures/boards";
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
    <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        {source ? (
          <RoundsSourceProvider value={source}>
            <ReviewWorkspace review={review} />
          </RoundsSourceProvider>
        ) : (
          <ReviewWorkspace review={review} />
        )}
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

  it("opens the round's own generation; the switcher stays hidden (no persisted predecessor)", async () => {
    // Finding 3: a PRODUCER-shaped `RoundRecord` carries one generation
    // (`boardGeneration === mintedPatchsetGeneration` for a landed round), and the frozen
    // predecessor is never persisted onto the record — so there is NO earlier generation id to
    // hand the switcher. The ledger opens the round's own boards (gen2), and the generation
    // switcher does not render. Frozen-predecessor reachability is parked pending a B9
    // `RoundRecord` predecessor field (C09 ledger, F3) — asserting a gen1 tab here would claim
    // a reachability production cannot deliver.
    const { r } = renderWorkspace("/s/s-1?view=rounds", fixtureCompletedRoundsSource);
    // The lens boards arrive over `board.read`, so wait out the in-flight read.
    await waitFor(() =>
      expect(r.container.querySelector('article[data-generation="gen2"]')).not.toBeNull(),
    );
    expect(r.container.querySelector('[data-kind="generation-switcher"]')).toBeNull();
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
      <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <RoundsSourceProvider value={twoRounds}>
            <ReviewWorkspace review={reviewWithPatchset} />
          </RoundsSourceProvider>
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
