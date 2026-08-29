// @vitest-environment happy-dom
//
// The packet E2E (C09 cluster 9, task 9.1) — the WHOLE rounds chain over the REAL app
// surfaces, driven not asserted. The per-cluster tests pin each individual LINK; this
// proves the CHAIN holds through ONE timeline source across real navigation:
//   staged ask → Dispatch Round → `/s/:slug/run` takeover → live worker rows advancing on
//   injected ticks (no wall clock) → report-as-greeting on return (readable while
//   regeneration streams) → View the New Boards at composition (absent-until,
//   present-never-disabled) → gen2 with delta marks → rounds ledger row + frozen
//   generation reachable → cold deep-link mid-round reattaches without double-dispatch.
//
// It runs the FIXTURE rounds source — a test double for the live one, not a stand-in for
// a missing runtime (cluster 8 landed `useLiveRoundsSource`, and the app binds it) —
// through the same `ReviewWorkspace` + `RunRoute` the app mounts, under the one
// `RoundsSourceProvider` cluster 7 wired. So this proves the CHAIN, not the transport.
// No `setTimeout` drives anything: a tick + a re-render is the injected input, standing
// in for what `useCommandStream` delivers in the live source.
import type { RennetBridge, Review } from "@rennet/protocol";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { RunRoute } from "../rounds/run-route";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { fixtureBoardRead } from "../test/fixtures/boards";
import type { TimelineRoundsSource } from "../test/fixtures/rounds";
import {
  completedRoundRecord,
  createTimelineRoundsSource,
  FIXTURE_ROUND_COMPLETE_TICK,
  fixtureCompletedRoundsSource,
} from "../test/fixtures/rounds";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

// A stable-id own-branch review — the stable id means the first mount does not reset the
// review slice, so a pre-staged ask survives into the handoff surface; the header reads
// `repositoryRoot`.
const review = {
  id: "e2e-1",
  activePatchsetId: "ps-1",
  repositoryRoot: "/home/dev/rennet",
} as unknown as Review;

// FIXTURE_ROUND_TIMELINE ticks: 5 ⇒ worker running/queued, 6 ⇒ read done + record running,
// 11 ⇒ composing (lens rows re-drafting), FIXTURE_ROUND_COMPLETE_TICK ⇒ composed (gen2).
const COMPOSING_TICK = 11;

afterEach(() =>
  act(() => {
    store().reviewActions.resetReview();
    store().runActions.resetRun();
    // The delta dot is UI-only and per-session — clear the viewed set between cases.
    useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } });
  }),
);

/** The real two-route app tree under ONE rounds source + the fixture board source — the
 *  shape cluster 7 wires (workspace + run route sharing one `RoundsSourceProvider`). The
 *  bridge is hoisted stable so a re-render never remounts the provider. */
function appTree(
  source: TimelineRoundsSource["source"],
  history: ReturnType<typeof memoryHistory>,
  bridge: RennetBridge,
): ReactElement {
  return (
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <RoundsSourceProvider value={source}>
          <Switch>
            <Route path={ROUTES.sessionRun}>{(p) => <RunRoute slug={p.slug ?? ""} />}</Route>
            <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
          </Switch>
        </RoundsSourceProvider>
      </Router>
    </BridgeProvider>
  );
}

function mountApp(timeline: TimelineRoundsSource, path: string) {
  const history = memoryHistory(path);
  const bridge = new MemoryBridge({ "board.read": fixtureBoardRead });
  const r = mount(appTree(timeline.source, history, bridge));
  // Re-read the mutated injected clock into the tree — the seam's re-render at cluster 8
  // (a `useCommandStream` push), here a test-driven tick. NO wall clock.
  const pump = (tick: number) => {
    timeline.setTick(tick);
    act(() => r.rerender(appTree(timeline.source, history, bridge)));
  };
  return { r, history, pump };
}

