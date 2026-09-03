// @vitest-environment happy-dom
//
// C07 first-class identity proof (task 1.4 / 8.3), re-pointed at the T3 dock
// (t3-lens-threads 4.2). The dock mounts ONCE as the child of C3's always-mounted
// `data-slot="chat-dock"` OUTSIDE the outlet, so navigation — which swaps only the outlet —
// never unmounts it. That guarantee still matters and matters MORE now: the node that must
// survive is the one hosting a live T3 turn, and remounting it would drop the thread view's
// subscription mid-turn.
//
// This mounts the REAL `AppLayout` and drives every route transition the router exposes
// (session ↔ takeover, session ↔ session, board ↔ diff ↔ map view refinements), asserting
// `data-slot="t3-chat-dock"` is `toBe`-identical across every hop. The identity assertion is
// on the NODE, not on content: the transcript is T3's now, and no Rennet row survives to
// count. A React remount would mint a new element and fail `toBe` — which is the whole claim.
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

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false } }));
});

const REVIEW_ID = "review-1";

function DockHarness({
  bridge,
  history,
}: {
  readonly bridge: MemoryBridge;
  readonly history: ReturnType<typeof memoryHistory>;
}): ReactNode {
  return (
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <AppLayout>
          <Switch>
            <Route path={ROUTES.session}>{(p) => <div data-screen="session">{p.slug}</div>}</Route>
            <Route path={ROUTES.settings}>
              {(p) => <div data-screen="settings">{p.page}</div>}
            </Route>
            <Route>
              <div data-screen="other" />
            </Route>
          </Switch>
        </AppLayout>
      </Router>
    </BridgeProvider>
  );
}

function mountDock(path: string) {
  const bridge = new MemoryBridge(frontDoorHandlers());
  const history = memoryHistory(path);
  act(() => useRennetStore.getState().uiActions.setChatOpen(true));
  const utils = mount(<DockHarness bridge={bridge} history={history} />);
  return { ...utils, bridge, history };
}

function dockNode(): Element {
  const node = document.querySelector('[data-slot="t3-chat-dock"]');
  if (!node) throw new Error("the T3 chat dock is not mounted");
  return node;
}

describe("chat dock identity across navigation (R47/R52, task 1.4)", () => {
  it("keeps the SAME dock DOM node across every route hop", async () => {
    const { history } = mountDock(`/s/${REVIEW_ID}`);
    await act(async () => {
      await Promise.resolve();
    });

    // The dock is mounted from the layout, not a route.
    const dock = dockNode();

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
      // The SAME DOM node every hop — navigation swapped only the outlet. A remount would
      // give a different element here, which is what would drop a running thread's view.
      expect(dockNode()).toBe(dock);
    }
  });

  it("keeps the dock node mounted through a takeover (inert, not unmounted)", async () => {
    const { getByTestId, history } = mountDock(`/s/${REVIEW_ID}`);
    await act(async () => {
      await Promise.resolve();
    });
    const dock = dockNode();

    // On a takeover route the slot is inert + width 0, but its dock child is the same
    // mounted node — out of view and out of tab order, not destroyed.
    act(() => history.navigate("/settings/appearance"));
    expect(dockNode()).toBe(dock);
    expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(true);
  });
});
