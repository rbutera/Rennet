// @vitest-environment happy-dom
//
// The review route binds the durable ask log (`useAskLog`) — the wiring the three exits
// depend on. `apps/desktop/src/ask-write-path.dom.test.tsx` proves the exits themselves over
// the REAL dispatch; it mounts the surface directly, so it would stay green if this route
// stopped binding the log. This is that seam, and only that: the route hydrates from
// `ask.read`, and a mutator called on the singleton slice — the same call every staging
// surface makes — reaches the bridge as the matching `ask.*` command under THIS review's id.
import { type AskProjection, findingRefKey, type Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const REPO = "/home/dev/widget";
const HELD_FINDING = {
  generation: "gen:ps-1",
  boardId: "board:flagged:ps-1",
  findingId: "finding-held",
};

function reviewAt(id: string): Review {
  return {
    id,
    repositoryRoot: REPO,
    status: "current",
    activePatchsetId: "ps-1",
    patchsets: [{ id: "ps-1", source: "local" }],
  } as unknown as Review;
}

/** A projection the daemon already holds for `rv-1` — what a reload comes back to. */
const HELD: AskProjection = {
  stagedAsks: {
    "src/a.ts:4": {
      id: "src/a.ts:4",
      anchor: "src/a.ts:4",
      type: "request-change",
      body: "held by the daemon",
    },
  },
  findingDispositions: {
    [findingRefKey(HELD_FINDING)]: { finding: HELD_FINDING, disposition: "dismissed" },
  },
  lineComments: { "src/a.ts": { "4": "held by the daemon" } },
  quoteThreads: {},
  retired: {},
  verdictOverride: "REQUEST_CHANGES",
};

const EMPTY: AskProjection = {
  stagedAsks: {},
  findingDispositions: {},
  lineComments: {},
  quoteThreads: {},
  retired: {},
  verdictOverride: null,
};

function mountWorkspace(review: Review) {
  const writes: { name: string; input: unknown }[] = [];
  const bridge = new MemoryBridge({
    "ask.read": (input) => ({
      projection: (input as { sessionId: string }).sessionId === "rv-1" ? HELD : EMPTY,
    }),
    "ask.stage": (input) => {
      writes.push({ name: "ask.stage", input });
      return { receipt: { kind: "unstage", id: "x" } };
    },
    "review.checkFreshness": () => ({ review }),
  });
  const history = memoryHistory(`/s/${review.id}`);
  const r = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <Switch>
          <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
        </Switch>
      </Router>
    </BridgeProvider>,
  );
  return { r, writes };
}

describe("the review route binds the durable ask log", () => {
  it("rehydrates the slice from what the daemon holds for this review", async () => {
    // A fresh renderer: the slice starts clean, and only the daemon can refill it.
    act(() => useRennetStore.getState().reviewActions.resetReview());
    expect(useRennetStore.getState().review.stagedAsks).toEqual({});

    mountWorkspace(reviewAt("rv-1"));

    await waitFor(() =>
      expect(useRennetStore.getState().review.stagedAsks["src/a.ts:4"]?.body).toBe(
        "held by the daemon",
      ),
    );
    expect(useRennetStore.getState().review.codeComments["src/a.ts"]?.[4]).toBe(
      "held by the daemon",
    );
    expect(
      useRennetStore.getState().review.findingDispositions[findingRefKey(HELD_FINDING)],
    ).toEqual({ finding: HELD_FINDING, disposition: "dismissed" });
    expect(useRennetStore.getState().review.verdictOverride).toBe("REQUEST_CHANGES");
  });

  it("writes a staged ask to THIS review's log — the id comes from the route, not the surface", async () => {
    act(() => useRennetStore.getState().reviewActions.resetReview());
    const { writes } = mountWorkspace(reviewAt("rv-2"));
    // Wait for the binding to be installed (the hydrate read settles first).
    await waitFor(() => expect(useRennetStore.getState().review.stagedAsks).toEqual({}));

    act(() =>
      useRennetStore.getState().reviewActions.stageAsk({
        id: "src/b.ts:9",
        anchor: "src/b.ts:9",
        type: "comment",
        body: "from the surface",
      }),
    );

    await waitFor(() => expect(writes).toHaveLength(1));
    // The session id is the OPEN review's, supplied by the route. No staging surface passes
    // one, so an ask can never land in another review's log.
    expect(writes[0]?.input).toEqual({
      sessionId: "rv-2",
      ask: {
        id: "src/b.ts:9",
        anchor: "src/b.ts:9",
        type: "comment",
        body: "from the surface",
      },
    });
  });

  it("writes nowhere once the route unmounts — a mutator between reviews cannot reach the old log", async () => {
    act(() => useRennetStore.getState().reviewActions.resetReview());
    const { r, writes } = mountWorkspace(reviewAt("rv-2"));
    await waitFor(() => expect(useRennetStore.getState().review.stagedAsks).toEqual({}));
    r.unmount();

    act(() =>
      useRennetStore.getState().reviewActions.stageAsk({
        id: "src/c.ts:1",
        anchor: "src/c.ts:1",
        type: "comment",
        body: "orphan",
      }),
    );
    // The local slice still took it (the surfaces stay live); nothing was written.
    expect(useRennetStore.getState().review.stagedAsks["src/c.ts:1"]).toBeTruthy();
    expect(writes).toEqual([]);
  });
});
