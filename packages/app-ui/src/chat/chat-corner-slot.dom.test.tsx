// @vitest-environment happy-dom
//
// State 2 of the corner slot (C20 §3): sidebar collapsed, chat open — the chat is
// the leftmost pane, so its EXISTING 56px header row carries the slot as its first
// child. Driven through the real frame, because the thing under test is the layout's
// ownership gate, not the header's markup.
//
// This file is the packet's named REGRESSION CLASS. The frame keeps a closed chat
// dock MOUNTED (width 0 + `inert`, the R47 transcript-identity guarantee), so a
// literal port of the spike — which unmounts its chat column — would mount a second
// corner slot inside that hidden subtree in EVERY state. It is invisible on screen
// and it steals the window's drag region; only a test catches it.
import { afterEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { frontDoorBridge } from "../test/fixtures/front-door";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, chatOpen: false, sidebarOpen: true, chatWidth: 420 },
  }));
});

function mountFrame(state: { sidebarOpen: boolean; chatOpen: boolean }) {
  act(() => {
    useRennetStore.getState().uiActions.setSidebarOpen(state.sidebarOpen);
    useRennetStore.getState().uiActions.setChatOpen(state.chatOpen);
  });
  return mount(
    <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
  );
}

function dockSlot(getByTestId: (id: string) => HTMLElement): HTMLElement {
  return getByTestId("chat-dock-slot");
}

describe("corner slot in the chat header (C20 state 2)", () => {
  it("mounts exactly one slot in the chat header, self-start, ahead of the trail", async () => {
    const { getByTestId } = mountFrame({ sidebarOpen: false, chatOpen: true });
    const dock = dockSlot(getByTestId);
    await waitFor(() => expect(dock.hasAttribute("inert")).toBe(false));

    const slots = dock.querySelectorAll('[data-slot="corner-slot"]');
    expect(slots.length).toBe(1);
    const slot = slots[0];
    if (!slot) throw new Error("chat header has no corner slot");
    expect(slot.getAttribute("data-owner")).toBe("chat");
    // `self-start` keeps the macOS light inset at its real y in a 56px row.
    expect(slot.className).toContain("self-start");

    // It is the header's FIRST child, ahead of the trail.
    const header = slot.closest("header");
    if (!header) throw new Error("corner slot is not inside the chat header");
    expect(header.firstElementChild).toBe(slot);
    expect(header.className).toContain("pl-0");
    const trail = header.querySelector('[data-slot="corner-slot"] ~ *');
    if (!trail) throw new Error("chat header has no trail after the corner slot");
    // Node.DOCUMENT_POSITION_FOLLOWING (4).
    expect(slot.compareDocumentPosition(trail) & 4).toBe(4);
  });

  it("puts NO slot in the chat header while the sidebar is open — including the hidden inert dock", async () => {
    // Sidebar open + chat open: the sidebar owns the slot. The dock is visible here,
    // so a leaked mount would be a real double-mount on screen...
    const open = mountFrame({ sidebarOpen: true, chatOpen: true });
    await waitFor(() => expect(dockSlot(open.getByTestId).hasAttribute("inert")).toBe(false));
    expect(dockSlot(open.getByTestId).querySelectorAll('[data-slot="corner-slot"]').length).toBe(0);
    cleanup();

    // ...and with the chat CLOSED the dock is still mounted, just width-0 and inert.
    // That hidden subtree is where a spike-literal port double-mounts invisibly.
    const closed = mountFrame({ sidebarOpen: true, chatOpen: false });
    const dock = dockSlot(closed.getByTestId);
    expect(dock.hasAttribute("inert")).toBe(true);
    expect(dock.querySelectorAll('[data-slot="corner-slot"]').length).toBe(0);
  });

  it("has no chat collapse control left in the header — the one toggle lives on the main view", async () => {
    const { getByTestId, queryByLabelText } = mountFrame({ sidebarOpen: false, chatOpen: true });
    await waitFor(() => expect(dockSlot(getByTestId).hasAttribute("inert")).toBe(false));
    expect(queryByLabelText("Collapse chat")).toBeNull();
    expect(dockSlot(getByTestId).querySelector('[aria-label="Collapse chat"]')).toBeNull();
  });
});
