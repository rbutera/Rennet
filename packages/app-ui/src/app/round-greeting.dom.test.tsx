// @vitest-environment happy-dom
//
// The round report as greeting + progressive reveal (C09 cluster 5, task 5.3). Driven
// through the real `ReviewWorkspace` over the timeline rounds source + the fixture board
// source. Load-bearing claims:
//   - the report LEADS the board surface while the round is in a report phase and the
//     report resolves valid — readable at once, regeneration streaming beneath;
//   - **View the New Boards** is ABSENT before `composed` and PRESENT (never disabled) at
//     `composed` — the absent-until + present-never-disabled control (both halves);
//   - clicking it disarms the greeting (single consume) and the surface returns to the
//     lens board at the composed round's NEW generation (`gen2`);
//   - with the greeting unarmed the surface is the plain board (no greeting).
import type { Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { RoundGreeting } from "../rounds/round-greeting";
import type { LensLane, RoundState } from "../rounds/round-machine";
import type { RoundsSource } from "../rounds/rounds-data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { fixtureBoardRead } from "../test/fixtures/boards";
import {
  completedRoundRecord,
  createTimelineRoundsSource,
  FIXTURE_ROUND_COMPLETE_TICK,
  reportBoardFixture,
} from "../test/fixtures/rounds";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

// A stable-id own-branch review (no `postTarget`) — the header reads `repositoryRoot`.
const review = {
  id: "gr-1",
  activePatchsetId: "ps-1",
  repositoryRoot: "/home/dev/rennet",
} as unknown as Review;

beforeEach(() => act(() => store().runActions.resetRun()));
afterEach(() => act(() => store().runActions.resetRun()));

// Timeline ticks (FIXTURE_ROUND_TIMELINE): 10 ⇒ reporting, 11/12 ⇒ composing (lens rows
// running/done), FIXTURE_ROUND_COMPLETE_TICK ⇒ composed (newGeneration gen2).
const COMPOSING_TICK = 11;

/** Mount the workspace over one rounds source + the fixture board source, arming the
 *  greeting as the run route would before redirecting here. */
function renderWorkspace(opts: { startTick: number; armed: boolean }) {
  if (opts.armed) act(() => store().runActions.armGreeting(true));
  const timeline = createTimelineRoundsSource({ startTick: opts.startTick });
  const history = memoryHistory("/s/s-1");
  const r = mount(
    <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <RoundsSourceProvider value={timeline.source}>
          <ReviewWorkspace review={review} />
        </RoundsSourceProvider>
      </Router>
    </BridgeProvider>,
  );
  return { r, history, timeline };
}

describe("the round report as greeting + progressive reveal (C09 cluster 5)", () => {
  it("renders the verified live report before the completed ledger row exists", () => {
    act(() => store().runActions.armGreeting(true));
    const source: RoundsSource = {
      roundState: () => ({
        phase: "composing",
        reportBoardId: reportBoardFixture.boardId,
        report: reportBoardFixture,
        lanes: [{ id: "sequence", label: "Sequence", status: "running" }],
      }),
      roundRecords: () => [],
      reportBoard: () => undefined,
    };
    const r = mount(
      <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
        <Router hook={memoryHistory("/s/s-1").hook}>
          <RoundsSourceProvider value={source}>
            <ReviewWorkspace review={review} />
          </RoundsSourceProvider>
        </Router>
      </BridgeProvider>,
    );

    expect(r.container.querySelector('[data-screen="round-greeting"]')).not.toBeNull();
    expect(r.container.textContent).toContain("Token refresh exits are now observable");
    expect(r.getByTestId("regeneration-progress").textContent).toContain("Sequence");
    expect(r.queryByTestId("reveal-new-boards")).toBeNull();
  });

  it("a cold board-route reattach shows and arms a nonterminal report greeting", async () => {
    const source: RoundsSource = {
      roundState: () => ({
        phase: "composing",
        reportBoardId: reportBoardFixture.boardId,
        report: reportBoardFixture,
        lanes: [{ id: "sequence", label: "Sequence", status: "running" }],
      }),
      roundRecords: () => [],
      reportBoard: () => undefined,
    };
    const history = memoryHistory("/s/s-1");
    expect(store().run.greetingArmed).toBe(false);
    const r = mount(
      <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <RoundsSourceProvider value={source}>
            <ReviewWorkspace review={review} />
          </RoundsSourceProvider>
        </Router>
      </BridgeProvider>,
    );

    expect(r.container.querySelector('[data-screen="round-greeting"]')).not.toBeNull();
    expect(r.container.textContent).toContain("Token refresh exits are now observable");
    expect(r.queryByTestId("reveal-new-boards")).toBeNull();
    expect(r.container.querySelector('[data-kind="lens-board-view"]')).toBeNull();
    await waitFor(() => expect(store().run.greetingArmed).toBe(true));
  });

  it("leads with the report, readable while regeneration still shows 're-drafting'", () => {
    const { r } = renderWorkspace({ startTick: COMPOSING_TICK, armed: true });
    // The report board fills the surface (the greeting leads, not the plain lens board).
    expect(r.container.querySelector('[data-screen="round-greeting"]')).not.toBeNull();
    expect(r.getByTestId("report-tally").textContent).toContain("addressed");
    expect(r.container.textContent).toContain("Token refresh exits are now observable");
    // Regeneration streams beneath — still re-drafting (composing, lens rows running).
    expect(r.getByTestId("regeneration-progress").textContent).toContain("re-drafting");
    // …and the reveal is ABSENT before composed (never a disabled teaser waiting to enable).
    expect(r.queryByTestId("reveal-new-boards")).toBeNull();
  });

  it("states the exact run target and passed gate from the host receipt", () => {
    const r = mount(
      <RoundGreeting
        board={reportBoardFixture}
        state={{ phase: "reporting", reportBoardId: reportBoardFixture.boardId }}
        receipt={{ record: completedRoundRecord, roundNumber: 1 }}
        onReveal={() => undefined}
      />,
    );
    const summary = r.getByTestId("round-run-receipt");
    expect(summary.textContent).toContain(
      "Round 1 ran 2 asks on fix/token-refresh-observability using Codex 0.146.0.",
    );
    expect(summary.textContent).toContain("Passed pnpm check in 12 s across 7 projects.");
  });

  it("states an absent configured gate without inventing a command", () => {
    const r = mount(
      <RoundGreeting
        board={reportBoardFixture}
        state={{ phase: "reporting", reportBoardId: reportBoardFixture.boardId }}
        receipt={{
          roundNumber: 2,
          record: {
            ...completedRoundRecord,
            run: {
              startedAt: 1,
              sourceTarget: { kind: "detached", head: "0123456789abcdef" },
              gate: { outcome: "skipped", reason: "not-configured" },
            },
          },
        }}
        onReveal={() => undefined}
      />,
    );
    const summary = r.getByTestId("round-run-receipt");
    expect(summary.textContent).toContain("Round 2 ran 2 asks on detached at 0123456789ab.");
    expect(summary.textContent).toContain("No project gate was configured.");
    expect(summary.querySelector("code")).toBeNull();
  });

  it("View the New Boards is ABSENT before composed and PRESENT (never disabled) at composed", () => {
    // Before composed (composing): the control does not exist.
    const composing = renderWorkspace({ startTick: COMPOSING_TICK, armed: true });
    expect(composing.r.queryByTestId("reveal-new-boards")).toBeNull();
    composing.r.unmount();

    // At composed: the control exists and, existing, always works — never rendered disabled.
    const composed = renderWorkspace({ startTick: FIXTURE_ROUND_COMPLETE_TICK, armed: true });
    const reveal = composed.r.getByTestId("reveal-new-boards");
    expect(reveal.hasAttribute("disabled")).toBe(false);
  });

  it("clicking View the New Boards disarms the greeting and lands on the new generation", async () => {
    const { r } = renderWorkspace({ startTick: FIXTURE_ROUND_COMPLETE_TICK, armed: true });
    await r.user.click(r.getByTestId("reveal-new-boards"));

    // Single consume: the greeting disarms and is gone.
    expect(store().run.greetingArmed).toBe(false);
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    // The surface returned to the lens board at the composed round's NEW generation (gen2).
    expect(r.container.querySelector('[data-kind="lens-board-view"]')).not.toBeNull();
    expect(r.container.querySelector('[data-generation="gen2"]')).not.toBeNull();
  });

  it("restores an unconsumed completed report after reload, but never resurrects it after Reveal", async () => {
    const first = renderWorkspace({ startTick: FIXTURE_ROUND_COMPLETE_TICK, armed: false });

    expect(first.r.container.querySelector('[data-screen="round-greeting"]')).not.toBeNull();
    await first.r.user.click(first.r.getByTestId("reveal-new-boards"));
    expect(first.r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();

    first.r.unmount();
    act(() => store().runActions.resetRun());
    const reloaded = renderWorkspace({ startTick: FIXTURE_ROUND_COMPLETE_TICK, armed: false });

    expect(reloaded.r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    await waitFor(() =>
      expect(reloaded.r.container.querySelector('[data-generation="gen2"]')).not.toBeNull(),
    );
  });

  it("shows the plain board (no greeting) when the greeting is unarmed", () => {
    const { r } = renderWorkspace({ startTick: 0, armed: false }); // absent round, nothing armed
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    expect(r.container.querySelector('[data-kind="lens-board-view"]')).not.toBeNull();
  });
});

// Finding 1: a composed round whose report does NOT resolve valid must NOT fall through to
// the new-generation board. It gates the reveal — the failure shows honestly and the new
// boards stay hidden. A composed state carries `newGeneration: "gen2"`, so a leak would
// render the gen2 lens board; these assert it does not.
function renderComposedWithReport(reportBoard: () => unknown) {
  act(() => store().runActions.armGreeting(true));
  const source: RoundsSource = {
    roundState: () => ({
      phase: "composed",
      reportBoardId: "report-round-1",
      newGeneration: "gen2",
    }),
    roundRecords: () => [],
    reportBoard,
  };
  const history = memoryHistory("/s/s-1");
  return mount(
    <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <RoundsSourceProvider value={source}>
          <ReviewWorkspace review={review} />
        </RoundsSourceProvider>
      </Router>
    </BridgeProvider>,
  );
}

describe("regeneration lanes render every status honestly — no false green check (finding 5)", () => {
  // A composing state carrying one lane of each RowStatus. A queued or failed drafter must NOT
  // read as a settled "done" success (the old bug collapsed everything but `running` to a green
  // check + "done").
  const composing: RoundState = {
    phase: "composing",
    reportBoardId: "report-round-1",
    lanes: [
      { id: "l-queued", label: "Design", status: "queued" },
      { id: "l-running", label: "Sequence", status: "running" },
      { id: "l-drafted", label: "Noise", status: "drafted" },
      { id: "l-done", label: "Decisions", status: "done", verdict: "reworked" },
      {
        id: "l-absent",
        label: "Design artifacts",
        status: "absent",
        reason: "No Design specification applies to this change.",
      },
      {
        id: "l-failed",
        label: "Flagged",
        status: "failed",
        reason: "the drafter emitted no board",
      },
    ],
  };

  function renderGreeting() {
    return mount(
      <RoundGreeting board={reportBoardFixture} state={composing} onReveal={() => undefined} />,
    );
  }

  it("a queued lane reads 'queued', never 'done'", () => {
    const r = renderGreeting();
    const row = r.container.querySelector('[data-row="l-queued"]');
    expect(row?.getAttribute("data-status")).toBe("queued");
    expect(row?.textContent).toContain("queued");
    expect(row?.textContent).not.toContain("done");
  });

  it("a failed lane reads its REASON, never 'done'", () => {
    const r = renderGreeting();
    const row = r.container.querySelector('[data-row="l-failed"]');
    expect(row?.getAttribute("data-status")).toBe("failed");
    // The union makes the reason structural (finding 8), so the lane shows WHY, not just
    // that it failed — a bare "failed" leaves the reviewer nothing to act on.
    expect(row?.textContent).toContain("the drafter emitted no board");
    expect(row?.textContent).not.toContain("done");
  });

  it("a drafted-but-unannounced lane reads 'drafted' — no verdict it does not have yet", () => {
    const r = renderGreeting();
    const row = r.container.querySelector('[data-row="l-drafted"]');
    expect(row?.getAttribute("data-status")).toBe("drafted");
    expect(row?.textContent).toContain("drafted");
    expect(row?.textContent).not.toContain("carrying forward");
    expect(row?.textContent).not.toContain("reworked");
  });

  it("an absent lane reads as a successful no-material result, not a failure", () => {
    const r = renderGreeting();
    const row = r.container.querySelector('[data-row="l-absent"]');
    expect(row?.getAttribute("data-status")).toBe("absent");
    expect(row?.textContent).toContain("No Design specification applies to this change.");
    expect(row?.textContent).not.toContain("failed");
  });

  // ── C15 3.3 — the carry-forward lane label reaches the reviewer's eye ──
  // The emitter derives `detail` from the SAME `stampDeltas` signal the board's section
  // markers render (`round-progress.test.ts` proves that half). This is the render half:
  // a settled lane shows its verdict, and a lens that was REWORKED must never read
  // "carrying forward" — that lie is the whole point of the constraint.
  it("renders the settled lane's carry verdict, and a reworked lens never reads 'carrying forward'", () => {
    const settled: RoundState = {
      phase: "composing",
      reportBoardId: "report-round-1",
      lanes: [
        { id: "design", label: "Design", status: "done", verdict: "reworked" },
        { id: "sequence", label: "Sequence", status: "done", verdict: "carrying-forward" },
      ],
    };
    const r = mount(
      <RoundGreeting board={reportBoardFixture} state={settled} onReveal={() => undefined} />,
    );
    const design = r.container.querySelector('[data-row="design"]');
    const sequence = r.container.querySelector('[data-row="sequence"]');
    expect(design?.textContent).toContain("reworked");
    expect(design?.textContent).not.toContain("carrying forward");
    expect(sequence?.textContent).toContain("carrying forward");
  });
});

// ── C15 4.1 + 4.2 — the ruled kicker and the synthetic tail steps ──────────────
// 4.1 is Rai's VERBATIM ruling (C14 verifies the exact strings): the regeneration
// kicker reads "Regenerating the Boards" while it runs and "Regenerated the Boards"
// when it finishes; the old "Re-drafting the boards" is gone from the surface.
// 4.2's two steps are DERIVED from the real phase — the post-process pass is the window
// between the last lens landing and the generation composing, and the composed line is
// the `composed` event itself. Neither is pre-rendered.
describe("the regeneration kicker + tail steps (C15 4.1, 4.2)", () => {
  const settledLanes: readonly LensLane[] = [
    { id: "design", label: "Design", status: "done", verdict: "carrying-forward" },
    { id: "flagged", label: "Flagged", status: "done", verdict: "reworked" },
  ];
  const running: RoundState = {
    phase: "composing",
    reportBoardId: "report-round-1",
    lanes: [
      { id: "design", label: "Design", status: "done", verdict: "carrying-forward" },
      { id: "flagged", label: "Flagged", status: "running" },
    ],
  };
  const settled: RoundState = {
    phase: "composing",
    reportBoardId: "report-round-1",
    lanes: settledLanes,
  };
  const composed: RoundState = {
    phase: "composed",
    reportBoardId: "report-round-1",
    newGeneration: "gen2",
    lanes: settledLanes,
  };

  const render = (state: RoundState) =>
    mount(<RoundGreeting board={reportBoardFixture} state={state} onReveal={() => undefined} />);

  it("reads 'Regenerating the Boards' while the drafters run — never the old 'Re-drafting the boards'", () => {
    const r = render(running);
    const block = r.getByTestId("regeneration-progress");
    expect(block.textContent).toContain("Regenerating the Boards");
    expect(r.container.textContent).not.toContain("Re-drafting the boards");
  });

  it("reads 'Regenerated the Boards' once the generation composed", () => {
    const r = render(composed);
    const block = r.getByTestId("regeneration-progress");
    expect(block.textContent).toContain("Regenerated the Boards");
    expect(block.textContent).not.toContain("Regenerating the Boards");
    expect(r.container.textContent).not.toContain("Re-drafting the boards");
  });

  it("holds both tail steps back until their phase — nothing is pre-rendered", () => {
    const r = render(running); // a drafter still running: neither step has happened
    expect(r.container.querySelector('[data-step="post-process"]')).toBeNull();
    expect(r.container.querySelector('[data-step="composed"]')).toBeNull();
  });

  it("shows the post-process pass once every lane settles, still before composition", () => {
    const r = render(settled);
    const step = r.container.querySelector('[data-step="post-process"]');
    expect(step?.textContent).toContain("Cleaning up drafts · post-process pass");
    expect(step?.getAttribute("data-status")).toBe("running");
    // The generation has not composed, so its line is still absent.
    expect(r.container.querySelector('[data-step="composed"]')).toBeNull();
  });

  it("shows both steps settled at composition, the composed line naming the real generation", () => {
    const r = render(composed);
    expect(
      r.container.querySelector('[data-step="post-process"]')?.getAttribute("data-status"),
    ).toBe("done");
    const composedStep = r.container.querySelector('[data-step="composed"]');
    expect(composedStep?.textContent).toContain("Composed generation gen2");
    expect(composedStep?.getAttribute("data-status")).toBe("done");
  });
});

describe("the report gates the reveal — a broken report never leaks the new boards (finding 1)", () => {
  it("composed + MISSING report: honest missing state, no greeting, no gen2 leak", () => {
    const r = renderComposedWithReport(() => undefined); // source has no board for the id
    const unavailable = r.container.querySelector('[data-testid="report-unavailable"]');
    expect(unavailable?.getAttribute("data-report-status")).toBe("missing");
    expect(r.queryByTestId("reveal-new-boards")).toBeNull(); // reveal held back
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    expect(r.container.querySelector('[data-generation="gen2"]')).toBeNull(); // new boards hidden
  });

  it("composed + INVALID report: honest invalid state, no greeting, no gen2 leak", () => {
    const r = renderComposedWithReport(() => ({ lens: "design", nope: true })); // schema-rejected
    const unavailable = r.container.querySelector('[data-testid="report-unavailable"]');
    expect(unavailable?.getAttribute("data-report-status")).toBe("invalid");
    expect(r.queryByTestId("reveal-new-boards")).toBeNull();
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    expect(r.container.querySelector('[data-generation="gen2"]')).toBeNull();
  });
});
