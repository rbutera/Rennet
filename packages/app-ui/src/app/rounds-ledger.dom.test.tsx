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
import type { Review, RoundLedgerRecord, RoundRecord } from "@rennet/protocol";
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
  reportBoardFixture,
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
    expect(r.container.textContent).toContain("Token refresh exits are now observable");
    expect(r.container.textContent).toContain(
      "Every terminal path now leaves a typed record without retaining credentials.",
    );
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

  it("summarises rows from immutable run facts and each exact report, never ask count", () => {
    const untouchedReport = {
      ...reportBoardFixture,
      boardId: "report-untouched",
      elements: reportBoardFixture.elements.map((element) =>
        element.kind === "round_outcome"
          ? { ...element, data: { ...element.data, status: "untouched" as const } }
          : element,
      ),
    };
    const older: RoundLedgerRecord = {
      ...completedRoundRecord,
      reportBoard: untouchedReport.boardId,
      report: untouchedReport,
      run: {
        startedAt: Date.UTC(2026, 7, 28, 8, 0),
        sourceTarget: { kind: "detached", head: "0123456789abcdef" },
        gate: { outcome: "skipped", reason: "not-configured" },
      },
    };
    const completedRun = completedRoundRecord.run;
    if (completedRun === undefined) {
      throw new Error("completed round fixture is missing a run receipt");
    }
    const newer: RoundLedgerRecord = {
      ...completedRoundRecord,
      run: {
        ...completedRun,
        startedAt: Date.UTC(2026, 7, 29, 9, 30),
      },
    };
    const records = [older, newer] as const;
    const source: RoundsSource = {
      roundState: () => ({ phase: "absent" }),
      roundRecords: () => records,
      reportBoard: (id) => records.find((record) => record.reportBoard === id)?.report,
    };
    const { r } = renderWorkspace("/s/s-1?view=rounds", source);
    const roundOne = r.container.querySelector('[data-round="1"]');
    const roundTwo = r.container.querySelector('[data-round="2"]');

    expect(roundOne?.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-08-28T08:00:00.000Z",
    );
    expect(roundOne?.textContent).toContain("detached at 0123456789ab");
    expect(roundOne?.textContent).toContain("4 untouched");
    expect(roundTwo?.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-08-29T09:30:00.000Z",
    );
    expect(roundTwo?.textContent).toContain("fix/token-refresh-observability");
    expect(roundTwo?.textContent).toContain("1 addressed");
    expect(roundOne?.textContent).not.toContain("2 asks");
    expect(roundTwo?.textContent).not.toContain("2 asks");
  });

  it("a single-generation round opens its own boards and offers NO drill-down (C15 4.4)", async () => {
    // `completedRoundRecord` carries no `frozenPredecessor` — a first-generation round really
    // has no distinct earlier generation. The ledger opens the round's own boards (gen2) and
    // the switcher does not render: honest absence, not a fabricated gen1 tab.
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

  // ── An older daemon that cannot answer the rounds reads (review finding 9) ──
  //
  // "No rounds have completed" and "nobody could tell us" are different facts, and only
  // the first is an absence. A client can outrun the daemon it is talking to, and the
  // ledger's empty state would otherwise state a conclusion nobody established.
  it("states the daemon's reason instead of falling back to the board as if there were none", () => {
    const unreadable: RoundsSource = {
      roundState: () => ({ phase: "absent" }),
      roundRecords: () => [],
      reportBoard: () => undefined,
      roundsUnavailable: () => "Unknown command: session.rounds",
    };
    const { r } = renderWorkspace("/s/s-1?view=rounds", unreadable);
    expect(r.getByTestId("rounds-unavailable")).toBeTruthy();
    // The daemon's own words, verbatim — no version guess, nothing to acknowledge.
    expect(r.getByTestId("rounds-unavailable-reason").textContent).toContain(
      "Unknown command: session.rounds",
    );
    // …and it did NOT silently become the board, which is what an empty ledger does.
    expect(r.container.querySelector('[data-kind="lens-board-view"]')).toBeNull();
  });
});

