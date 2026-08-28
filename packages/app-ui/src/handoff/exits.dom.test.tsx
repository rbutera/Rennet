// @vitest-environment happy-dom
//
// The hand-off exits, wired LIVE (C08 cluster 6, tasks 6.1/6.3). Load-bearing claims over a
// MemoryBridge: Post Review resolves `publish.compose(mode:"review")` → `publish.review` on the
// click, and the bytes `publish.review` receives are EXACTLY the
// ones `publish.compose` returned (the preview equals what posts, R33); nothing is invoked before
// the click (nothing leaves without it); a daemon that lands no outcome fails honest (never a faked
// success); a retrospective review offers no exit; Open Pull Request resolves `publish.compose(
// mode:"pr")` → `publish.submitPr` and receipts the PR number + link.
import type { CommandInput, CommandOutput, PatchFile, Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());
afterEach(cleanup);

const FILE_A: PatchFile = {
  path: "packages/core/src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  patch: ["@@ -1,1 +1,1 @@", "-const y = 2", "+const y = 3"].join("\n"),
};

const postTarget = {
  repo: { forge: "github", owner: "acme", name: "orbital" },
  number: 7,
  forgeRef: "PR_x",
  headOid: "abc",
};

function review(over: Partial<Review> = {}): Review {
  return {
    id: "r1",
    repositoryRoot: "/repos/atlas",
    patchsets: [{ id: "ps1", files: [FILE_A] }],
    activePatchsetId: "ps1",
    ...over,
  } as unknown as Review;
}

type ReviewCompose = Extract<CommandOutput<"publish.compose">, { status: "review" }>;
const COMMENTS: ReviewCompose["comments"] = [
  { path: "src/a.ts", line: 5, side: "RIGHT", type: "request-change", body: "guard the boundary" },
  { path: "src/a.ts", side: "RIGHT", type: "comment", body: "overall this reads clean" },
];
// The daemon's byte-exact payload — `publish.review` must receive THIS exact string back.
const PAYLOAD = "canonical-review-bytes::v1";

function stage(anchor: string, type: "comment" | "request-change" = "request-change") {
  act(() =>
    useRennetStore
      .getState()
      .reviewActions.stageAsk({ id: anchor, anchor, type, body: `ask ${anchor}` }),
  );
}

/** A staged ask whose body is plain prose (no `path:line`, so `RichText` leaves one text node). */
const PROSE_BODY = "this needs a guard on the boundary";
function stageProse() {
  act(() =>
    useRennetStore.getState().reviewActions.stageAsk({
      id: "a1",
      anchor: "src/a.ts:5",
      type: "request-change",
      body: PROSE_BODY,
    }),
  );
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

function mountHandoff(r: Review, handlers: MemoryBridgeHandlers, calls: string[] = []) {
  const history = memoryHistory("/s/x?view=handoff");
  const bridge = new MemoryBridge(handlers);
  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <ReviewWorkspace review={r} />
      </Router>
    </BridgeProvider>,
  );
  return { ...view, calls };
}

