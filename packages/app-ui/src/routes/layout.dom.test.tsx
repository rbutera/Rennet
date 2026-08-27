// @vitest-environment happy-dom
//
// The three-region frame (C03 §1). The risk-4 dock-identity proof lives in
// app.dom.test.tsx (untouched); this is its extension — the R47 amendment: the
// closed dock keeps its child MOUNTED, hidden by width-0 + `inert`, and sheds the
// `inert` on a session route with the chat open. Positive control (shown once
// during verification): dropping the `inert` wiring in layout.tsx reddens the
// takeover assertion below.
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { frontDoorBridge } from "../test/fixtures/front-door";
import { RennetRouterApp } from "./app";
import { memoryHistory } from "./history";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false } }));
});

describe("frame chat-dock slot (R47 amendment)", () => {
  it("stays mounted + inert + width 0 on a takeover route, sheds inert on a session route", async () => {
    // Chat open, so the ONLY thing gating the dock is the route class.
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const history = memoryHistory("/new-chat"); // a takeover route
    const { getByTestId } = mount(<RennetRouterApp bridge={frontDoorBridge()} history={history} />);

    const dock = getByTestId("chat-dock-slot");
    // Takeover: mounted, out of the tab order, collapsed to nothing.
    expect(dock.hasAttribute("inert")).toBe(true);
    expect(dock.style.width).toBe("0px");

    // A session route with the chat open: the SAME node, now interactive + sized.
    act(() => history.navigate("/s/review-1"));
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    const dockAfter = getByTestId("chat-dock-slot");
    expect(dockAfter).toBe(dock); // identity preserved across the navigation
    expect(dockAfter.style.width).toBe("420px");
  });
});
