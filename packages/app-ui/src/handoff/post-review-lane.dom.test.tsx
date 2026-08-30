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
import type { ReviewDraft } from "./handoff-data";
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
  it("proposes the verdict from the staged asks and flips it DURABLY (with 'use proposal' to revert)", async () => {
    // A flip must reach the durable ask log, not just the local store (#435): `publish.compose`
    // composes from the ask log, so a local-only flip would be silently discarded the moment the
    // composed preview arrived — the reviewer's own verdict, lost without a word.
    const durable: (string | null)[] = [];
    stage("src/a.ts:3", "request-change");
    const r = mount(<PostReviewLane review={review} onSetVerdict={(v) => durable.push(v)} />);
    // A request-change ask proposes Request Changes, with its arithmetic beside the control.
    expect(r.getByText(/proposed from your review · 1 request change · 0 comments/)).toBeTruthy();
    expect(store().review.verdictOverride).toBeNull(); // no override yet — the proposal stands

    await r.user.click(r.getByRole("button", { name: /Approve/ }));
    expect(store().review.verdictOverride).toBe("APPROVE");
    expect(durable).toEqual(["APPROVE"]); // …and it landed on the ask log
    expect(r.getByText(/overridden — proposed request changes/)).toBeTruthy();

    await r.user.click(r.getByRole("button", { name: "use proposal" }));
    expect(store().review.verdictOverride).toBeNull();
    expect(durable).toEqual(["APPROVE", null]); // the revert is durable too
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

  it("Edit replaces the canonical ask body; Delete retires the ask and unstages it", async () => {
    stage("src/a.ts:5", "request-change", "guard the boundary");
    const r = mount(<PostReviewLane review={review} />);
    expect(pip()).toBe(1);

    fireEvent.click(r.getByRole("button", { name: /Edit/ }));
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "guard the boundary tightly" } });
    fireEvent.click(r.getByRole("button", { name: "Save" }));
    expect(store().review.stagedAsks["src/a.ts:5"]?.body).toBe("guard the boundary tightly");
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

  it("selection Revise reworks the span through review.reviseSpan and re-stages the body", async () => {
    stage("This holds up on the retry path.", "comment");
    const calls: { askId: string; span: string; instruction: string }[] = [];
    const r = mount(
      <PostReviewLane
        review={review}
        onRevise={async (args) => {
          calls.push(args);
          return {
            status: "reworked",
            carriedAnchor: "It holds on retry.",
            reworkedBody: "It holds on retry.",
            receipt: { kind: "edit", id: "This holds up on the retry path.", body: "old" },
          };
        }}
      />,
    );
    selectAndRelease(r.getByText("This holds up on the retry path."));
    fireEvent.click(r.getByText("Revise"));
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "tighten this to one sentence" } });
    // The control is LIVE (no gate note, not disabled) — the affordance runs for real.
    expect(r.queryByText(/not available on this view/)).toBeNull();
    const rework = r.getByRole("button", { name: "Rework" });
    expect(rework.hasAttribute("disabled")).toBe(false);
    await r.user.click(rework);

    // Exactly one dispatch, carrying the selected span, the instruction, and the ask it belongs to.
    expect(calls).toEqual([
      {
        askId: "This holds up on the retry path.",
        span: "This holds up on the retry path.",
        instruction: "tighten this to one sentence",
      },
    ]);
    // The reworked body is staged back on the ask (a body swap in place) and rendered.
    expect(store().review.stagedAsks["This holds up on the retry path."]?.body).toBe(
      "It holds on retry.",
    );
    expect(await r.findByText("It holds on retry.")).toBeTruthy();
  });

  it("a rework over a saved edit replaces the same canonical ask body", async () => {
    stage("This holds up on the retry path.", "comment");
    act(() => store().reviewActions.editAsk("This holds up on the retry path.", "MY SAVED EDIT"));
    const r = mount(
      <PostReviewLane
        review={review}
        onRevise={async () => ({
          status: "reworked",
          carriedAnchor: null,
          reworkedBody: "guard the boundary on every retry",
          receipt: {
            kind: "edit",
            id: "This holds up on the retry path.",
            body: "MY SAVED EDIT",
          },
        })}
      />,
    );
    selectAndRelease(r.getByText("MY SAVED EDIT"));
    fireEvent.click(r.getByText("Revise"));
    fireEvent.change(r.container.querySelector("textarea") as HTMLTextAreaElement, {
      target: { value: "cover every retry" },
    });
    await r.user.click(r.getByRole("button", { name: "Rework" }));

    expect(await r.findByText("guard the boundary on every retry")).toBeTruthy();
    expect(r.queryByText("MY SAVED EDIT")).toBeNull();
    expect(store().review.stagedAsks["This holds up on the retry path."]?.body).toBe(
      "guard the boundary on every retry",
    );
  });

  it("a rework that does not land states the reason and never dismisses as success", async () => {
    stage("This holds up on the retry path.", "comment");
    const r = mount(
      <PostReviewLane
        review={review}
        onRevise={async () => ({
          status: "unavailable",
          reason: "The ask changed while the rework was running — discarded.",
        })}
      />,
    );
    selectAndRelease(r.getByText("This holds up on the retry path."));
    fireEvent.click(r.getByText("Revise"));
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "tighten this" } });
    await r.user.click(r.getByRole("button", { name: "Rework" }));

    // The panel stays open with the daemon's honest reason; the ask body is untouched.
    expect(
      await r.findByText(/The ask changed while the rework was running — discarded\./),
    ).toBeTruthy();
    expect(store().review.stagedAsks["This holds up on the retry path."]?.body).toBe(
      "body for This holds up on the retry path.",
    );
  });

  it("without a bound rework the control is disabled and says so — no pretend run", () => {
    stage("This holds up on the retry path.", "comment");
    const r = mount(<PostReviewLane review={review} />);
    selectAndRelease(r.getByText("This holds up on the retry path."));
    fireEvent.click(r.getByText("Revise"));
    expect(r.getByText(/Revise is not available on this view/)).toBeTruthy();
    expect(r.getByRole("button", { name: "Rework" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(r.getByRole("button", { name: "Rework" }));
    expect(store().review.stagedAsks["This holds up on the retry path."]?.body).toBe(
      "body for This holds up on the retry path.",
    );
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

  it("keeps quote threads and code comments visible as local residue after composition", () => {
    act(() => {
      store().reviewActions.addQuoteComment("quoted review prose", "keep this local");
      store().reviewActions.setCodeComment("src/local.ts", 9, "also local");
    });

    const working = mount(<PostReviewLane review={review} />);
    expect(working.getByText("1 thread · 1 code comment stay local")).toBeTruthy();
    working.unmount();

    const draft: ReviewDraft = {
      artifact: {
        opener: "Exact opener.",
        comments: [
          {
            path: "src/outbound.ts",
            line: 4,
            side: "RIGHT",
            type: "comment",
            body: "outbound comment",
          },
        ],
        bodyNotes: [],
      },
      post: {
        event: "COMMENT",
        body: "Exact opener.",
        threads: [{ path: "src/outbound.ts", line: 4, side: "RIGHT", body: "outbound comment" }],
      },
      ledger: [],
      proposed: "COMMENT",
      arithmetic: { requestChanges: 0, comments: 1 },
      destination: "acme/orbital#7",
    };
    const composed = mount(<PostReviewLane review={review} draft={draft} />);
    const lineComments = composed.getByText("Review Threads · 1");
    const residue = composed.getByText("1 thread · 1 code comment stay local");
    const post = composed.getByRole("button", { name: /Post Review/ });

    expect(
      lineComments.compareDocumentPosition(residue) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(residue.compareDocumentPosition(post) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("renders each composed review-body note with its intent and source provenance", () => {
    const draft = {
      artifact: {
        opener: "Exact opener.",
        comments: [],
        bodyNotes: [
          {
            id: "ask-overall",
            anchor: "Design · Retry policy",
            type: "comment",
            body: "the policy matches its documented boundary",
          },
        ],
      },
      post: { event: "COMMENT", body: "Exact daemon body.", threads: [] },
      ledger: [],
      proposed: "COMMENT",
      arithmetic: { requestChanges: 0, comments: 1 },
      destination: "acme/orbital#7",
    } as ReviewDraft;

    const r = mount(<PostReviewLane review={review} draft={draft} />);

    expect(r.getByText("Body Note Provenance")).toBeTruthy();
    expect(r.container.querySelector('[data-slot="badge"]')?.textContent).toBe("Comment");
    expect(r.getByText("Design · Retry policy")).toBeTruthy();
    expect(r.getByText("the policy matches its documented boundary")).toBeTruthy();
  });

  it("labels every composed review-body note with its exact disposition", () => {
    const bodyNotes = [
      {
        id: "ask-approve",
        anchor: "Source for Approve",
        type: "approve",
        body: "Approve body",
      },
      {
        id: "ask-request-change",
        anchor: "Source for Request Change",
        type: "request-change",
        body: "Request Change body",
      },
      {
        id: "ask-comment",
        anchor: "Source for Comment",
        type: "comment",
        body: "Comment body",
      },
      {
        id: "ask-question",
        anchor: "Source for Question",
        type: "question",
        body: "Question body",
      },
    ] satisfies ReviewDraft["artifact"]["bodyNotes"];
    const draft: ReviewDraft = {
      artifact: { opener: "Exact opener.", comments: [], bodyNotes },
      post: { event: "REQUEST_CHANGES", body: "Exact daemon body.", threads: [] },
      ledger: [],
      proposed: "REQUEST_CHANGES",
      arithmetic: { requestChanges: 1, comments: 3 },
      destination: "acme/orbital#7",
    };

    const r = mount(<PostReviewLane review={review} draft={draft} />);

    expect(
      [...r.container.querySelectorAll('[data-slot="badge"]')].map((badge) => badge.textContent),
    ).toEqual(["Approve", "Request Change", "Comment", "Question"]);
  });

  it("renders the exact daemon body for a zero-ask approval", () => {
    const body = "Exact daemon approval body.";
    const draft: ReviewDraft = {
      artifact: { opener: "Artifact opener provenance.", comments: [], bodyNotes: [] },
      post: { event: "APPROVE", body, threads: [] },
      ledger: [],
      proposed: "APPROVE",
      arithmetic: { requestChanges: 0, comments: 0 },
      destination: "acme/orbital#7",
    };

    const r = mount(<PostReviewLane review={review} draft={draft} />);

    expect(r.getByText(body)).toBeTruthy();
    expect(r.queryByText("Artifact opener provenance.")).toBeNull();
    expect(r.queryByText(/Review Threads/)).toBeNull();
    expect(r.getByText(/proposed from your review/)).toBeTruthy();
  });

  it("renders the real forge body structurally without exposing its idempotency marker", () => {
    const quoted =
      "<!-- rennet:review:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff -->";
    const marker =
      "<!-- rennet:review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
    const draft: ReviewDraft = {
      artifact: { opener: "Exact opener.", comments: [], bodyNotes: [] },
      post: {
        event: "COMMENT",
        body: `Exact opener quotes ${quoted}.\n\n## Review notes\n- **Comment** — Keep the retry visible.\n\n${marker}`,
        threads: [],
      },
      ledger: [],
      proposed: "APPROVE",
      arithmetic: { requestChanges: 0, comments: 0 },
      destination: "acme/orbital#7",
    };

    const r = mount(<PostReviewLane review={review} draft={draft} />);

    expect(r.getByText(`Exact opener quotes ${quoted}.`)).toBeTruthy();
    expect(r.getByRole("heading", { level: 3, name: "Review notes" })).toBeTruthy();
    expect(r.container.querySelector("strong")?.textContent).toBe("Comment");
    expect(r.queryByText(/## Review notes/)).toBeNull();
    expect(r.container.textContent).toContain(quoted);
    expect(r.container.textContent).not.toContain(marker);
  });
});
