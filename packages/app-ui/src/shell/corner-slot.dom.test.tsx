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

/** Every Rennet sphere in the document, whichever path it rendered by. */
function spheres(): NodeListOf<Element> {
  return document.querySelectorAll("[data-liquid-sphere]");
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
      // ...and exactly ONE sphere in every state. The mark moves with the corner, but
      // it no longer rides INSIDE the slot in state 1: the sidebar's lockup has its own
      // row beneath the strip, so the sphere is there, and the slot is lights + toggle.
      // In the other two states there is no row beneath, so the slot carries the orb.
      // Two spheres would be two animated marks claiming the same fact — the same
      // regression class as two slots, and just as quiet, because the second one looks
      // perfectly correct wherever it is.
      expect(spheres().length).toBe(1);
      const home = spheres()[0]?.closest(
        state.owner === "sidebar" ? '[data-slot="sidebar-lockup"]' : '[data-slot="corner-slot"]',
      );
      expect(home).not.toBeNull();
      if (state.owner === "sidebar") {
        expect(spheres()[0]?.closest('[data-slot="corner-slot"]')).toBeNull();
      } else {
        expect(home).toBe(slots()[0]);
      }
      cleanup();
    });
  }

  it("keeps exactly one sphere across the live walk, and hands it between owners", async () => {
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
      expect(spheres().length).toBe(1);
      seen.push(slots()[0]?.getAttribute("data-owner") ?? "");
    }
    // The sphere genuinely MOVED with the slot — one static mount would pass four times.
    expect(seen).toEqual(["sidebar", "chat", "floating", "sidebar"]);
  });

  it("names the orb, and only the orb — the sidebar's lockup row owns the name in state 1", async () => {
    // Two spheres is not the only way to say "Rennet" twice: the assembled lockup already
    // carries the accessible name on its row, so an orb that also named itself would be a
    // second image with the same label. In states 2 and 3 there is no lockup row, so the
    // orb is the name.
    for (const state of STATES) {
      const { getByTestId } = mountFrame(state);
      await waitFor(() =>
        expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe(
          String(state.chatOpen),
        ),
      );
      const sphere = spheres()[0];
      if (!sphere) throw new Error("no sphere");
      expect(sphere.getAttribute("aria-label")).toBe(state.owner === "sidebar" ? null : "Rennet");
      expect(document.querySelectorAll('[aria-label="Rennet"]').length).toBe(1);
      cleanup();
    }
  });

  it("works the sphere while Rennet is working, wherever the slot lives", async () => {
    for (const state of STATES) {
      const { getByTestId } = mountFrame(state);
      await waitFor(() =>
        expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe(
          String(state.chatOpen),
        ),
      );
      expect(spheres()[0]?.getAttribute("data-state")).toBe("resting");
      act(() => useRennetStore.getState().runActions.setRoundProgress(0.5));
      expect(spheres()[0]?.getAttribute("data-state")).toBe("working");
      act(() => useRennetStore.getState().runActions.resetRun());
      expect(spheres()[0]?.getAttribute("data-state")).toBe("resting");
      cleanup();
    }
  });

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

describe("corner slot: the orb's size and the pill's height (option B)", () => {
  it("draws the orb at 32px in both collapsed states, in a 36px floating pill", async () => {
    for (const state of STATES) {
      const { getByTestId } = mountFrame(state);
      await waitFor(() =>
        expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe(
          String(state.chatOpen),
        ),
      );
      const sphere = spheres()[0] as HTMLElement | undefined;
      if (!sphere) throw new Error("no sphere");
      // State 1's sphere is the lockup row's 44px mark; the collapsed states carry the
      // 32px orb. Both numbers asserted here, so a change to either is a change to this
      // sentence rather than a silent drift in one of two files.
      expect(sphere.style.height).toBe(state.owner === "sidebar" ? "44px" : "32px");
      if (state.owner === "floating") {
        // The pill grew with the orb: 36px tall, still a full-radius translucent chip.
        expect(slots()[0]?.className).toContain("h-9");
        expect(slots()[0]?.className).not.toContain("h-8");
        expect(slots()[0]?.className).toContain("rounded-full");
      }
      cleanup();
    }
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
