// @vitest-environment happy-dom
//
// The three-region frame (C03 §1). The risk-4 dock-identity proof lives in
// app.dom.test.tsx (untouched); this is its extension — the R47 amendment: the
// closed dock keeps its child MOUNTED, hidden by width-0 + `inert`, and sheds the
// `inert` on a session route with the chat open. Positive control (shown once
// during verification): dropping the `inert` wiring in layout.tsx reddens the
// takeover assertion below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRennetStore, useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
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
    // 420 chat + the 4px canvas gutter the wrapper carries (prototype `chatWidth + 4`).
    expect(dockAfter.style.width).toBe("424px");
  });
});

describe("frame dock gutter (the chat renders at chatWidth, the 4px is canvas beside it)", () => {
  it("pads the gutter off the wrapper and puts the hairline on the inner dock", async () => {
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const { getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    const wrapper = getByTestId("chat-dock-slot");
    // happy-dom has no layout engine, so this is the geometry as DECLARED, not measured:
    // border-box width minus the right padding IS the inner dock's width. It is the
    // arithmetic Codex's finding turned on — drop the padding and the chat renders 424.
    expect(wrapper.style.width).toBe("424px");
    expect(wrapper.style.paddingRight).toBe("4px");
    expect(
      Number.parseInt(wrapper.style.width, 10) - Number.parseInt(wrapper.style.paddingRight, 10),
    ).toBe(useRennetStore.getState().ui.chatWidth);
    // ...and the hairline moved WITH the chat: on the inner dock, at chatWidth, with the
    // gutter of bare canvas to its right. On the wrapper it would sit at 424.
    const inner = wrapper.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toContain("border-r");
    expect(inner.className).toContain("border-r");
    // Closed, the padding goes too — a 0-width border-box would otherwise floor at 4px
    // and leave a permanent sliver of dock on screen.
    act(() => useRennetStore.getState().uiActions.setChatOpen(false));
    await waitFor(() => expect(getByTestId("chat-dock-slot").style.width).toBe("0px"));
    expect(getByTestId("chat-dock-slot").style.paddingRight).toBe("0px");
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
    // 1024 − 256 (panel) − 400 (surface floor) − 4 (divider gutter) = 364: NOT the stored
    // 900. The rendered wrapper is that plus the gutter, so the surface keeps a full 400.
    expect(getByTestId("chat-dock-slot").style.width).toBe("368px");
    const handle = getByLabelText("Resize chat column");
    expect(handle.getAttribute("aria-valuenow")).toBe("364");
    // aria-valuenow never exceeds aria-valuemax.
    expect(handle.getAttribute("aria-valuemax")).toBe("364");
  });

  it("re-clamps when the collapsed sidebar expands and steals the dock's room", async () => {
    act(() => {
      useRennetStore.getState().uiActions.setChatOpen(true);
      useRennetStore.getState().uiActions.setChatWidth(500);
      useRennetStore.getState().uiActions.setSidebarOpen(false); // collapsed: 0px (C20)
    });
    setViewport(1024); // collapsed 0 + surface 400 + 4 gutter leaves 620 — 500 fits
    const { getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    expect(getByTestId("chat-dock-slot").style.width).toBe("504px"); // 500 + the gutter
    // Expanding the sidebar to the 256px panel drops the max to 364 — the dock clamps down.
    act(() => useRennetStore.getState().uiActions.setSidebarOpen(true));
    await waitFor(() => expect(getByTestId("chat-dock-slot").style.width).toBe("368px"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The width-transition suppression is a TRAILING DEBOUNCE off each width CHANGE — the
// prototype's shape verbatim (`spikes/board-prototype/components/shell.tsx`: `onChange`
// sets `resizingChat`, clears the pending timer and sets a fresh 200ms one). It is NOT
// keyed on the pointer being down, so a mid-drag pause re-arms; that is the prototype's
// accepted trade and it is also what stops an interrupted drag stranding the suppression.
// ─────────────────────────────────────────────────────────────────────────────

describe("frame width-transition suppression (a 200ms trailing debounce off each change)", () => {
  it("suppresses on a width change and re-arms 200ms after the LAST one, pointer still down", async () => {
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const { getByTestId, getByLabelText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    const dock = getByTestId("chat-dock-slot");
    const handle = getByLabelText("Resize chat column");
    expect(dock.className).toContain("transition-[width]");
    vi.useFakeTimers();
    try {
      // Pointer DOWN alone changes no width, so it suppresses nothing — the divider that
      // is merely clicked never animates the dock.
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0 });
      expect(dock.className).toContain("transition-[width]");
      // The first move is the first width change: suppressed from here.
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40 });
      expect(dock.className).not.toContain("transition-[width]");
      expect(dock.style.width).toBe("464px"); // 420 + 40, + the 4px gutter
      // A mid-drag PAUSE re-arms on the trailing timer even under a held pointer.
      act(() => void vi.advanceTimersByTime(199));
      expect(dock.className).not.toContain("transition-[width]");
      act(() => void vi.advanceTimersByTime(1));
      expect(dock.className).toContain("transition-[width]");
      // ...and the next move suppresses it again, resetting the tail: 199ms after move A
      // plus another move B leaves it suppressed at 199ms past B, not re-armed at 200 past A.
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 80 });
      act(() => void vi.advanceTimersByTime(199));
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120 });
      act(() => void vi.advanceTimersByTime(199));
      expect(dock.className).not.toContain("transition-[width]");
      act(() => void vi.advanceTimersByTime(1));
      expect(dock.className).toContain("transition-[width]");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the suppression when the chat closes mid-drag, so the dock slides shut", async () => {
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const { getByTestId, getByLabelText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    const dock = getByTestId("chat-dock-slot");
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(getByLabelText("Resize chat column"), {
        button: 0,
        pointerId: 1,
        clientX: 0,
      });
      fireEvent.pointerMove(getByLabelText("Resize chat column"), { pointerId: 1, clientX: 40 });
      expect(dock.className).not.toContain("transition-[width]");
      // The divider unmounts with the dock and no pointer event ever arrives. WITHOUT
      // advancing the tail: the close must not snap shut on a stranded suppression.
      act(() => useRennetStore.getState().uiActions.setChatOpen(false));
      expect(dock.className).toContain("transition-[width]");
      expect(dock.style.width).toBe("0px");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The corner slot's focus hand-off (C20 §2.4). Collapsing the sidebar unmounts the
// toggle that was focused; the slot's counterpart toggle now lives OUTSIDE the
// `<aside>` (the floating pill, or the chat header), so the sidebar's refocus effect
// must search the document, not its own subtree. Scoped to the aside, a keyboard
// collapse strands focus on <body>.
// ─────────────────────────────────────────────────────────────────────────────

describe("corner-slot focus hand-off across a collapse (C20)", () => {
  it("lands focus on the slot's Expand toggle, not <body>, and back again on expand", async () => {
    const { getByLabelText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    const collapse = getByLabelText("Collapse sidebar");
    collapse.focus();
    expect(document.activeElement).toBe(collapse);
    fireEvent.click(collapse);
    const expand = await waitFor(() => getByLabelText("Expand sidebar"));
    expect(document.activeElement).toBe(expand);
    expect(document.activeElement).not.toBe(document.body);
    // ...and back: expanding returns focus to the sidebar header's Collapse toggle.
    fireEvent.click(expand);
    const collapseAgain = await waitFor(() => getByLabelText("Collapse sidebar"));
    expect(document.activeElement).toBe(collapseAgain);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The dock is OPEN on arrival at a review (#849).
//
// The dock holds the session's own orchestrator thread (#823), so a reviewer who lands on
// a review with it shut is looking at a screen with the conversation hidden and no sign
// that there is one. What is asserted here is the RENDERED dock — `inert` shed and a real
// width — off the app's genuine initial store state, never a value these tests chose.
//
// The second test is the fence around the first: "open by default" must not become "opens
// itself again", which is what a per-route effect would do. It is a SEQUENCE assertion
// (open, then closed by the reviewer, then still closed after a navigation) rather than a
// set of membership checks, because the failure mode is entirely about order.
//
// WHAT THESE CANNOT CATCH: they assert the dock's box, not its contents, so a dock that
// opens on time and shows nothing useful passes both. And "sticks across a navigation" is
// proved for a session-to-session move; a route class neither test visits could still
// re-open it, and nothing here would see that.
// ─────────────────────────────────────────────────────────────────────────────

describe("chat dock open by default (#849)", () => {
  /** The ui state a launch really produces. There is no persist middleware, so a fresh
   *  store IS the app's cold-start state — this reads it rather than restating it. */
  const launchUi = () =>
    act(() => useRennetStore.setState({ ui: createRennetStore().getState().ui }));

  it("renders the dock open on arrival at a session route, with nobody opening it", async () => {
    launchUi();
    const { getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    // 420 chat + the 4px canvas gutter — the same width an explicitly opened dock renders.
    expect(getByTestId("chat-dock-slot").style.width).toBe("424px");
  });

  it("keeps a reviewer's close shut when they navigate to another session", async () => {
    launchUi();
    const history = memoryHistory("/s/review-1");
    const { getByTestId } = mount(<RennetRouterApp bridge={frontDoorBridge()} history={history} />);
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));

    // The reviewer closes it.
    act(() => useRennetStore.getState().uiActions.setChatOpen(false));
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(true));
    expect(getByTestId("chat-dock-slot").style.width).toBe("0px");

    // ...and it stays closed through a navigation to a different review.
    act(() => history.navigate("/s/review-2"));
    await waitFor(() =>
      expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe("false"),
    );
    expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(true);
    expect(getByTestId("chat-dock-slot").style.width).toBe("0px");
    expect(useRennetStore.getState().ui.chatOpen).toBe(false);
  });
});