// ── C15 4.3 + 4.4 — the retrospective line and the real gen-1 drill-down ───────
// C15 2.2 persists `frozenPredecessor` on the durable `RoundRecord`, un-parking C09
// finding F3: the ledger now walks the review's real generation line out of the records
// and hands it to the switcher, and the settled report wears the round's own
// retrospective account. Everything below is read off record data a real round writes.
describe("the retrospective line + the frozen gen-1 drill-down (C15 4.3, 4.4)", () => {
  /** A round that MOVED code: it froze `gen1` and composed `gen2` (the C15 2.2 shape).
   *  `asks` and `reworkCount` are DELIBERATELY independent here — the count is the round
   *  report's own verified tally (C15 finding 10), not a function of how many asks went
   *  out, and the tests below hold them apart on purpose. */
  const regeneratedRound = (asks: readonly string[], reworkCount?: number): RoundRecord => ({
    asksDispatched: [...asks],
    workerCommitRange: { from: "commit-from", to: "commit-to" },
    mintedPatchsetGeneration: "gen2",
    frozenPredecessor: "gen1",
    boardGeneration: "gen2",
    reportBoard: "report-round-1",
    ...(reworkCount === undefined ? {} : { reworkCount }),
  });

  const sourceFor = (record: RoundRecord): RoundsSource => ({
    roundState: () => ({ phase: "absent" }),
    roundRecords: () => [record],
    reportBoard: (id) => FIXTURE_REPORT_BOARDS[id],
  });

  it("wears the retrospective line off the durable record — reworks and the composed generation", () => {
    const { r } = renderWorkspace(
      "/s/s-1?view=rounds",
      sourceFor(regeneratedRound(["ask-observability", "ask-network"], 2)),
    );
    const line = r.getByTestId("round-retrospective");
    expect(line.textContent).toContain("Regenerated the boards · 2 reworks · generation gen2");
    expect(line.getAttribute("data-generation")).toBe("gen2");
  });

  // THE FABRICATION THIS GUARDS (finding 10): the line used to render
  // `asksDispatched.length`, so five asks that produced NOTHING read "5 reworks". The
  // number is the report's verified count, and it tracks the round's own work.
  it("shows the REPORT's count, not the ask count — five asks that reworked nothing read '0 reworks'", () => {
    const asks = ["a-1", "a-2", "a-3", "a-4", "a-5"];
    const { r } = renderWorkspace("/s/s-1?view=rounds", sourceFor(regeneratedRound(asks, 0)));
    const line = r.getByTestId("round-retrospective").textContent ?? "";
    expect(line).toContain("0 reworks");
    expect(line).not.toContain("5 reworks");
  });

  it("one rework reads 'rework', not '1 reworks'", () => {
    const { r } = renderWorkspace("/s/s-1?view=rounds", sourceFor(regeneratedRound(["ask-1"], 1)));
    const line = r.getByTestId("round-retrospective").textContent ?? "";
    expect(line).toContain("1 rework ·");
    expect(line).not.toContain("1 reworks");
  });

  it("a round whose report never drafted states NO count rather than a zero it cannot verify", () => {
    const { r } = renderWorkspace("/s/s-1?view=rounds", sourceFor(regeneratedRound(["ask-1"])));
    const line = r.getByTestId("round-retrospective").textContent ?? "";
    expect(line).toContain("Regenerated the boards · generation gen2");
    expect(line).not.toContain("reworks");
  });

  // The retrospective is a DISCLOSURE (prototype `round-report.tsx:118-158`): the line is
  // the trigger, and opening it shows the round's trigger queue and run receipt. Both
  // halves come off the durable record — nothing here narrates what the orchestrator "did".
  it("opens the retrospective onto the round's trigger queue, named by the report's ask text", async () => {
    const { r } = renderWorkspace(
      "/s/s-1?view=rounds",
      sourceFor(regeneratedRound(["ask-observability", "ask-network"], 2)),
    );
    const panel = r.getByTestId("round-retrospective");
    const disclosure = panel.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!disclosure) throw new Error("missing retrospective disclosure");
    // Closed by default — the detail is not in the DOM at all, so this cannot pass on a
    // panel that renders its body and merely hides it.
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(r.queryByTestId("round-retrospective-detail")).toBeNull();

    await r.user.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const triggers = [...r.container.querySelectorAll('[data-testid="round-trigger"]')];
    expect(triggers).toHaveLength(2);
    // The record carries thread IDS; the words live on the report's outcomes, so the queue
    // reads as asks rather than as identifiers. Point `askText` at the wrong record and the
    // ids come back instead.
    expect(triggers[0]?.textContent).toContain("Log every refresh exit without leaking the token.");
    expect(triggers[1]?.textContent).toContain("Report the post-send failure honestly.");
    expect(triggers[0]?.textContent).not.toContain("ask-observability");
  });

  it("keeps an unaccounted ask as its id rather than borrowing another ask's words", async () => {
    const { r } = renderWorkspace(
      "/s/s-1?view=rounds",
      sourceFor(regeneratedRound(["ask-observability", "ask-never-reported"], 1)),
    );
    const disclosure = r
      .getByTestId("round-retrospective")
      .querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!disclosure) throw new Error("missing retrospective disclosure");
    await r.user.click(disclosure);
    const triggers = [...r.container.querySelectorAll('[data-testid="round-trigger"]')];
    expect(triggers[1]?.textContent).toContain("ask-never-reported");
  });

  // The run receipt is optional on the record (legacy rows omit it). A round with no
  // receipt shows the trigger queue and NO run group — absent beats invented.
  it("shows the run group only when the record carries a receipt", async () => {
    const withoutReceipt = renderWorkspace(
      "/s/s-1?view=rounds",
      sourceFor(regeneratedRound(["ask-observability"], 1)),
    );
    const closed = withoutReceipt.r
      .getByTestId("round-retrospective")
      .querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!closed) throw new Error("missing retrospective disclosure");
    await withoutReceipt.r.user.click(closed);
    expect(withoutReceipt.r.queryByTestId("round-gate")).toBeNull();
    withoutReceipt.r.unmount();

    const withReceipt = renderWorkspace(
      "/s/s-1?view=rounds",
      sourceFor({
        ...regeneratedRound(["ask-observability"], 1),
        run: {
          startedAt: Date.UTC(2026, 7, 29, 9, 30),
          sourceTarget: { kind: "branch", branch: "fix/token-refresh-observability" },
          gate: { outcome: "passed", command: "pnpm check", durationMs: 12_400 },
        },
      }),
    );
    const open = withReceipt.r
      .getByTestId("round-retrospective")
      .querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!open) throw new Error("missing retrospective disclosure");
    await withReceipt.r.user.click(open);
    expect(withReceipt.r.getByTestId("round-gate").textContent).toContain(
      "Gate passed · pnpm check · 12s",
    );
    // `commit-from` → `commit-to` is a real move, so the commit line states the range.
    expect(withReceipt.r.getByTestId("round-commits").textContent).toContain("Committed commit-");
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
    // The live generation leads… (the boards arrive over `board.read`, so wait it out).
    await waitFor(() =>
      expect(r.container.querySelector('article[data-generation="gen2"]')).not.toBeNull(),
    );
    // …and drilling back renders gen1's own board, not a re-labelled gen2.
    await r.user.click(tabs[0] as HTMLElement);
    await waitFor(() =>
      expect(r.container.querySelector('article[data-generation="gen1"]')).not.toBeNull(),
    );
    expect(r.container.querySelector('article[data-generation="gen2"]')).toBeNull();
  });
});

