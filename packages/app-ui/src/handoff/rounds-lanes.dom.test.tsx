// @vitest-environment happy-dom
//
// The rounds lanes (C08 cluster 5, Objective clause 3, R37). Load-bearing claims: the page is a
// two-state surface whose SHAPE states which one you are in — while asks remain it is **Changes**
// (ask count, one card per ask, Dispatch Round, the PR a muted destination line); when the asks
// drain and the PR is ready the page IS the pull request (title heading, drafted body, Open Pull
// Request → a receipt). Dispatch Round is inert while nothing is staged. Steering Drop retires +
// unstages, over the real `review` slice.
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount } from "../test/dom";
import { type PrReceipt, RoundsLanes } from "./rounds-lanes";
import { selectExitPipCount } from "./selectors";

const store = () => useRennetStore.getState();
const pip = () => selectExitPipCount(useRennetStore.getState());

// An own-branch review — no `postTarget`. The lane reads only `activePatchsetId`.
const review = { activePatchsetId: "ps-1" } as unknown as Review;
const draftedPr = {
  title: "Harden the retry path",
  body: "## Summary\n\nGuards the boundary.",
  ready: true,
};

function stage(
  anchor: string,
  body = `body for ${anchor}`,
  type: "comment" | "request-change" = "comment",
) {
  act(() => store().reviewActions.stageAsk({ anchor, type, body }));
}

/** Select the contents of `el`, then release the mouse on it (the anchoring gesture). */
function selectAndRelease(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
}

afterEach(() => {
  cleanup();
  store().reviewActions.resetReview();
});

describe("RoundsLanes", () => {
  it("shows Changes with the ask count and card while asks remain", () => {
    stage("src/a.ts:5", "guard the boundary", "request-change");
    const r = mount(<RoundsLanes review={review} pr={draftedPr} />);
    expect(r.getByRole("heading", { name: "Changes" })).toBeTruthy();
    expect(r.getByText("guard the boundary")).toBeTruthy();
    // The PR is only a muted destination line at the foot while changes remain — not the page.
    expect(r.getAllByText("Harden the retry path").length).toBe(1);
    expect(r.queryByRole("button", { name: /Open Pull Request/ })).toBeNull();
  });

  it("becomes the pull request as the asks drain (Changes ⇄ the-PR-is-the-page)", () => {
    stage("This reads clean.", "note to self");
    const r = mount(<RoundsLanes review={review} pr={draftedPr} />);
    expect(r.getByRole("heading", { name: "Changes" })).toBeTruthy();

    // Drain the ask — with a ready PR, the surface becomes the pull request.
    act(() => store().reviewActions.unstageAsk("This reads clean."));
    expect(r.getByRole("heading", { name: "Harden the retry path" })).toBeTruthy();
    expect(r.getByText("Guards the boundary.")).toBeTruthy(); // the drafted body renders
    expect(r.queryByRole("heading", { name: "Changes" })).toBeNull();
  });

  it("Dispatch Round is inert while nothing is staged, live once an ask is staged", () => {
    const r = mount(<RoundsLanes review={review} />);
    expect(r.getByText("Nothing staged yet.")).toBeTruthy();
    expect(r.getByRole("button", { name: "Dispatch Round" }).hasAttribute("disabled")).toBe(true);

    stage("src/a.ts:5", "guard the boundary", "request-change");
    expect(r.getByRole("button", { name: "Dispatch Round" }).hasAttribute("disabled")).toBe(false);
  });

  it("dispatches a round through the callback when staged", () => {
    const onDispatch = vi.fn();
    stage("src/a.ts:5", "guard the boundary", "request-change");
    const r = mount(<RoundsLanes review={review} onDispatch={onDispatch} />);
    fireEvent.click(r.getByRole("button", { name: "Dispatch Round" }));
    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("stays on Changes with an unripe PR (no asks, not ready)", () => {
    const r = mount(<RoundsLanes review={review} pr={{ ...draftedPr, ready: false }} />);
    expect(r.getByText("Nothing staged yet.")).toBeTruthy();
    expect(r.queryByRole("heading", { name: "Harden the retry path" })).toBeNull();
  });

  it("the Open-PR CTA is disabled with no egress, and posts a receipt with one", async () => {
    const receipt: PrReceipt = { number: 438, url: "https://github.com/rbutera/rennet/pull/438" };
    const r = mount(<RoundsLanes review={review} pr={draftedPr} />);
    expect(r.getByRole("button", { name: /Open Pull Request/ }).hasAttribute("disabled")).toBe(
      true,
    );

    r.rerender(<RoundsLanes review={review} pr={draftedPr} onOpenPr={async () => receipt} />);
    await r.user.click(r.getByRole("button", { name: /Open Pull Request/ }));
    expect(await r.findByText(/Pull request opened · #438/)).toBeTruthy();
    expect(r.getByText("github.com/rbutera/rennet/pull/438")).toBeTruthy();
  });

  it("selection Drop retires the ask and unstages it (the card leaves, pip drops)", () => {
    stage("This holds up.", "This holds up on the retry path.");
    const r = mount(<RoundsLanes review={review} />);
    expect(pip()).toBe(1);
    selectAndRelease(r.getByText("This holds up on the retry path."));
    fireEvent.click(r.getByText("Drop"));
    expect(store().review.stagedAsks["This holds up."]).toBeUndefined();
    expect(store().review.retired.map((e) => e.reason)).toContain("dropped from the round");
    expect(pip()).toBe(0);
  });
});
