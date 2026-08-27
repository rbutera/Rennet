// @vitest-environment happy-dom
//
// The hand-off view toggle (C08 cluster 4, Objective clause 3, R31). Load-bearing claim: the view
// dispatches by ENTRY MODE — a teammate PR gets the Post Review lane, a retrospective review gets
// no exits (renders nothing), and your own branch gets the staged-ask surface (the cluster-5
// rounds lanes replace this branch).
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { HandoffView } from "./handoff-view";

const store = () => useRennetStore.getState();
const postTarget = {
  repo: { forge: "github", owner: "acme", name: "orbital" },
  number: 7,
  forgeRef: "PR_x",
  headOid: "abc",
};
const asReview = (over: Partial<Review>) =>
  ({ activePatchsetId: "ps-1", ...over }) as unknown as Review;

afterEach(() => {
  cleanup();
  store().reviewActions.resetReview();
});

describe("HandoffView", () => {
  it("dispatches a teammate PR to the Post Review lane", () => {
    const r = mount(<HandoffView review={asReview({ postTarget })} />);
    expect(r.getByText("Post Review · acme/orbital#7")).toBeTruthy();
  });

  it("offers no exit for a retrospective review (law 10)", () => {
    const r = mount(<HandoffView review={asReview({ retrospective: true, postTarget })} />);
    expect(r.container.textContent).toBe("");
  });

  it("dispatches your own branch to the staged-ask surface", () => {
    act(() =>
      store().reviewActions.stageAsk({
        anchor: "This is my change.",
        type: "comment",
        body: "note to self",
      }),
    );
    const r = mount(<HandoffView review={asReview({})} />);
    expect(r.getByText("note to self")).toBeTruthy();
    // Not the Post Review lane — an own branch has no teammate PR to post to.
    expect(r.queryByText(/Post Review ·/)).toBeNull();
  });
});
