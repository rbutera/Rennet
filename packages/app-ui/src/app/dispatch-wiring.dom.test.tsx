// @vitest-environment happy-dom
//
// Dispatch wiring (C09 cluster 4, task 4.2) — closing C8's `onDispatch` seam. Load-bearing
// claims: over a source that CAN dispatch, staged asks + **Dispatch Round** fires the seam's
// `dispatch(slug)` EXACTLY once; an accepted answer resets the run slice and navigates to
// `/s/:slug/run`, where the run route takes over. The honest-absent half (no source ⇒ disabled) is
// proven in `handoff/rounds-lanes.dom.test.tsx` (the default source has no `dispatch`).
//
// The second test here is the one that answers "does it SHIP wired?". It mounts `RennetRouterApp`
// itself — the whole app tree, no source supplied — because any mount that hands in its own
// `RoundsSourceProvider` (fixture or the real `LiveRoundsScope`) can only ever prove the source it
// was given, and would keep passing if `routes/app.tsx` dropped the scope entirely.
import {
  type CommandOutput,
  parseCommandOutput,
  type Review,
  type RoundOperationProgressSnapshot,
} from "@rennet/protocol";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import {
  type RoundDispatchOutcome,
  type RoundsSource,
  RoundsSourceProvider,
} from "../rounds/rounds-data";
import { RunRoute } from "../rounds/run-route";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { createTimelineRoundsSource } from "../test/fixtures/rounds";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

// A stable-id own-branch review (no `postTarget`) — the stable id means the first mount does
// not reset the review slice, so a pre-staged ask survives into the handoff surface.
const review = { id: "ob-1", activePatchsetId: "ps-1" } as unknown as Review;

/** A schema-real own-branch review the daemon serves for `/s/rev-1` (no `postTarget` ⇒ the
 *  handoff resolves the rounds lane, which is where Dispatch Round lives). */
const OWN_BRANCH_REVIEW_OUTPUT = parseCommandOutput("review.load", {
  review: {
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
  },
  repositoryPresent: true,
});

const ACCEPTED_OPERATION = {
  operationId: "operation-dispatch-wiring",
  revision: 0,
  createdAt: Date.UTC(2026, 7, 31, 9, 0),
  roundNumber: 1,
  sourceTarget: { kind: "branch", branch: "feat/dispatch-wiring" },
  askCount: 1,
  gatePlan: { kind: "absent" },
  state: { phase: "claimed" },
} satisfies RoundOperationProgressSnapshot;

afterEach(() => {
  cleanup();
  act(() => {
    store().reviewActions.resetReview();
    store().runActions.resetRun();
  });
});

function SettleOnLayout({ settle }: { readonly settle: () => void }) {
  useLayoutEffect(settle, [settle]);
  return <span>left session</span>;
}

/** The two routes (workspace + run) cluster 7 wires under ONE rounds source. */
function routes(settleOnLeave?: () => void) {
  return (
    <Switch>
      <Route path={ROUTES.sessionRun}>{(p) => <RunRoute slug={p.slug ?? ""} />}</Route>
      <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
      {settleOnLeave ? (
        <Route path={ROUTES.newChat}>
          <SettleOnLayout settle={settleOnLeave} />
        </Route>
      ) : null}
    </Switch>
  );
}

/** Mount those routes under a FIXTURE source — the seam's behaviour, not the app's wiring. */
function mountApp(source: RoundsSource, settleOnLeave?: () => void) {
  const history = memoryHistory("/s/s-1?view=handoff");
  const r = mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <RoundsSourceProvider value={source}>{routes(settleOnLeave)}</RoundsSourceProvider>
      </Router>
    </BridgeProvider>,
  );
  return { r, history };
}

function roundDispatchOutput(
  reviewId: string,
  dispatched: boolean,
  acceptedOperation?: RoundOperationProgressSnapshot,
): CommandOutput<"round.dispatch"> {
  const askId = "src/a.ts:5";
  return parseCommandOutput("round.dispatch", {
    workOrder: {
      reviewId,
      patchsetId: "ps-1",
      tasks: dispatched
        ? [
            {
              title: "Guard the boundary",
              sourceDispositions: [askId],
              asks: [
                {
                  id: askId,
                  path: "src/a.ts",
                  type: "request-change",
                  instruction: "guard the boundary",
                  context: "@@ -5,1 +5,1 @@",
                },
              ],
            },
          ]
        : [],
      prompt: dispatched ? "Guard the boundary\n\nsrc/a.ts: guard the boundary" : "",
      digest: "dispatch-wiring",
      composed: dispatched,
      traceMap: dispatched ? { [askId]: 0 } : {},
    },
    dispatched,
    ...(acceptedOperation === undefined ? {} : { acceptedOperation }),
  });
}

function liveBridge(dispatch: NonNullable<MemoryBridgeHandlers["round.dispatch"]>): MemoryBridge {
  const handlers: MemoryBridgeHandlers = {
    ...frontDoorHandlers(),
    ...sessionHandlers([{ id: "rev-1", projectId: "proj-1" }]),
    "review.load": () => OWN_BRANCH_REVIEW_OUTPUT,
    "round.dispatch": dispatch,
  };
  return new MemoryBridge(handlers);
}

