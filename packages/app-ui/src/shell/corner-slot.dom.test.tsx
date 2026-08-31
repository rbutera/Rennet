// @vitest-environment happy-dom
//
// The corner slot's ONE invariant (C20 §6): across every state of the real frame,
// `[data-slot="corner-slot"]` appears EXACTLY ONCE in the document. Two mounts is the
// regression class — the second one is usually invisible (inside the closed dock's
// width-0 `inert` subtree) and it silently steals the window's drag region, so
// nothing on screen tells you it happened.
//
// Plus #557's platform pattern: on darwin the OWNING slot reserves the traffic-light
// zone and carries the `app-region-drag` utility; on win32 / linux / undefined
// it reserves nothing and drags nothing, while the toggle geometry is IDENTICAL —
// non-darwin loses the inset, not the affordance.
import { afterEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false, sidebarOpen: true } }));
});

/** The three approved states, plus the fourth {open, open} combination — which is
 *  not a "state" in the design but IS the one where a literal spike port
 *  double-mounts, because the dock is visible AND the sidebar owns the slot. */
const STATES = [
  { name: "state 1 — sidebar expanded", sidebarOpen: true, chatOpen: false, owner: "sidebar" },
  {
    name: "state 1 — sidebar expanded, chat open",
    sidebarOpen: true,
    chatOpen: true,
    owner: "sidebar",
  },
  { name: "state 2 — collapsed, chat open", sidebarOpen: false, chatOpen: true, owner: "chat" },
  {
    name: "state 3 — collapsed, chat closed",
    sidebarOpen: false,
    chatOpen: false,
    owner: "floating",
  },
] as const;

function mountFrame(state: { sidebarOpen: boolean; chatOpen: boolean }, platform?: string) {
  act(() => {
    useRennetStore.getState().uiActions.setSidebarOpen(state.sidebarOpen);
    useRennetStore.getState().uiActions.setChatOpen(state.chatOpen);
  });
  const bridge = new MemoryBridge(frontDoorHandlers([]), { platform });
  return mount(<RennetRouterApp bridge={bridge} history={memoryHistory("/s/review-1")} />);
}

function slots(): NodeListOf<Element> {
  return document.querySelectorAll('[data-slot="corner-slot"]');
}

describe("corner slot: exactly one mount, always (C20 §6.1)", () => {
  for (const state of STATES) {
    it(`mounts exactly one slot in ${state.name}, owned by "${state.owner}"`, async () => {
      const { getByTestId } = mountFrame(state);
      // Let the dock settle so the hidden/inert case is genuinely rendered.
      await waitFor(() =>
        expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe(
          String(state.chatOpen),
        ),
      );
      expect(slots().length).toBe(1);
      expect(slots()[0]?.getAttribute("data-owner")).toBe(state.owner);
      cleanup();
    });
  }

  it("keeps exactly one across a live walk through all three states", async () => {
    const { getByTestId } = mountFrame({ sidebarOpen: true, chatOpen: true });
    const seen: string[] = [];
    for (const [sidebarOpen, chatOpen] of [
      [true, true],
      [false, true],
      [false, false],
      [true, false],
    ] as const) {
      act(() => {
        useRennetStore.getState().uiActions.setSidebarOpen(sidebarOpen);
        useRennetStore.getState().uiActions.setChatOpen(chatOpen);
      });
      await waitFor(() =>
        expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe(String(chatOpen)),
      );
      expect(slots().length).toBe(1);
      seen.push(slots()[0]?.getAttribute("data-owner") ?? "");
    }
    // The slot genuinely MOVED — this is not one static mount passing four times.
    expect(seen).toEqual(["sidebar", "chat", "floating", "sidebar"]);
  });
});

describe("corner slot: darwin reserves, every other host does not (C20 §6.2)", () => {
  for (const state of STATES) {
    it(`reserves the light zone and drags on darwin in ${state.name}`, async () => {
      const { getByTestId } = mountFrame(state, "darwin");
      await waitFor(() =>
        expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe(
          String(state.chatOpen),
        ),
      );
      const slot = slots()[0];
      if (!slot) throw new Error("no corner slot");
      // The reserve differs by owner (the sidebar takes 81 so its wordmark clears the
      // lights, the chat header takes the bare 76px light zone, the floating pill is
      // inset 4px from the corner so it needs 76 − 4), but every owner reserves
      // SOMETHING on darwin.
      expect(slot.className).toMatch(/pl-\[(81|76|72)px\]/);
      expect(slot.className).toContain("app-region-drag");
      // Every interactive thing INSIDE the drag strip opts back out by name. This used to
      // be a `.navigation-titlebar button, a, input, code` list in the stylesheet, which
      // covered this <button> only because it is a <button>: a `div[role="button"]` or a
      // span trigger dropped into the strip stayed a drag surface and never received its
      // own clicks. Asserting the class at each control is what makes that unmissable.
      //
      // What this CANNOT prove: `-webkit-app-region` is a Chromium/Electron window
      // property with no representation in happy-dom — no layout, no computed effect, no
      // event behaviour. The assertion is that the opt-out is DECLARED on the control;
      // that it actually restores clicks is only observable in a real Electron window.
      for (const control of slot.querySelectorAll("button, a, input, [role='button']")) {
        expect(control.className).toContain("app-region-no-drag");
      }
      cleanup();
    });
  }

  for (const platform of ["win32", "linux", undefined]) {
    it(`reserves nothing and drags nothing on ${platform ?? "an unknown host"}`, async () => {
      for (const state of STATES) {
        const { getByTestId } = mountFrame(state, platform);
        await waitFor(() =>
          expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe(
            String(state.chatOpen),
          ),
        );
        const slot = slots()[0];
        if (!slot) throw new Error("no corner slot");
        expect(slot.className).not.toMatch(/pl-\[\d+px\]/);
        expect(slot.className).not.toContain("app-region-drag");
        // ...and the affordance is untouched: the SAME single toggle, in the same
        // place, with the same label. Only the inset is gone.
        const toggles = slot.querySelectorAll(
          '[aria-label="Collapse sidebar"], [aria-label="Expand sidebar"]',
        );
        expect(toggles.length).toBe(1);
        expect(toggles[0]?.getAttribute("aria-label")).toBe(
          state.sidebarOpen ? "Collapse sidebar" : "Expand sidebar",
        );
        expect(slot.lastElementChild).toBe(toggles[0]);
        cleanup();
      }
    });
  }
});
