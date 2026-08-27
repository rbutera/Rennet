// @vitest-environment happy-dom
//
// Dispatch wiring (C09 cluster 4, task 4.2) — closing C8's `onDispatch` seam. Load-bearing
// claims: over a source that CAN dispatch, staged asks + **Dispatch Round** resets the run
// slice, fires the seam's `dispatch(slug)` EXACTLY once, and navigates to `/s/:slug/run`
// where the run route takes over. The honest-absent half (no source ⇒ button disabled) is
// proven in `handoff/rounds-lanes.dom.test.tsx` (the default source has no `dispatch`).
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { RunRoute } from "../rounds/run-route";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { createTimelineRoundsSource } from "../test/fixtures/rounds";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

// A stable-id own-branch review (no `postTarget`) — the stable id means the first mount does
// not reset the review slice, so a pre-staged ask survives into the handoff surface.
const review = { id: "ob-1", activePatchsetId: "ps-1" } as unknown as Review;

afterEach(() => {
  cleanup();
  act(() => {
    store().reviewActions.resetReview();
    store().runActions.resetRun();
  });
});

/** Mount the two routes (workspace + run) under ONE rounds source — what cluster 7 wires. */
function mountApp(source: ReturnType<typeof createTimelineRoundsSource>["source"]) {
  const history = memoryHistory("/s/s-1?view=handoff");
  const r = mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <RoundsSourceProvider value={source}>
          <Switch>
            <Route path={ROUTES.sessionRun}>{(p) => <RunRoute slug={p.slug ?? ""} />}</Route>
            <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
          </Switch>
        </RoundsSourceProvider>
      </Router>
    </BridgeProvider>,
  );
  return { r, history };
}

describe("dispatch wiring (C09 cluster 4)", () => {
  it("Dispatch Round dispatches once, resets the run, and takes over the run route", async () => {
    act(() =>
      store().reviewActions.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard the boundary",
      }),
    );
    // Stale run state that a dispatch must clear (proves resetRun fires at the dispatch act).
    act(() => store().runActions.setRoundProgress(0.5));

    const timeline = createTimelineRoundsSource({ startTick: 0 });
    const { r, history } = mountApp(timeline.source);

    // The source CAN dispatch + an ask is staged ⇒ the button is live (no fake enablement,
    // no honest-absent disable).
    const button = r.getByRole("button", { name: "Dispatch Round" });
    expect(button.hasAttribute("disabled")).toBe(false);

    await r.user.click(button);

    // Dispatched exactly once (not on the run route's mount — cluster 3 proves that half).
    expect(timeline.dispatchCount()).toBe(1);
    // Reset happened at the dispatch act.
    expect(store().run.roundProgress).toBeNull();
    // Navigated to the run route, which took over (the in-flight live-run surface renders).
    expect(history.history.at(-1)).toBe("/s/s-1/run");
    expect(r.container.querySelector('[data-screen="session-run"]')).not.toBeNull();
  });
});
