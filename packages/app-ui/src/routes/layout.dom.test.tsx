// @vitest-environment happy-dom
//
// The three-region frame (C03 §1). The risk-4 dock-identity proof lives in
// app.dom.test.tsx (untouched); this is its extension — the R47 amendment: the
// closed dock keeps its child MOUNTED, hidden by width-0 + `inert`, and sheds the
// `inert` on a session route with the chat open. Positive control (shown once
// during verification): dropping the `inert` wiring in layout.tsx reddens the
// takeover assertion below.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { frontDoorBridge } from "../test/fixtures/front-door";
import { RennetRouterApp } from "./app";
import { memoryHistory } from "./history";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, chatOpen: false, sidebarOpen: true, chatWidth: 420 },
  }));
});

/** Force a viewport width and fire the resize the frame listens on. */
function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  act(() => window.dispatchEvent(new Event("resize")));
}

// A wide default so an unclamped default width renders in full; the clamp cases set
// their own narrow viewport. (happy-dom's own default is 1024, below the room a 420
// dock + 256 panel + 400 surface needs — the clamp would otherwise engage here.)
beforeEach(() => setViewport(1600));

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

describe("frame chat-width clamp (400px surface minimum + ARIA range)", () => {
  it("clamps a stored width that overflows a shrunken viewport, keeping the surface floor", async () => {
    // A width saved when there was room, then the viewport shrinks under it.
    act(() => {
      useRennetStore.getState().uiActions.setChatOpen(true);
      useRennetStore.getState().uiActions.setChatWidth(900);
    });
    setViewport(1024); // panel 256 + surface 400 leaves 368 for the dock
    const { getByTestId, getByLabelText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    // 1024 − 256 (panel) − 400 (surface floor) = 368: NOT the stored 900.
    expect(getByTestId("chat-dock-slot").style.width).toBe("368px");
    const handle = getByLabelText("Resize chat column");
    expect(handle.getAttribute("aria-valuenow")).toBe("368");
    // aria-valuenow never exceeds aria-valuemax.
    expect(handle.getAttribute("aria-valuemax")).toBe("368");
  });

  it("re-clamps when the rail expands to the panel and steals the dock's room", async () => {
    act(() => {
      useRennetStore.getState().uiActions.setChatOpen(true);
      useRennetStore.getState().uiActions.setChatWidth(500);
      useRennetStore.getState().uiActions.setSidebarOpen(false); // rail: 48px
    });
    setViewport(1024); // rail 48 + surface 400 leaves 576 — 500 fits
    const { getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    expect(getByTestId("chat-dock-slot").style.width).toBe("500px");
    // Expanding the sidebar to the 256px panel drops the max to 368 — the dock clamps down.
    act(() => useRennetStore.getState().uiActions.setSidebarOpen(true));
    await waitFor(() => expect(getByTestId("chat-dock-slot").style.width).toBe("368px"));
  });
});
