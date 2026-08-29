// @vitest-environment happy-dom
//
// Dispatch wiring (C09 cluster 4, task 4.2) — closing C8's `onDispatch` seam. Load-bearing
// claims: over a source that CAN dispatch, staged asks + **Dispatch Round** resets the run
// slice, fires the seam's `dispatch(slug)` EXACTLY once, and navigates to `/s/:slug/run`
// where the run route takes over. The honest-absent half (no source ⇒ button disabled) is
// proven in `handoff/rounds-lanes.dom.test.tsx` (the default source has no `dispatch`).
//
// The second test here is the one that answers "does it SHIP wired?". It mounts `RennetRouterApp`
// itself — the whole app tree, no source supplied — because any mount that hands in its own
// `RoundsSourceProvider` (fixture or the real `LiveRoundsScope`) can only ever prove the source it
// was given, and would keep passing if `routes/app.tsx` dropped the scope entirely.
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { RunRoute } from "../rounds/run-route";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { createTimelineRoundsSource } from "../test/fixtures/rounds";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

// A stable-id own-branch review (no `postTarget`) — the stable id means the first mount does
// not reset the review slice, so a pre-staged ask survives into the handoff surface.
const review = { id: "ob-1", activePatchsetId: "ps-1" } as unknown as Review;

/** A schema-real own-branch review the daemon serves for `/s/rev-1` (no `postTarget` ⇒ the
 *  handoff resolves the rounds lane, which is where Dispatch Round lives). */
const OWN_BRANCH_REVIEW = {
  id: "rev-1",
  repositoryRoot: "/repo",
  patchsets: [
    {
      id: "ps-1",
      createdAt: "2026-08-28T00:00:00.000Z",
      repository: {
        id: "repo",
        root: "/repo",
        commonDir: "/repo/.git",
        baseRef: "main",
        baseOid: "b0",
        headOid: "h0",
      },
      files: [],
      rawDiff: "X",
      byteLength: 1,
      truncated: false,
    },
  ],
  activePatchsetId: "ps-1",
  dispositions: [],
  status: "current",
};

afterEach(() => {
  cleanup();
  act(() => {
    store().reviewActions.resetReview();
    store().runActions.resetRun();
  });
});

/** The two routes (workspace + run) cluster 7 wires under ONE rounds source. */
function routes() {
  return (
    <Switch>
      <Route path={ROUTES.sessionRun}>{(p) => <RunRoute slug={p.slug ?? ""} />}</Route>
      <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
    </Switch>
  );
}

/** Mount those routes under a FIXTURE source — the seam's behaviour, not the app's wiring. */
function mountApp(source: ReturnType<typeof createTimelineRoundsSource>["source"]) {
  const history = memoryHistory("/s/s-1?view=handoff");
  const r = mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <RoundsSourceProvider value={source}>{routes()}</RoundsSourceProvider>
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

  it("SHIPS wired: the app tree's own rounds scope makes Dispatch Round live", async () => {
    act(() =>
      store().reviewActions.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard the boundary",
      }),
    );

    // The whole app, from `RennetRouterApp` down, with NO rounds source handed in — the tree's own
    // `LiveRoundsScope` (C15 3.2) is the only thing that can supply one. `useLiveRoundsSource`
    // returns `dispatch` unconditionally, so the exit is live even though this bridge answers none
    // of the rounds READS: a client that cannot yet read the ledger can still kick a round.
    //
    // Remove `<LiveRoundsScope>` from `routes/app.tsx` and this reddens. Nothing else in the suite
    // would: every other rounds test supplies its own provider, which is exactly how a lane that
    // shipped permanently disabled could have passed review.
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      ...sessionHandlers([{ id: "rev-1", projectId: "proj-1" }]),
      "review.load": () => ({ review: OWN_BRANCH_REVIEW }),
    } as never);
    const r = mount(
      <RennetRouterApp bridge={bridge} history={memoryHistory("/s/rev-1?view=handoff")} />,
    );

    const button = await r.findByRole("button", { name: "Dispatch Round" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});