describe("hand-off exits (C08 cluster 6)", () => {
  it("Post Review composes → posts the byte-exact bytes and the composed verdict, then receipts", async () => {
    const calls: string[] = [];
    let postedPayload: string | undefined;
    let postedDryRun: boolean | undefined;
    let postedVerdict: string | undefined;
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": (input) => {
        calls.push(`compose:${input.mode}`);
        return {
          status: "review",
          comments: COMMENTS,
          payload: PAYLOAD,
          verdict: "REQUEST_CHANGES",
          destination: "acme/orbital#7",
          title: "acme/orbital#7",
          compositionId: "comp-1",
        };
      },
      "publish.review": (input: CommandInput<"publish.review">) => {
        calls.push("review");
        postedPayload = input.payload;
        postedDryRun = input.dryRun;
        postedVerdict = input.verdict;
        return {
          dryRun: false,
          request: { endpoint: "graphql", method: "POST", body: {} },
          marker: "m1",
          ledger: [],
          outcome: {
            reviewRef: "R_1",
            url: "https://github.com/acme/orbital/pull/7#r1",
            reused: false,
          },
        };
      },
    };
    const r = mountHandoff(review({ postTarget }), handlers);
    stage("src/a.ts:5", "request-change");

    // Compose fires on open (the exact-preview contract): the lane renders the daemon's composed
    // bytes, NOT the store's staged asks. The composed comment body shows; the store ask body
    // ("ask src/a.ts:5") never does — the preview is the outbound review, not the working set.
    expect(await r.findByText("guard the boundary")).toBeTruthy();
    expect(r.getByText("overall this reads clean")).toBeTruthy();
    expect(r.queryByText("ask src/a.ts:5")).toBeNull();
    // Compose ran (a read); nothing that LEAVES the machine has — no post without the sign-click.
    expect(calls).toEqual(["compose:review"]);

    await r.user.click(r.getByRole("button", { name: /Post Review/ }));

    // The click ran the egress — and never re-composed (compose stays at one). No consent leg:
    // the click IS the authorization (#435).
    expect(calls).toEqual(["compose:review", "review"]);
    // The preview equals what posts: publish.review received the exact bytes compose returned,
    // and the COMPOSED verdict — the daemon binds both, so no other event could post.
    expect(postedPayload).toBe(PAYLOAD);
    expect(postedVerdict).toBe("REQUEST_CHANGES");
    // Real egress is the explicit opt-in.
    expect(postedDryRun).toBe(false);
    // The receipt names the verdict + line-comment count (one of two comments carries a line) + link.
    expect(await r.findByText(/Review posted to acme\/orbital#7/)).toBeTruthy();
    expect(r.getByText(/Request Changes · 1 line comment · body/)).toBeTruthy();
    expect(r.getByText("github.com/acme/orbital/pull/7#r1")).toBeTruthy();
  });

  it("an inline edit that can't reach the composition is marked pending — never silently divergent", async () => {
    // The reviewer stages an ask AND types an inline edit into the store. `publish.compose` takes
    // no edit input, so that edit cannot reach the outbound bytes. The lane must (a) still post the
    // composed bytes byte-for-byte, and (b) visibly mark the unreachable edit — not drop it silently.
    let postedPayload: string | undefined;
    let postedComments: unknown;
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": () => ({
        status: "review",
        comments: COMMENTS,
        payload: PAYLOAD,
        verdict: "REQUEST_CHANGES",
        destination: "acme/orbital#7",
        title: "acme/orbital#7",
        compositionId: "comp-1",
      }),
      "publish.review": (input: CommandInput<"publish.review">) => {
        postedPayload = input.payload;
        postedComments = input.comments;
        return {
          dryRun: false,
          request: { endpoint: "graphql", method: "POST", body: {} },
          marker: "m1",
          ledger: [],
          outcome: { reviewRef: "R_1", url: "https://x/1", reused: false },
        };
      },
    };
    stage("src/a.ts:5", "request-change");
    act(() => useRennetStore.getState().reviewActions.setDraftEdit("src/a.ts:5", "MY LOCAL EDIT"));

    const r = mountHandoff(review({ postTarget }), handlers);
    // The pending-mark shows: the inline edit is named as not-in-this-review, not silently applied.
    expect(await r.findByText(/1 inline edit pending — not in this composed review/)).toBeTruthy();
    // …and the reviewer's local edit text is nowhere in the previewed (outbound) bytes.
    expect(r.queryByText(/MY LOCAL EDIT/)).toBeNull();

    await r.user.click(r.getByRole("button", { name: /Post Review/ }));
    // What posts is the composed bytes, byte-for-byte — the local edit reached neither preview nor post.
    expect(postedPayload).toBe(PAYLOAD);
    expect(postedComments).toEqual(COMMENTS);
  });

  it("a daemon that lands no outcome fails honest — never a faked post", async () => {
    stage("src/a.ts:5", "request-change");
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": () => ({
        status: "review",
        comments: COMMENTS,
        payload: PAYLOAD,
        verdict: "REQUEST_CHANGES",
        destination: "acme/orbital#7",
        title: "acme/orbital#7",
        compositionId: "comp-1",
      }),
      // A dry-run-shaped response: nothing left the machine (outcome null).
      "publish.review": () => ({
        dryRun: true,
        request: { endpoint: "graphql", method: "POST", body: {} },
        marker: "m1",
        ledger: [],
        outcome: null,
      }),
    };
    const r = mountHandoff(review({ postTarget }), handlers);
    // Wait for compose-on-open to arm the CTA (the composed bytes render), then sign.
    expect(await r.findByText("guard the boundary")).toBeTruthy();
    await r.user.click(r.getByRole("button", { name: /Post Review/ }));
    // No receipt: the lane stays on the draft, the Post CTA re-armed (honest, not a fake success).
    expect(r.queryByText(/Review posted to/)).toBeNull();
    expect(r.getByRole("button", { name: /Post Review/ })).toBeTruthy();
  });

  it("a retrospective review offers no exit and composes nothing", () => {
    const calls: string[] = [];
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": (input) => {
        calls.push(`compose:${input.mode}`);
        return { status: "unavailable", reason: "retrospective" };
      },
    };
    const r = mountHandoff(review({ retrospective: true }), handlers);
    // The hand-off view renders nothing for a retrospective review (law 10).
    expect(r.queryByRole("button", { name: /Post Review|Open Pull Request/ })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("selection Revise dispatches the live review.reviseSpan and stages the reworked body", async () => {
    // The end-to-end revise path (C08 cluster 8, over B11's landed command): the reviewer selects
    // a span in the own-branch Changes surface, drafts an instruction, and Rework fires the
    // REGISTERED `review.reviseSpan` once — carrying the review, the ask the span belongs to, the
    // selected span and the instruction — then stages the body the daemon's CAS+splice returned.
    const calls: CommandInput<"review.reviseSpan">[] = [];
    const handlers: MemoryBridgeHandlers = {
      "review.reviseSpan": (input) => {
        calls.push(input);
        return {
          status: "reworked",
          carriedAnchor: "guard the boundary on retry",
          reworkedBody: "guard the boundary on retry",
          receipt: { kind: "edit", id: input.askId, body: PROSE_BODY },
        };
      },
    };
    const r = mountHandoff(review(), handlers); // own branch → the rounds lanes
    stageProse();
    selectAndRelease(await r.findByText(PROSE_BODY));
    await r.user.click(r.getByText("Revise"));
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "make this concrete" } });
    await r.user.click(r.getByRole("button", { name: "Rework" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      reviewId: "r1",
      askId: "a1",
      span: PROSE_BODY,
      instruction: "make this concrete",
    });
    expect(typeof calls[0]?.commandId).toBe("string");
    // The rework landed on the ask — the card renders the reworked body, not the old one.
    expect(await r.findByText("guard the boundary on retry")).toBeTruthy();
    expect(useRennetStore.getState().review.stagedAsks.a1?.body).toBe(
      "guard the boundary on retry",
    );
  });

  it("a rework the daemon refuses states the reason and leaves the ask alone", async () => {
    const handlers: MemoryBridgeHandlers = {
      "review.reviseSpan": () => ({
        status: "unavailable",
        reason: "Span rework is not available in this build.",
      }),
    };
    const r = mountHandoff(review(), handlers);
    stageProse();
    selectAndRelease(await r.findByText(PROSE_BODY));
    await r.user.click(r.getByText("Revise"));
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "make this concrete" } });
    await r.user.click(r.getByRole("button", { name: "Rework" }));

    // The daemon's own reason is shown; the panel stays open and the ask body is untouched.
    expect(await r.findByText(/Span rework is not available in this build\./)).toBeTruthy();
    expect(useRennetStore.getState().review.stagedAsks.a1?.body).toBe(PROSE_BODY);
  });

  it("Open Pull Request composes(pr) → submits, then receipts the PR number + link", async () => {
    let submittedPayload: string | undefined;
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": (input) => {
        expect(input.mode).toBe("pr");
        return {
          status: "pr",
          submission: {
            title: "Harden the retry path",
            body: "## Summary\n\nGuards the boundary.",
            base: "main",
            head: "feat/x",
            draft: true,
          },
          payload: PAYLOAD,
          destination: "atlas:feat/x → main",
          title: "Harden the retry path",
          compositionId: "comp-pr-1",
        };
      },
      "publish.submitPr": (input: CommandInput<"publish.submitPr">) => {
        submittedPayload = input.payload;
        return { url: "https://github.com/acme/orbital/pull/42", number: 42, reused: false };
      },
    };
    // Own-branch review (no postTarget), nothing staged → the composed PR IS the page.
    const r = mountHandoff(review(), handlers);
    const open = await r.findByRole("button", { name: /Open Pull Request/ });
    expect(r.getByText("Harden the retry path")).toBeTruthy();

    await r.user.click(open);
    // The submitted payload is the byte-exact one compose returned (what you preview is what opens).
    expect(submittedPayload).toBe(PAYLOAD);
    expect(await r.findByText(/Pull request opened · #42/)).toBeTruthy();
    expect(r.getByText("github.com/acme/orbital/pull/42")).toBeTruthy();
  });
});
