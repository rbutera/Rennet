// @vitest-environment happy-dom
//
// C07 first-class identity proof (task 1.4 / 8.3). The dock mounts ONCE as the child of
// C3's always-mounted `data-slot="chat-dock"` OUTSIDE the outlet, so navigation — which
// swaps only the outlet — never unmounts it. This mounts the REAL `AppLayout`, appends a
// turn to the transcript over `MemoryBridge` + `emitAskStream`, and drives every route
// transition the router exposes today (session ↔ takeover, session ↔ session, board ↔ diff
// ↔ map view refinements), asserting `getByTestId("chat-dock-transcript")` is `toBe`-
// identical across every hop and the appended turn persists (the dock stays mounted while
// `inert`). The identity is the slot's non-unmounting lifetime — independent of B9.
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { AppLayout } from "../routes/layout";
import { ROUTES } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { type SessionTranscriptProjection, SessionTranscriptProvider } from "./chat-data";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false } }));
});

const REVIEW_ID = "review-1";

function projection(): SessionTranscriptProjection {
  return { reviewId: REVIEW_ID, rows: [], trail: { title: "Alpha review" } };
}

function DockHarness({
  bridge,
  history,
}: {
  readonly bridge: MemoryBridge;
  readonly history: ReturnType<typeof memoryHistory>;
}): ReactNode {
  return (
    <BridgeProvider bridge={bridge}>
      <SessionTranscriptProvider value={projection()}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <AppLayout>
            <Switch>
              <Route path={ROUTES.session}>
                {(p) => <div data-screen="session">{p.slug}</div>}
              </Route>
              <Route path={ROUTES.settings}>
                {(p) => <div data-screen="settings">{p.page}</div>}
              </Route>
              <Route>
                <div data-screen="other" />
              </Route>
            </Switch>
          </AppLayout>
        </Router>
      </SessionTranscriptProvider>
    </BridgeProvider>
  );
}

function mountDock(path: string) {
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "review.reattach": () => ({ threads: [], inFlight: [] }),
  });
  const history = memoryHistory(path);
  act(() => useRennetStore.getState().uiActions.setChatOpen(true));
  const utils = mount(<DockHarness bridge={bridge} history={history} />);
  return { ...utils, bridge, history };
}

/** Fold a complete live turn onto the ask stream, so the transcript has a real appended row.
 *  Settles the initial `review.reattach` load first — in production the reattach lands before
 *  streaming starts, so the deltas fold onto the reloaded snapshot rather than being clobbered. */
async function appendTurn(bridge: MemoryBridge, body: string): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  const threadId = "t-1";
  const turnId = "u-1";
  act(() => {
    bridge.emitAskStream(REVIEW_ID, {
      kind: "ask-delta",
      threadId,
      turnId,
      channel: "orchestrator",
      delta: body,
      seq: 0,
    });
    bridge.emitAskStream(REVIEW_ID, {
      kind: "ask-complete",
      threadId,
      turnId,
      channel: "orchestrator",
      model: "opus",
      finalBody: body,
      seq: 1,
    });
  });
}

describe("chat dock identity across navigation (R47/R52, task 1.4)", () => {
  it("keeps the SAME transcript DOM node and the appended turn across every route hop", async () => {
    const { getByTestId, history, bridge, findByText } = mountDock(`/s/${REVIEW_ID}`);

    // The transcript is mounted from the layout, not a route.
    const transcript = getByTestId("chat-dock-transcript");
    expect(transcript).toBeTruthy();

    // Append a real turn over the ask stream, then assert it rendered.
    await appendTurn(bridge, "The matcher still excludes those routes.");
    await findByText(/matcher still excludes/);

    const hops = [
      "/settings/appearance", // takeover — dock goes width-0 + inert, but stays mounted
      `/s/${REVIEW_ID}`, // back to the session
      "/s/review-2", // a DIFFERENT session slug (same route, same dock)
      `/s/${REVIEW_ID}?view=diff`, // the diff view refinement
      `/s/${REVIEW_ID}?view=map`, // the map view refinement
      `/s/${REVIEW_ID}`, // back to the board
    ];
    for (const path of hops) {
      act(() => history.navigate(path));
      // The SAME DOM node every hop — navigation swapped only the outlet.
      expect(getByTestId("chat-dock-transcript")).toBe(transcript);
      // The appended turn survives every transition (the dock never unmounted).
      expect(transcript.textContent).toContain("matcher still excludes");
    }
  });

  it("keeps the transcript node mounted through a takeover (inert, not unmounted)", async () => {
    const { getByTestId, history, bridge, findByText } = mountDock(`/s/${REVIEW_ID}`);
    const transcript = getByTestId("chat-dock-transcript");
    await appendTurn(bridge, "A settled record.");
    await findByText(/settled record/);

    // On a takeover route the slot is inert + width 0, but its transcript child is the
    // same mounted node — the record is still in the DOM, just out of view/tab order.
    act(() => history.navigate("/settings/appearance"));
    expect(getByTestId("chat-dock-transcript")).toBe(transcript);
    expect(transcript.textContent).toContain("settled record");
    expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(true);
  });
});
