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

  it("a single-generation round opens its own boards and offers NO drill-down (C15 4.4)", () => {
    // `completedRoundRecord` carries no `frozenPredecessor` — a first-generation round really
    // has no distinct earlier generation. The ledger opens the round's own boards (gen2) and
    // the switcher does not render: honest absence, not a fabricated gen1 tab.
    const { r } = renderWorkspace("/s/s-1?view=rounds", fixtureCompletedRoundsSource);
    expect(r.container.querySelector('article[data-generation="gen2"]')).not.toBeNull();
    expect(r.container.querySelector('[data-kind="generation-switcher"]')).toBeNull();
  });

  it("falls back to the board on a ?view=rounds deep-link with no completed round", () => {
    // No rounds source ⇒ the honest-absent default ⇒ empty ledger ⇒ fall back to the board.
    const { r } = renderWorkspace("/s/s-1?view=rounds");
    expect(r.container.querySelector('[data-screen="rounds-ledger"]')).toBeNull();
    expect(r.container.querySelector('[data-kind="lens-board-view"]')).not.toBeNull();
  });
});

// ── C15 4.3 + 4.4 — the retrospective line and the real gen-1 drill-down ───────
// C15 2.2 persists `frozenPredecessor` on the durable `RoundRecord`, un-parking C09
// finding F3: the ledger now walks the review's real generation line out of the records
// and hands it to the switcher, and the settled report wears the round's own
// retrospective account. Everything below is read off record data a real round writes.
describe("the retrospective line + the frozen gen-1 drill-down (C15 4.3, 4.4)", () => {
  /** A round that MOVED code: it froze `gen1` and composed `gen2` (the C15 2.2 shape). */
  const regeneratedRound = (asks: readonly string[]): RoundRecord => ({
    asksDispatched: [...asks],
    workerCommitRange: { from: "commit-from", to: "commit-to" },
    mintedPatchsetGeneration: "gen2",
    frozenPredecessor: "gen1",
    boardGeneration: "gen2",
    reportBoard: "report-round-1",
  });

  const sourceFor = (record: RoundRecord): RoundsSource => ({
    roundState: () => ({ phase: "absent" }),
    roundRecords: () => [record],
    reportBoard: (id) => FIXTURE_REPORT_BOARDS[id],
  });

  it("wears the retrospective line off the durable record — reworks and the composed generation", () => {
    const { r } = renderWorkspace(
      "/s/s-1?view=rounds",
      sourceFor(regeneratedRound(["ask-observability", "ask-network"])),
    );
    const line = r.getByTestId("round-retrospective");
    expect(line.textContent).toContain("Regenerated the boards · 2 reworks · generation gen2");
    expect(line.getAttribute("data-generation")).toBe("gen2");
  });

  it("a round dispatched with no asks reads '0 reworks', never a fabricated count", () => {
    const { r } = renderWorkspace("/s/s-1?view=rounds", sourceFor(regeneratedRound([])));
    expect(r.getByTestId("round-retrospective").textContent).toContain("0 reworks");
  });

  it("states the board's generation and round in one quiet intro line", () => {
    const { r } = renderWorkspace("/s/s-1?view=rounds", sourceFor(regeneratedRound(["ask-1"])));
    // gen1 → gen2 is the review's generation line, so this round composed generation 2.
    expect(r.getByTestId("board-intro").textContent).toContain("Generation 2 · Round 1");
  });

  it("offers the frozen predecessor as a drill-down that opens the REAL gen-1 boards", async () => {
    const { r } = renderWorkspace("/s/s-1?view=rounds", sourceFor(regeneratedRound(["ask-1"])));
    const switcher = r.container.querySelector('[data-kind="generation-switcher"]');
    expect(switcher).not.toBeNull();
    // Both generations, oldest→newest: gen1 frozen, gen2 live.
    const tabs = [...(switcher?.querySelectorAll("[data-generation]") ?? [])];
    expect(tabs.map((t) => t.getAttribute("data-generation"))).toEqual(["gen1", "gen2"]);
    expect(tabs[0]?.getAttribute("data-frozen")).toBe("true");
    // The live generation leads…
    expect(r.container.querySelector('article[data-generation="gen2"]')).not.toBeNull();
    // …and drilling back renders gen1's own board, not a re-labelled gen2.
    await r.user.click(tabs[0] as HTMLElement);
    expect(r.container.querySelector('article[data-generation="gen1"]')).not.toBeNull();
    expect(r.container.querySelector('article[data-generation="gen2"]')).toBeNull();
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
