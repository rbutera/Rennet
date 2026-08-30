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
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider } from "../data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { RunRoute } from "../rounds/run-route";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { AppLayout } from "../routes/layout";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { fixtureBoardRead } from "../test/fixtures/boards";
import { frontDoorBridge } from "../test/fixtures/front-door";
import { createTimelineRoundsSource } from "../test/fixtures/rounds";
import { MemoryBridge } from "../test/memory-bridge";

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
    // Every slot that CARRIES a chip opts back into pointer events (the bar itself is
    // transparent to them). This fixture resolves no review boards, so its centre rail is
    // honestly empty and is not asserted — an empty div proves nothing.
    for (const slot of [bar.firstElementChild, bar.lastElementChild]) {
      expect(slot?.className).toContain("pointer-events-auto");
      expect(slot?.children.length).toBeGreaterThan(0);
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
  // 5.3's clear-at-rest / slide-under-on-scroll. happy-dom has no layout engine, so
  // the pixel behaviour cannot be measured — but the thing that actually broke IS
  // assertable: the CSS hangs the clearance off the pane's PRIMARY SCROLLER
  // (`min-h-0 flex-1 overflow-y-auto`), and the board branch had no such element at
  // all, so the rule matched nothing and the review read under the chips. Asserting
  // only "the class is applied" proved a class that did nothing. These assert the
  // scroller exists, holds the board, and is the element the rule reaches.
  // ───────────────────────────────────────────────────────────────────────────
  // The outlet region must be a flex COLUMN. Every surface in here declares its own
  // scrolling with `min-h-0 flex-1 overflow-y-auto`, and `flex-1` is inert under a block
  // parent — the scroller renders and cannot scroll. That one missing `flex flex-col` is
  // the structural cause behind BOTH dead surfaces (the review board, and `/s/:slug/run`),
  // and C20 makes it worse where it is unfixed: the state-3 rule matches a dead scroller
  // and pads it. Asserted here so a revert to a block region reddens immediately.
  it("makes the outlet region a flex column, so a pane's own scroller can work", () => {
    const { container } = mountFrame(STATE_1, "/s/review-1");
    const region = container.ownerDocument.querySelector("[data-floating-chrome]");
    if (!region) throw new Error("no outlet content region");
    expect(region.className).toContain("flex-col");
    expect(region.className).toMatch(/(^|\s)flex(\s|$)/);
  });

  it("gives the live run route a scroller that is actually height-constrained", async () => {
    // `/s/:slug/run`'s success branch IS a `min-h-0 flex-1 overflow-y-auto` section rendered
    // straight into the region. Under the old block region its `flex-1` did nothing, so a
    // long run could not scroll. The proof is the pair: the section is a DIRECT flex child
    // of a flex-column region — the class alone never meant anything.
    const rounds = createTimelineRoundsSource({ startTick: 1 });
    const history = memoryHistory("/s/review-1/run");
    const { container, findByTestId } = mount(
      <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <RoundsSourceProvider value={rounds.source}>
            <AppLayout>
              <RunRoute slug="review-1" />
            </AppLayout>
          </RoundsSourceProvider>
        </Router>
      </BridgeProvider>,
    );
    await findByTestId("chat-dock-slot");
    const region = container.querySelector("[data-floating-chrome]");
    if (!region) throw new Error("no outlet content region");
    const run = region.querySelector('[data-screen="session-run"]');
    if (!run) throw new Error("the run route did not render its live surface");
    expect(run.className).toContain("overflow-y-auto");
    // ...and it is MARKED, so the clearance lands on it. The mark is the whole contract
    // now that the stylesheet no longer infers a primary scroller from the utility names
    // it happens to type.
    expect(run.className).toContain("chrome-scroll-clearance");
    // The two halves that make it real: the scroller is a flex child, of a flex column.
    expect(run.parentElement).toBe(region);
    expect(region.className).toContain("flex-col");
  });

  it("marks a SESSION surface for the scroll treatment, not the plain pad", () => {
    const { container } = mountFrame(STATE_3, "/s/review-1");
    const region = container.ownerDocument.querySelector("[data-floating-chrome]");
    if (!region) throw new Error("no outlet content region");
    expect(region.getAttribute("data-floating-chrome")).toBe("scroll");
    expect(region.className).toContain("rennet-floating-chrome-scroll");
  });

  it("gives the board branch a real primary scroller for the clearance to land on", async () => {
    // THE BUG THIS TEST EXISTS FOR: the CSS hangs the clearance off the pane's primary
    // scroller, and the board branch had NO element matching that selector — it sat in a
    // `min-h-screen` block inside the frame's `overflow-hidden`. The rule matched nothing,
    // so the review read under the chips (and the board could not scroll at all). Asserting
    // "the class is applied" passed anyway, which is what made it invisible.
    const history = memoryHistory("/s/review-1");
    const review = {
      id: "cs-1",
      activePatchsetId: "ps-1",
      repositoryRoot: "/home/dev/rennet",
    } as unknown as Review;
    const { container } = mount(
      <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <ReviewWorkspace review={review} />
        </Router>
      </BridgeProvider>,
    );
    // Wait for the board itself — it used to be the `REVIEW ·` eyebrow, which the board
    // no longer carries.
    await waitFor(() =>
      expect(container.querySelector('[data-kind="lens-board-view"]')).not.toBeNull(),
    );
    // The mark, run against the live tree: exactly ONE element in the pane claims the
    // clearance. Matching NOTHING is the original regression; matching several would mean
    // two nested surfaces each clearing the chips, which is the failure the old
    // utility-name selector could produce silently in any branch that typed the same three
    // layout classes.
    const scrollers = container.querySelectorAll(".chrome-scroll-clearance");
    expect(scrollers.length).toBe(1);
    const scroller = scrollers[0];
    if (!scroller) throw new Error("the board branch has no marked primary scroller");
    expect(scroller.className).toContain("overflow-y-auto");
    // ...and it is the element that actually carries the review document, not some
    // unrelated bounded list that happens to match the selector.
    expect(scroller.querySelector('[data-kind="lens-board-view"]')).toBeTruthy();
  });

  // The clearance is only real where a scroller CLAIMS it. Nothing used to notice a
  // session branch losing its claim: the stylesheet inferred the scroller from the
  // `min-h-0 flex-1 overflow-y-auto` trio, so a branch that restyled its layout dropped
  // the clearance silently and read under the chips. Every session view the workspace can
  // land on is checked here, by view, so a new branch cannot be added without one.
  for (const view of ["", "?view=diff", "?view=handoff", "?view=rounds"]) {
    it(`marks exactly one primary scroller on the ${view || "board"} view`, async () => {
      const review = {
        id: "cs-1",
        activePatchsetId: "ps-1",
        repositoryRoot: "/home/dev/rennet",
        // The diff branch needs a real changed file: with none it renders a centred
        // notice instead of the pane, and a notice has no scroller to mark.
        patchsets: [
          {
            id: "ps-1",
            files: [
              {
                path: "packages/core/src/a.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                binary: false,
                patch: ["@@ -1,1 +1,1 @@", "-const y = 2", "+const y = 3"].join("\n"),
              },
            ],
          },
        ],
      } as unknown as Review;
      const history = memoryHistory(`/s/review-1${view}`);
      const { container } = mount(
        <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
          <Router hook={history.hook} searchHook={history.searchHook}>
            <ReviewWorkspace review={review} />
          </Router>
        </BridgeProvider>,
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".chrome-scroll-clearance").length).toBe(1),
      );
    });
  }

  it("gives a TAKEOVER surface plain clearance, never the scroll treatment", () => {
    // Settings has its own in-flow header; scrolling its content through it would be
    // wrong. It clears the corner-slot pill and stops there.
    const { container } = mountFrame(STATE_3, "/settings/appearance");
    const region = container.ownerDocument.querySelector("[data-floating-chrome]");
    if (!region) throw new Error("no outlet content region");
    expect(region.getAttribute("data-floating-chrome")).toBe("pad");
    expect(region.className).toContain("rennet-floating-chrome");
    expect(region.className).not.toContain("rennet-floating-chrome-scroll");
  });

  it("applies no clearance at all outside state 3", () => {
    for (const state of [STATE_1, { sidebarOpen: false, chatOpen: true }]) {
      const other = mountFrame(state);
      const el = other.container.ownerDocument.querySelector("[data-floating-chrome]");
      if (!el) throw new Error("no outlet content region");
      expect(el.getAttribute("data-floating-chrome")).toBe("off");
      expect(el.className).not.toContain("rennet-floating-chrome");
      cleanup();
    }
  });
});