describe("dispatch wiring (C09 cluster 4)", () => {
  it("an accepted Dispatch Round resets the run and takes over the run route once", async () => {
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
    // The accepted answer resets stale run state and only then hands the route to the live run.
    await waitFor(() => expect(store().run.roundProgress).toBeNull());
    expect(history.history.at(-1)).toBe("/s/s-1/run");
    expect(r.container.querySelector('[data-screen="session-run"]')).not.toBeNull();
  });

  it("SHIPS wired: only an accepted dispatch takes the full app tree to the run route", async () => {
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
    const history = memoryHistory("/s/rev-1?view=handoff");
    const bridge = liveBridge(() => roundDispatchOutput("rev-1", true, ACCEPTED_OPERATION));
    const r = mount(<RennetRouterApp bridge={bridge} history={history} />);

    const button = await r.findByRole("button", { name: "Dispatch Round" });
    expect(button.hasAttribute("disabled")).toBe(false);
    await r.user.click(button);
    expect(history.history.at(-1)).toBe("/s/rev-1/run");
    await waitFor(() =>
      expect(r.container.querySelector('[data-screen="session-run"]')).not.toBeNull(),
    );
  });

  it("keeps the full app tree on Handoff when the daemon dispatches no round", async () => {
    act(() =>
      store().reviewActions.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard the boundary",
      }),
    );

    const history = memoryHistory("/s/rev-1?view=handoff");
    const bridge = liveBridge(() => roundDispatchOutput("rev-1", false));
    const r = mount(<RennetRouterApp bridge={bridge} history={history} />);

    await r.user.click(await r.findByRole("button", { name: "Dispatch Round" }));

    expect(history.history.at(-1)).toBe("/s/rev-1?view=handoff");
    const noRound = await r.findByText(
      "Rennet did not start a coding round. Questions and approvals remain staged for the review.",
    );
    expect(noRound.getAttribute("role")).toBe("status");
    expect(r.container.querySelector('[data-screen="session-run"]')).toBeNull();
  });

  it("keeps the full app tree on Handoff without an accepted operation", async () => {
    act(() =>
      store().reviewActions.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard the boundary",
      }),
    );

    const history = memoryHistory("/s/rev-1?view=handoff");
    const bridge = liveBridge(() => roundDispatchOutput("rev-1", true));
    const r = mount(<RennetRouterApp bridge={bridge} history={history} />);

    await r.user.click(await r.findByRole("button", { name: "Dispatch Round" }));

    expect(history.history.at(-1)).toBe("/s/rev-1?view=handoff");
    const notAccepted = await r.findByText(
      "Rennet did not receive the accepted operation for this coding round. Try dispatching again.",
    );
    expect(notAccepted.getAttribute("role")).toBe("alert");
    expect(r.container.querySelector('[data-screen="session-run"]')).toBeNull();
  });

  it.each([
    { name: "accepted", outcome: { status: "accepted" } as const },
    {
      name: "not dispatched",
      outcome: { status: "not-dispatched", reason: "late A no-round" } as const,
    },
    {
      name: "rejected",
      outcome: { status: "rejected", reason: "late A failure" } as const,
    },
  ])(
    "ignores a late $name answer after the route moves to another session",
    async ({ outcome }) => {
      act(() => {
        store().reviewActions.stageAsk({
          id: "src/a.ts:5",
          anchor: "src/a.ts:5",
          type: "request-change",
          body: "guard the boundary",
        });
        store().runActions.setRoundProgress(0.5);
      });
      let settle: ((answer: RoundDispatchOutcome) => void) | undefined;
      const source: RoundsSource = {
        ...createTimelineRoundsSource({ startTick: 0 }).source,
        dispatch: () =>
          new Promise<RoundDispatchOutcome>((resolve) => {
            settle = resolve;
          }),
      };
      const { r, history } = mountApp(source);

      await r.user.click(r.getByRole("button", { name: "Dispatch Round" }));
      act(() => history.navigate("/s/s-2?view=handoff"));
      await waitFor(() => expect(r.getByRole("button", { name: "Dispatch Round" })).toBeTruthy());

      await act(async () => {
        settle?.(outcome);
        await Promise.resolve();
      });

      expect(history.history.at(-1)).toBe("/s/s-2?view=handoff");
      expect(store().run.roundProgress).toBe(0.5);
      expect(r.container.querySelector('[data-screen="session-run"]')).toBeNull();
      expect(r.queryByText("Dispatching…")).toBeNull();
      if (outcome.status !== "accepted") expect(r.queryByText(outcome.reason)).toBeNull();
    },
  );

  it("ignores a late accepted answer after the session subtree unmounts", async () => {
    act(() => {
      store().reviewActions.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard the boundary",
      });
      store().runActions.setRoundProgress(0.5);
    });
    let settle: ((answer: RoundDispatchOutcome) => void) | undefined;
    const source: RoundsSource = {
      ...createTimelineRoundsSource({ startTick: 0 }).source,
      dispatch: () =>
        new Promise<RoundDispatchOutcome>((resolve) => {
          settle = resolve;
        }),
    };
    const { r, history } = mountApp(source, () => settle?.({ status: "accepted" }));

    await r.user.click(r.getByRole("button", { name: "Dispatch Round" }));
    act(() => history.navigate("/new-chat"));
    await waitFor(() => expect(r.getByText("left session")).toBeTruthy());
    await act(async () => Promise.resolve());

    expect(history.history.at(-1)).toBe("/new-chat");
    expect(store().run.roundProgress).toBe(0.5);
    expect(r.container.querySelector('[data-screen="session-run"]')).toBeNull();
  });
});