describe("C09 packet E2E — the whole rounds chain over the real surfaces", () => {
  it("dispatch → live run → report-as-greeting → reveal → gen2 with delta marks", async () => {
    // A staged ask makes Dispatch live (C8 gated the button on `gathering && onDispatch`).
    act(() =>
      store().reviewActions.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard the boundary",
      }),
    );
    // Records carried on the SAME source so the just-run round is reachable in the ledger.
    const timeline = createTimelineRoundsSource({ startTick: 0, records: [completedRoundRecord] });
    const { r, history, pump } = mountApp(timeline, "/s/s-1?view=handoff");

    // ── 1 · DISPATCH ────────────────────────────────────────────────────────────
    const button = r.getByRole("button", { name: "Dispatch Round" });
    expect(button.hasAttribute("disabled")).toBe(false); // live source + staged ask
    await r.user.click(button);
    expect(timeline.dispatchCount()).toBe(1); // dispatched exactly once
    expect(history.history.at(-1)).toBe("/s/s-1/run"); // took over the run route
    expect(r.container.querySelector('[data-screen="session-run"]')).not.toBeNull();

    // ── 2 · LIVE PROGRESS (rows advance on injected ticks, no wall clock) ─────────
    pump(5);
    expect(r.container.querySelector('[data-row="w-read"]')?.textContent).toContain("running");
    expect(r.container.querySelector('[data-row="w-record"]')?.textContent).toContain("queued");
    pump(6); // one tick forward: read settles, record picks up — no timers touched
    expect(r.container.querySelector('[data-row="w-read"]')?.textContent).toContain(
      "github-auth.ts",
    );
    expect(r.container.querySelector('[data-row="w-record"]')?.textContent).toContain("running");

    // ── 3 · REPORT VERIFICATION HOLDS THE RUN ROUTE ───────────────────────────────
    pump(COMPOSING_TICK);
    expect(history.history.at(-1)).toBe("/s/s-1/run");
    expect(r.container.querySelector('[data-phase="composing"]')).not.toBeNull();
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    expect(r.queryByTestId("reveal-new-boards")).toBeNull();

    // ── 4 · RETURN AND REVEAL AT VERIFIED COMPOSITION ────────────────────────────
    pump(FIXTURE_ROUND_COMPLETE_TICK);
    await waitFor(() => expect(history.history.at(-1)).toBe("/s/s-1"));
    expect(r.container.querySelector('[data-screen="round-greeting"]')).not.toBeNull();
    expect(r.getByTestId("report-tally").textContent).toContain("addressed");
    const reveal = r.getByTestId("reveal-new-boards");
    expect(reveal.hasAttribute("disabled")).toBe(false);

    // ── 5 · gen2 WITH DELTA MARKS (clicking reveal lands on the new generation) ────
    await r.user.click(reveal);
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull(); // single consume
    expect(r.container.querySelector('[data-generation="gen2"]')).not.toBeNull();
    // gen2's Flagged board carries two changed sections (reworked + new), both unviewed on
    // arrival — the C5 delta marks surfacing post-round (Reconciliation 5).
    expect(r.container.querySelectorAll('[data-testid="delta-dot"]')).toHaveLength(2);
  });

  it("the completed round is reachable in the ledger, opening its own generation", async () => {
    // After a round completes its record sits in the ledger; `?view=rounds` opens it —
    // the row, its report, and its own generation's boards, proven end to end over the real
    // workspace + the completed-round source. Finding 3: a producer-shaped `RoundRecord`
    // carries ONE generation (gen2), no persisted frozen predecessor — so the generation
    // switcher does not render, and drilling back to the predecessor is parked pending a B9
    // `RoundRecord` predecessor field (C09 ledger, F3).
    const history = memoryHistory("/s/s-1?view=rounds");
    const led = mount(
      <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <RoundsSourceProvider value={fixtureCompletedRoundsSource}>
            <ReviewWorkspace review={review} />
          </RoundsSourceProvider>
        </Router>
      </BridgeProvider>,
    );
    // The ledger lists the round and renders its report (the shared RoundReportBoard).
    expect(led.container.querySelector('[data-screen="rounds-ledger"]')).not.toBeNull();
    expect(led.container.querySelector('[data-round="1"]')).not.toBeNull();
    expect(led.container.querySelector('[data-kind="round-report"]')).not.toBeNull();
    // The round opens on its own generation (gen2); no frozen predecessor to switch to.
    // The lens boards arrive over `board.read`, so wait out the in-flight read.
    await waitFor(() =>
      expect(led.container.querySelector('article[data-generation="gen2"]')).not.toBeNull(),
    );
    expect(led.container.querySelector('[data-kind="generation-switcher"]')).toBeNull();
    led.unmount();
  });

  it("a cold deep-link to /s/:slug/run mid-round reattaches with dispatchCount stable (zero)", () => {
    // A fresh mount straight into a live round (no dispatch preceded it) — the reviewer
    // opening the run URL cold. It reattaches the live state and NEVER dispatches.
    const timeline = createTimelineRoundsSource({ startTick: 6 }); // mid-round (working)
    const { r } = mountApp(timeline, "/s/s-1/run");
    expect(r.container.querySelector('[data-phase="working"]')).not.toBeNull(); // reattached
    expect(timeline.dispatchCount()).toBe(0); // the double-dispatch guard: mount never dispatches
  });
});
