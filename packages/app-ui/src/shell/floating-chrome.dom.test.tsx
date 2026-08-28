// @vitest-environment happy-dom
//
// State 3 of the corner slot (C20 §5): sidebar collapsed AND chat closed. Nothing is
// left to the main view's left, so it runs full-bleed, the corner slot floats as a
// translucent pill, and the session bar dissolves into a floating chip layer.
//
// Honest-present is the load-bearing assertion here (reconciliation 5): the bar
// dissolves its CHROME, not its data. Every control it shows in states 1–2 must still
// render and still work. A chip dropped because it "does not fit the floating layer"
// is a lie by omission, and it is the failure mode this file exists to catch.
import { afterEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { frontDoorBridge } from "../test/fixtures/front-door";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false, sidebarOpen: true } }));
});

function mountFrame(
  state: { sidebarOpen: boolean; chatOpen: boolean },
  path = "/s/review-1?view=diff",
) {
  act(() => {
    useRennetStore.getState().uiActions.setSidebarOpen(state.sidebarOpen);
    useRennetStore.getState().uiActions.setChatOpen(state.chatOpen);
  });
  return mount(<RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory(path)} />);
}

const STATE_3 = { sidebarOpen: false, chatOpen: false };
const STATE_1 = { sidebarOpen: true, chatOpen: true };

describe("state 3 — the floating chip layer (C20 §5)", () => {
  it("floats the corner slot as the one pill, over the layout not the top bar", () => {
    const { container } = mountFrame(STATE_3);
    const slots = container.ownerDocument.querySelectorAll('[data-slot="corner-slot"]');
    expect(slots.length).toBe(1);
    const slot = slots[0];
    if (!slot) throw new Error("no floating corner slot");
    expect(slot.getAttribute("data-owner")).toBe("floating");
    expect(slot.className).toContain("fixed");
    expect(slot.className).toContain("rounded-full");
    // The pill is translucent backing plus the toggle — never a control under a light.
    expect(slot.className).toContain("backdrop-blur-md");
    // It belongs to the LAYOUT: it is NOT inside the session top bar, so a takeover
    // route with the sidebar collapsed still has a corner slot and a drag region.
    expect(slot.closest('[data-slot="session-top-bar"]')).toBeNull();
  });

  it("keeps a corner slot on a takeover route, where there is no top bar at all", () => {
    const { container } = mountFrame(STATE_3, "/settings/appearance");
    expect(container.ownerDocument.querySelector('[data-slot="session-top-bar"]')).toBeNull();
    const slots = container.ownerDocument.querySelectorAll('[data-slot="corner-slot"]');
    expect(slots.length).toBe(1);
    expect(slots[0]?.getAttribute("data-owner")).toBe("floating");
  });

  it("dissolves the bar into a pointer-transparent overlay whose chips stay clickable", () => {
    const { container } = mountFrame(STATE_3);
    const bar = container.ownerDocument.querySelector('[data-slot="session-top-bar"]');
    if (!bar) throw new Error("no top bar");
    expect(bar.getAttribute("data-floating")).toBe("true");
    expect(bar.className).toContain("absolute");
    expect(bar.className).toContain("pointer-events-none");
    expect(bar.className).not.toContain("border-b");
    // Each of the three slots opts its own chips back into pointer events.
    for (const slot of bar.children) {
      expect(slot.className).toContain("pointer-events-auto");
    }
  });

  it("still renders EVERY control the bar shows in state 1 (honest-present)", () => {
    const state1 = mountFrame(STATE_1);
    const bar1 = state1.container.ownerDocument.querySelector('[data-slot="session-top-bar"]');
    if (!bar1) throw new Error("no top bar in state 1");
    const labels = (root: Element) =>
      [...root.querySelectorAll("[aria-label]")]
        .map((el) => el.getAttribute("aria-label") ?? "")
        .sort();
    const inState1 = labels(bar1);
    const pill1 = [...bar1.querySelectorAll('[role="button"], button')].map((b) => b.textContent);
    expect(
      state1.container.ownerDocument.querySelector('[data-slot="lens-switcher"]'),
    ).toBeTruthy();
    cleanup();

    const state3 = mountFrame(STATE_3);
    const bar3 = state3.container.ownerDocument.querySelector('[data-slot="session-top-bar"]');
    if (!bar3) throw new Error("no top bar in state 3");
    // The chat toggle's LABEL flips with its state, so compare the rest by identity and
    // assert the toggle separately below.
    const chatLabels = new Set(["Open chat", "Close chat"]);
    expect(inState1.filter((l) => !chatLabels.has(l))).toEqual(
      labels(bar3).filter((l) => !chatLabels.has(l)),
    );
    // Map · Diff (and History when a round exists) still render as chips.
    expect([...bar3.querySelectorAll('[role="button"], button')].map((b) => b.textContent)).toEqual(
      pill1,
    );
    // The named lens-switcher slot C5 fills survives the restyle.
    expect(bar3.querySelector('[data-slot="lens-switcher"]')).toBeTruthy();
  });

  it("reopens the dock from the floating chat FAB, handing the slot back to the chat", async () => {
    const { getByLabelText, getByTestId, container } = mountFrame(STATE_3);
    expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe("false");
    fireEvent.click(getByLabelText("Open chat"));
    await waitFor(() =>
      expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe("true"),
    );
    // Ownership moved: still exactly one slot, now the chat header's.
    const slots = container.ownerDocument.querySelectorAll('[data-slot="corner-slot"]');
    expect(slots.length).toBe(1);
    expect(slots[0]?.getAttribute("data-owner")).toBe("chat");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5.3's clear-at-rest / slide-under-on-scroll. jsdom and happy-dom have no
  // layout, so the VISUAL behaviour cannot be measured here — see the task note.
  // What IS genuinely pinnable is that the clearance contract is applied in state 3
  // and absent otherwise, which is the half a test can honestly prove.
  // ───────────────────────────────────────────────────────────────────────────
  it("applies the full-bleed clearance contract in state 3 and nowhere else", () => {
    const { container } = mountFrame(STATE_3);
    const region = container.ownerDocument.querySelector("[data-floating-chrome]");
    if (!region) throw new Error("no outlet content region");
    expect(region.getAttribute("data-floating-chrome")).toBe("true");
    expect(region.className).toContain("rennet-floating-chrome");
    cleanup();

    for (const state of [STATE_1, { sidebarOpen: false, chatOpen: true }]) {
      const other = mountFrame(state);
      const el = other.container.ownerDocument.querySelector("[data-floating-chrome]");
      if (!el) throw new Error("no outlet content region");
      expect(el.getAttribute("data-floating-chrome")).toBe("false");
      expect(el.className).not.toContain("rennet-floating-chrome");
      cleanup();
    }
  });
});
