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
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BoardSourceProvider } from "../board/board-data";
import { BridgeProvider } from "../data";
import { RoundGreeting } from "../rounds/round-greeting";
import type { RoundState } from "../rounds/round-machine";
import type { RoundsSource } from "../rounds/rounds-data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount } from "../test/dom";
import { fixtureBoardSource } from "../test/fixtures/boards";
import {
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
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <BoardSourceProvider value={fixtureBoardSource}>
          <RoundsSourceProvider value={timeline.source}>
            <ReviewWorkspace review={review} />
          </RoundsSourceProvider>
        </BoardSourceProvider>
      </Router>
    </BridgeProvider>,
  );
  return { r, history, timeline };
}

describe("the round report as greeting + progressive reveal (C09 cluster 5)", () => {
  it("leads with the report, readable while regeneration still shows 're-drafting'", () => {
    const { r } = renderWorkspace({ startTick: COMPOSING_TICK, armed: true });
    // The report board fills the surface (the greeting leads, not the plain lens board).
    expect(r.container.querySelector('[data-screen="round-greeting"]')).not.toBeNull();
    expect(r.getByTestId("report-tally").textContent).toContain("addressed");
    // Regeneration streams beneath — still re-drafting (composing, lens rows running).
    expect(r.getByTestId("regeneration-progress").textContent).toContain("re-drafting");
    // …and the reveal is ABSENT before composed (never a disabled teaser waiting to enable).
    expect(r.queryByTestId("reveal-new-boards")).toBeNull();
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
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <BoardSourceProvider value={fixtureBoardSource}>
          <RoundsSourceProvider value={source}>
            <ReviewWorkspace review={review} />
          </RoundsSourceProvider>
        </BoardSourceProvider>
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
      { id: "l-done", label: "Decisions", status: "done" },
      { id: "l-failed", label: "Flagged", status: "failed" },
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

  it("a failed lane reads 'failed', never 'done'", () => {
    const r = renderGreeting();
    const row = r.container.querySelector('[data-row="l-failed"]');
    expect(row?.getAttribute("data-status")).toBe("failed");
    expect(row?.textContent).toContain("failed");
    expect(row?.textContent).not.toContain("done");
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
        { id: "design", label: "Design", status: "done", detail: "reworked" },
        { id: "sequence", label: "Sequence", status: "done", detail: "carrying forward" },
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