// ── The round diff (#571) ─────────────────────────────────────────────────────
//
// THE DEFECT THIS REPLACES: "Round diff" was a live button on every round that navigated to
// a surface saying the feature "isn't wired yet". The data was there the whole time —
// `RoundRecord.diff` is the checkpoint-measured diff of the round's own coding turn, and the
// durable store preserves it across the regeneration that supersedes the dispatch placeholder.
//
// These mount the real surface and CLICK, because reading the ledger source is what missed
// this: the button looked wired.
describe("the Round-diff control shows the round's own diff (#571)", () => {
  const ROUND_ONE_FILE = "packages/core/src/round-one-only.ts";
  const ROUND_TWO_FILE = "packages/core/src/round-two-only.ts";

  /** A round that ran a work order and captured its diff — the producer shape after the
   *  `session.rounds` read splits `RoundRecord.diff` per file. */
  const roundWithDiff = (gen: string, file: string, added: string): RoundRecord => ({
    asksDispatched: ["ask-1"],
    workerCommitRange: { from: `${gen}-from`, to: `${gen}-to` },
    mintedPatchsetGeneration: gen,
    boardGeneration: gen,
    reportBoard: "report-round-1",
    diff: `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n+${added}`,
    diffFiles: [
      {
        path: file,
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        patch: `@@ -1,1 +1,1 @@\n+${added}`,
      },
    ],
  });

  /** A regeneration-only round: no work order ran, so there is no diff of its own. */
  const roundWithoutDiff = (gen: string): RoundRecord => ({
    asksDispatched: ["ask-1"],
    workerCommitRange: { from: "same", to: "same" },
    boardGeneration: gen,
    reportBoard: "report-round-1",
  });

  // A review whose ACTIVE patchset carries a recognizable file — if the round diff regressed
  // to "whatever activePatchsetId points at now", this filename would render. It must not.
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

  function mountLedger(
    records: readonly RoundRecord[],
    path = "/s/s-1?view=rounds",
    extra: Partial<RoundsSource> = {},
  ) {
    const source: RoundsSource = {
      roundState: () => ({ phase: "absent" }),
      roundRecords: () => records,
      reportBoard: (id) => FIXTURE_REPORT_BOARDS[id],
      ...extra,
    };
    const history = memoryHistory(path);
    const r = mount(
      <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <RoundsSourceProvider value={source}>
            <ReviewWorkspace review={reviewWithPatchset} />
          </RoundsSourceProvider>
        </Router>
      </BridgeProvider>,
    );
    return { r, history };
  }

  it("clicking Round diff lands on the round's REAL changed file, not a 'not wired yet' notice", async () => {
    const { r, history } = mountLedger([roundWithDiff("g1", ROUND_ONE_FILE, "const one = 1;")]);
    await r.user.click(r.getByTestId("round-diff-link"));

    // The URL names the round by its ledger number…
    expect(history.history.at(-1)).toContain("round=1");
    // …and the diff surface renders THAT round's file with THAT round's added line.
    const surface = r.container.querySelector('[data-testid="round-diff"]');
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("data-round")).toBe("1");
    expect(r.container.textContent).toContain(ROUND_ONE_FILE);
    expect(r.container.textContent).toContain("const one = 1;");
    // ⚠️ REGRESSION PINS, not coverage: this PR DELETES the "isn't wired yet" string, so these
    // two cannot fail today and are not evidence the surface works — the assertions above are.
    // They are here to redden if the placeholder is ever reintroduced.
    expect(r.container.textContent).not.toMatch(/isn't wired yet/i);
    expect(r.container.textContent).not.toMatch(/not wired/i);
    // …and it is the ROUND's diff, never the review's current patchset.
    expect(r.container.textContent).not.toContain("LATEST_PATCHSET_MARKER.ts");
  });

  it("an OLDER round's Round diff shows that round's file, never the newest round's", async () => {
    const { r, history } = mountLedger([
      roundWithDiff("g1", ROUND_ONE_FILE, "const one = 1;"),
      roundWithDiff("g2", ROUND_TWO_FILE, "const two = 2;"),
    ]);
    // Round 2 leads on open; select round 1 and follow ITS control.
    await r.user.click(r.container.querySelector('[data-round="1"]') as HTMLElement);
    expect(r.getByTestId("round-diff-link").getAttribute("data-round-number")).toBe("1");
    await r.user.click(r.getByTestId("round-diff-link"));

    expect(history.history.at(-1)).toContain("round=1");
    expect(r.container.textContent).toContain(ROUND_ONE_FILE);
    expect(r.container.textContent).not.toContain(ROUND_TWO_FILE);
  });

  // ABSENT, not disabled and not a tooltip (the house convention). A round with no diff of
  // its own has NO control — the reviewer is never offered a door that opens onto an excuse.
  it("a round that captured no diff offers NO Round-diff control at all", () => {
    const { r } = mountLedger([roundWithoutDiff("g1")]);
    expect(r.container.querySelector('[data-testid="round-diff-link"]')).toBeNull();
    // Nothing disabled is standing in for it either.
    expect(r.container.querySelector("button[disabled]")).toBeNull();
  });

  it("the control appears and disappears WITH the selected round, not with the session", async () => {
    // Round 1 ran a work order; round 2 only regenerated. Selecting each moves the control.
    const { r } = mountLedger([
      roundWithDiff("g1", ROUND_ONE_FILE, "const one = 1;"),
      roundWithoutDiff("g2"),
    ]);
    // Round 2 (no diff) leads on open ⇒ no control.
    expect(r.container.querySelector('[data-round="2"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(r.container.querySelector('[data-testid="round-diff-link"]')).toBeNull();
    // Selecting round 1 (which has a diff) brings it back.
    await r.user.click(r.container.querySelector('[data-round="1"]') as HTMLElement);
    expect(r.container.querySelector('[data-testid="round-diff-link"]')).not.toBeNull();
  });

  it("a ?round= naming no round in the ledger says so — it does not fall back to the live diff", () => {
    const { r } = mountLedger(
      [roundWithDiff("g1", ROUND_ONE_FILE, "const one = 1;")],
      "/s/s-1?view=diff&round=9",
    );
    expect(r.getByTestId("round-diff-unknown")).toBeTruthy();
    expect(r.container.textContent).not.toContain("LATEST_PATCHSET_MARKER.ts");
  });

  // ── An empty ledger is THREE facts, and two of them are not "no such round" (#571) ──
  //
  // `useRoundRecords` returns `[]` for "no rounds", "read in flight", and "read failed". The
  // cold deep-link — the bookmark this ordinal address exists to serve — arrives in the second
  // state, and a daemon that cannot answer `session.rounds` stays in the third forever.
  // Blaming the ROUND for either is the same "wrong absence" this PR set out to remove.
  it("a cold deep-link waits for the ledger read instead of blaming the round", () => {
    const { r } = mountLedger([], "/s/s-1?view=diff&round=1", {
      roundRecordsPending: () => true,
    });
    expect(r.getByTestId("round-diff-loading")).toBeTruthy();
    expect(r.container.querySelector('[data-testid="round-diff-unknown"]')).toBeNull();
  });

  it("a daemon that cannot read the ledger says SO, in its own words", () => {
    const { r } = mountLedger([], "/s/s-1?view=diff&round=1", {
      roundsUnavailable: () => "Unknown command: session.rounds",
    });
    const notice = r.getByTestId("round-diff-unavailable");
    expect(notice.textContent).toContain("Unknown command: session.rounds");
    expect(r.container.querySelector('[data-testid="round-diff-unknown"]')).toBeNull();
    // …and it did not silently fall through to the live diff either.
    expect(r.container.textContent).not.toContain("LATEST_PATCHSET_MARKER.ts");
  });

  it("a settled, genuinely empty ledger DOES say the round is unknown", () => {
    // Not pending, not unavailable: the read came back and the session has no rounds. This is
    // the one case "not in this session's ledger" is true, and it must still be reachable.
    const { r } = mountLedger([], "/s/s-1?view=diff&round=1");
    expect(r.getByTestId("round-diff-unknown")).toBeTruthy();
  });

  // F3: the branch states what it knows. A round reaches it by regenerating without a work
  // order, by running one that changed nothing, or by a diff that parsed to no files — so it
  // must not name one of the three as the cause.
  it("a round in the ledger with no diff says only that, claiming no cause", () => {
    const { r } = mountLedger([roundWithoutDiff("g1")], "/s/s-1?view=diff&round=1");
    const notice = r.getByTestId("round-diff-uncaptured");
    expect(notice.textContent).toContain("no diff of its own to show");
    expect(notice.textContent).not.toMatch(/work order/i);
    expect(notice.textContent).not.toMatch(/regenerated/i);
  });

  it("the live diff (no ?round=) is unchanged — it still shows the active patchset", () => {
    const { r } = mountLedger(
      [roundWithDiff("g1", ROUND_ONE_FILE, "const one = 1;")],
      "/s/s-1?view=diff",
    );
    expect(r.container.textContent).toContain("LATEST_PATCHSET_MARKER.ts");
    expect(r.container.querySelector('[data-testid="round-diff"]')).toBeNull();
  });
});
