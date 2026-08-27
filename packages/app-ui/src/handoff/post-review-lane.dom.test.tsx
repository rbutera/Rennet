// @vitest-environment happy-dom
//
// The Post Review lane (C08 cluster 4, Objective clauses 4/5). Load-bearing claims: the verdict
// is PROPOSED from the staged asks and flips (with "use proposal" to revert); body asks render in
// the body and code-anchored asks as file-grouped line-comment cards; Edit writes a draft edit and
// Delete retires+unstages; selection Drop retires+unstages and Explain shows provenance WITHOUT
// raising the exit pip; the Retired drawer restores a block whole; the CTA is disabled with no
// egress and posts a receipt with one.
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount } from "../test/dom";
import { type PostReceipt, PostReviewLane } from "./post-review-lane";
import { selectExitPipCount } from "./selectors";

const store = () => useRennetStore.getState();
const pip = () => selectExitPipCount(useRennetStore.getState());

// The lane reads only `activePatchsetId` + `postTarget`; a minimal snapshot is enough.
const review = {
  activePatchsetId: "ps-1",
  postTarget: {
    repo: { forge: "github", owner: "acme", name: "orbital" },
    number: 7,
    forgeRef: "PR_x",
    headOid: "abc",
  },
} as unknown as Review;

function stage(
  anchor: string,
  type: "comment" | "request-change" = "comment",
  body = `body for ${anchor}`,
) {
  act(() => store().reviewActions.stageAsk({ id: anchor, anchor, type, body }));
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

describe("PostReviewLane", () => {
  it("proposes the verdict from the staged asks and flips it with 'use proposal'", async () => {
    stage("src/a.ts:3", "request-change");
    const r = mount(<PostReviewLane review={review} />);
    // A request-change ask proposes Request Changes, with its arithmetic beside the control.
    expect(r.getByText(/proposed from your review · 1 request change · 0 comments/)).toBeTruthy();
    expect(store().review.verdictOverride).toBeNull(); // no override yet — the proposal stands

    await r.user.click(r.getByRole("button", { name: /Approve/ }));
    expect(store().review.verdictOverride).toBe("APPROVE");
    expect(r.getByText(/overridden — proposed request changes/)).toBeTruthy();

    await r.user.click(r.getByRole("button", { name: "use proposal" }));
    expect(store().review.verdictOverride).toBeNull();
    expect(r.getByText(/proposed from your review/)).toBeTruthy();
  });

  it("routes body asks to the body and code-anchored asks to file-grouped line cards", () => {
    stage("This reads clean.", "comment");
    stage("src/a.ts:5", "request-change", "guard the boundary");
    const r = mount(<PostReviewLane review={review} />);
    expect(r.getByText("This reads clean.")).toBeTruthy();
    expect(r.getByText("guard the boundary")).toBeTruthy();
    // The line comment carries its file-path heading; the body ask does not.
    expect(r.getByText("src/a.ts")).toBeTruthy();
    expect(r.getByText(/Line Comments · 1/)).toBeTruthy();
  });

  it("Edit writes a draft edit; Delete retires the ask and unstages it (pip drops)", async () => {
    stage("src/a.ts:5", "request-change", "guard the boundary");
    const r = mount(<PostReviewLane review={review} />);
    expect(pip()).toBe(1);

    fireEvent.click(r.getByRole("button", { name: /Edit/ }));
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "guard the boundary tightly" } });
    fireEvent.click(r.getByRole("button", { name: "Save" }));
    expect(store().review.draftEdits["src/a.ts:5"]).toBe("guard the boundary tightly");
    expect(r.getByText("guard the boundary tightly")).toBeTruthy();

    fireEvent.click(r.getByRole("button", { name: /Delete/ }));
    expect(store().review.stagedAsks["src/a.ts:5"]).toBeUndefined();
    expect(store().review.retired.map((e) => e.ask.anchor)).toContain("src/a.ts:5");
    expect(pip()).toBe(0);
  });

  it("selection Drop retires+unstages a body ask", () => {
    stage("This holds up on the retry path.", "comment");
    const r = mount(<PostReviewLane review={review} />);
    selectAndRelease(r.getByText("This holds up on the retry path."));
    fireEvent.click(r.getByText("Drop"));
    expect(store().review.stagedAsks["This holds up on the retry path."]).toBeUndefined();
    expect(store().review.retired.map((e) => e.reason)).toContain("dropped by you");
  });

  it("selection Explain shows the span's provenance and never raises the exit pip", () => {
    stage("This holds up on the retry path.", "comment");
    const r = mount(<PostReviewLane review={review} />);
    expect(pip()).toBe(1);
    selectAndRelease(r.getByText("This holds up on the retry path."));
    fireEvent.click(r.getByText("Explain"));
    expect(r.getByText(/staged as a comment/)).toBeTruthy();
    // Explain answers over the slice — it stages nothing, so the pip is unchanged.
    expect(pip()).toBe(1);
    expect(store().review.stagedAsks["This holds up on the retry path."]).toBeDefined();
  });

  it("selection Revise renders the affordance but is honestly gated — no fake success", () => {
    stage("This holds up on the retry path.", "comment");
    const r = mount(<PostReviewLane review={review} />);
    selectAndRelease(r.getByText("This holds up on the retry path."));
    fireEvent.click(r.getByText("Revise"));
    // The affordance opens — the reviewer can draft the instruction (packet task 4.3)…
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "tighten this to one sentence" } });
    // …but it states the gated truth and the Rework control is disabled: no pretend run (cluster 8).
    expect(r.getByText(/Revise runs with the next round — not available yet/)).toBeTruthy();
    expect(r.getByRole("button", { name: "Rework" }).hasAttribute("disabled")).toBe(true);
    // Clicking the disabled control changes nothing: the ask is untouched, no draft edit recorded.
    fireEvent.click(r.getByRole("button", { name: "Rework" }));
    expect(store().review.stagedAsks["This holds up on the retry path."]).toBeDefined();
    expect(store().review.draftEdits["This holds up on the retry path."]).toBeUndefined();
  });

  it("the Retired drawer restores a deleted block whole (re-staged, pip back up)", () => {
    stage("src/a.ts:5", "request-change", "guard the boundary");
    const r = mount(<PostReviewLane review={review} />);
    fireEvent.click(r.getByRole("button", { name: /Delete/ }));
    expect(pip()).toBe(0);
    expect(r.getByText("guard the boundary")).toBeTruthy(); // now struck in the drawer

    fireEvent.click(r.getByRole("button", { name: /Restore/ }));
    expect(store().review.stagedAsks["src/a.ts:5"]).toEqual({
      id: "src/a.ts:5",
      anchor: "src/a.ts:5",
      type: "request-change",
      body: "guard the boundary",
    });
    expect(store().review.retired).toHaveLength(0);
    expect(pip()).toBe(1);
  });

  it("the Post CTA is disabled with no egress wired", () => {
    stage("src/a.ts:5", "request-change");
    const r = mount(<PostReviewLane review={review} />);
    expect(r.getByRole("button", { name: /Post Review/ }).hasAttribute("disabled")).toBe(true);
  });

  it("posts through the egress and swaps to the receipt", async () => {
    stage("src/a.ts:5", "request-change", "guard the boundary");
    const receipt: PostReceipt = {
      verdict: "REQUEST_CHANGES",
      lineCommentCount: 1,
      url: "https://github.com/acme/orbital/pull/7#r",
    };
    const r = mount(<PostReviewLane review={review} onPost={async () => receipt} />);
    await r.user.click(r.getByRole("button", { name: /Post Review/ }));
    expect(await r.findByText(/Review posted to acme\/orbital#7/)).toBeTruthy();
    expect(r.getByText(/Request Changes · 1 line comment · body/)).toBeTruthy();
  });
});
