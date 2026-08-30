// @vitest-environment happy-dom
//
// The hand-off exits, wired LIVE (C08 cluster 6, tasks 6.1/6.3). Load-bearing claims over a
// MemoryBridge: Post Review resolves `publish.compose(mode:"review")` → `publish.review` on the
// click, and the bytes `publish.review` receives are EXACTLY the
// ones `publish.compose` returned (the preview equals what posts, R33); nothing is invoked before
// the click (nothing leaves without it); a daemon that lands no outcome fails honest (never a faked
// success); a retrospective review offers no exit; Open Pull Request resolves `publish.compose(
// mode:"pr")` → `publish.submitPr` and receipts the PR number + link; and a compose the daemon
// REFUSED states the daemon's own reason where the exit would have been, rather than leaving a
// disabled CTA (or an absent one) with no account of itself.
import type {
  AskProjection,
  CommandInput,
  CommandOutput,
  PatchFile,
  Review,
} from "@rennet/protocol";
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
const COMMENTS: ReviewCompose["artifact"]["comments"] = [
  { path: "src/a.ts", line: 5, side: "RIGHT", type: "request-change", body: "guard the boundary" },
  { path: "src/a.ts", side: "RIGHT", type: "comment", body: "overall this reads clean" },
];
const BODY_NOTES: ReviewCompose["artifact"]["bodyNotes"] = [
  {
    id: "ask-overall",
    anchor: "Design · Retry policy",
    type: "comment",
    body: "the policy matches its documented boundary",
  },
];
const ARTIFACT: ReviewCompose["artifact"] = {
  opener: "Exact daemon opener.",
  comments: COMMENTS,
  bodyNotes: BODY_NOTES,
};
const POST: ReviewCompose["post"] = {
  event: "REQUEST_CHANGES",
  body: "Exact daemon opener.\n\noverall this reads clean\n\nthe policy matches its documented boundary",
  threads: [
    { path: "src/a.ts", line: 5, side: "RIGHT", body: "[Request change]\n\nguard the boundary" },
  ],
};
const LEDGER: ReviewCompose["ledger"] = [
  { kind: "body-note", path: "Design · Retry policy", detail: "Included in the review body." },
];
// The daemon's byte-exact payload — `publish.review` must receive THIS exact string back.
const PAYLOAD = "canonical-review-bytes::v1";
const EMPTY_PROJECTION: AskProjection = {
  stagedAsks: {},
  findingDispositions: {},
  lineComments: {},
  quoteThreads: {},
  retired: {},
  verdictOverride: null,
};

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
  return { ...view, calls, bridge };
}

describe("hand-off exits (C08 cluster 6)", () => {
  it("Post Review renders and posts the exact aggregate, then receipts", async () => {
    const calls: string[] = [];
    let posted: CommandInput<"publish.review"> | undefined;
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": (input) => {
        calls.push(`compose:${input.mode}`);
        return {
          status: "review",
          artifact: ARTIFACT,
          post: POST,
          ledger: LEDGER,
          payload: PAYLOAD,
          destination: "acme/orbital#7",
          title: "acme/orbital#7",
          compositionId: "comp-1",
        };
      },
      "publish.review": (input: CommandInput<"publish.review">) => {
        calls.push("review");
        posted = input;
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
    expect(r.getAllByText("the policy matches its documented boundary")).toHaveLength(2);
    expect(r.getByText("Design · Retry policy")).toBeTruthy();
    expect(r.getByText(/body-note · Design · Retry policy/)).toBeTruthy();
    expect(r.container.textContent).toContain("Included in the review body.");
    expect(r.queryByText("ask src/a.ts:5")).toBeNull();
    // Compose ran (a read); nothing that LEAVES the machine has — no post without the sign-click.
    expect(calls).toEqual(["compose:review"]);

    await r.user.click(r.getByRole("button", { name: /Post Review/ }));

    // The click ran the egress — and never re-composed (compose stays at one). No consent leg:
    // the click IS the authorization (#435).
    expect(calls).toEqual(["compose:review", "review"]);
    // The preview equals what posts: the frozen aggregate is round-tripped, and no target or
    // second verdict can be re-derived by the client.
    expect(posted).toMatchObject({
      reviewId: "r1",
      artifact: ARTIFACT,
      post: POST,
      payload: PAYLOAD,
      compositionId: "comp-1",
      dryRun: false,
    });
    expect(posted).not.toHaveProperty("target");
    expect(posted).not.toHaveProperty("verdict");
    // The receipt names the descriptor event + exact thread count + link.
    expect(await r.findByText(/Review posted to acme\/orbital#7/)).toBeTruthy();
    expect(r.getByText(/Request Changes · 1 line comment · body/)).toBeTruthy();
    expect(r.getByText("github.com/acme/orbital/pull/7#r1")).toBeTruthy();
  });

  it("posts an approval with zero asks using the exact descriptor", async () => {
    const artifact: ReviewCompose["artifact"] = {
      opener: "Exact approval body from the daemon.",
      comments: [],
      bodyNotes: [],
    };
    const post: ReviewCompose["post"] = {
      event: "APPROVE",
      body: "Exact approval body from the daemon.",
      threads: [],
    };
    let posted: CommandInput<"publish.review"> | undefined;
    const r = mountHandoff(review({ postTarget }), {
      "publish.compose": () => ({
        status: "review",
        artifact,
        post,
        ledger: [],
        payload: "canonical-approval-bytes",
        destination: "acme/orbital#7",
        title: "acme/orbital#7",
        compositionId: "comp-approval",
      }),
      "publish.review": (input) => {
        posted = input;
        return {
          dryRun: false,
          request: { endpoint: "graphql", method: "POST", body: {} },
          marker: "m-approval",
          ledger: [],
          outcome: { reviewRef: "R_APPROVE", url: "https://x/approval", reused: false },
        };
      },
    });

    expect(await r.findByText(post.body)).toBeTruthy();
    expect(r.queryByText(/Review Threads/)).toBeNull();
    await r.user.click(r.getByRole("button", { name: /Post Review/ }));

    expect(posted).toMatchObject({
      artifact,
      post,
      payload: "canonical-approval-bytes",
      compositionId: "comp-approval",
      dryRun: false,
    });
    expect(posted).not.toHaveProperty("target");
    expect(posted).not.toHaveProperty("verdict");
    expect(await r.findByText(/Approve · 0 line comments · body/)).toBeTruthy();
  });

  it("a verdict flip writes the ask log and RECOMPOSES — Post posts the recomposed verdict", async () => {
    // The single verdict channel (#435). The verdict rides in the composition binding, so it can
    // only change by changing the COMPOSITION: a flip writes `ask.setVerdictOverride`, the daemon
    // recomposes, and Post ships the recomposed event. There is no second verdict argument, and a
    // flip that stayed local would silently post the un-flipped verdict.
    //
    // The composed set here has NO request-change among the line comments — the request-change is
    // a pathless BODY note, exactly like the daemon's own derivation input. So "proposed" must be
    // derived over BOTH strata; deriving over the line comments alone would report the composition
    // as "overridden — proposed comment" against its own honest REQUEST_CHANGES.
    const calls: string[] = [];
    let composedVerdict: "REQUEST_CHANGES" | "COMMENT" | "APPROVE" = "REQUEST_CHANGES";
    let postedPost: CommandInput<"publish.review">["post"] | undefined;
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": () => {
        calls.push(`compose:${composedVerdict}`);
        return {
          status: "review",
          artifact: {
            opener: "Exact daemon opener.",
            comments: [
              { path: "src/a.ts", line: 5, side: "RIGHT", type: "comment", body: "a line note" },
            ],
            bodyNotes: [
              {
                id: "ask-boundary",
                anchor: "Design · Boundary",
                type: "request-change",
                body: "guard the boundary",
              },
            ],
          },
          post: {
            event: composedVerdict,
            body: "Exact daemon opener.\n\nguard the boundary",
            threads: [{ path: "src/a.ts", line: 5, side: "RIGHT", body: "a line note" }],
          },
          ledger: [],
          payload: PAYLOAD,
          destination: "acme/orbital#7",
          title: "acme/orbital#7",
          compositionId: `comp-${composedVerdict}`,
        };
      },
      "ask.setVerdictOverride": (input) => {
        calls.push(`override:${input.verdict}`);
        // The real daemon lands the override on the ask log, so the NEXT compose carries it.
        composedVerdict = input.verdict ?? "REQUEST_CHANGES";
        return { receipt: { kind: "verdict-override-set", verdict: "APPROVE" } };
      },
      "publish.review": (input) => {
        calls.push("review");
        postedPost = input.post;
        return {
          dryRun: false,
          request: { endpoint: "graphql", method: "POST", body: {} },
          marker: "m1",
          ledger: [],
          outcome: { reviewRef: "R_1", url: "https://x/1", reused: false },
        };
      },
    };
    const r = mountHandoff(review({ postTarget }), handlers);
    stage("src/a.ts:5", "request-change");
    expect(await r.findByText("a line note")).toBeTruthy();
    // The composition agrees with itself: the body-note request-change IS the proposal, so the
    // control reports no override and offers no dead revert.
    expect(r.getByText(/proposed from your review/)).toBeTruthy();
    expect(r.queryByText(/overridden/)).toBeNull();

    await r.user.click(r.getByRole("button", { name: /Approve/ }));

    // The flip landed on the ask log and the lane RECOMPOSED (the override now differs from the
    // proposal, which only the recomposed draft can say).
    expect(await r.findByText(/overridden — proposed request changes/)).toBeTruthy();
    expect(calls).toEqual(["compose:REQUEST_CHANGES", "override:APPROVE", "compose:APPROVE"]);

    await r.user.click(r.getByRole("button", { name: /Post Review/ }));
    // What posts is the RECOMPOSED descriptor — its event is on screen, never a second field.
    expect(postedPost?.event).toBe("APPROVE");
    expect(await r.findByText(/Approve · 1 line comment · body/)).toBeTruthy();
  });

  it("recomposes a held-open signing preview when another client pushes a new ask projection", async () => {
    let remoteRevision = 0;
    let remoteAttempts = 0;
    const composedRevisions: number[] = [];
    const r = mountHandoff(review({ postTarget }), {
      "ask.read": () => ({ projection: EMPTY_PROJECTION }),
      "publish.compose": () => {
        composedRevisions.push(remoteRevision);
        if (remoteRevision === 1 && remoteAttempts++ === 0) {
          throw new Error("temporary compose failure");
        }
        const opener = remoteRevision === 0 ? "Before the remote edit." : "After the remote edit.";
        return {
          status: "review",
          artifact: { opener, comments: [], bodyNotes: [] },
          post: { event: "APPROVE", body: opener, threads: [] },
          ledger: [],
          payload: `payload-${remoteRevision}`,
          destination: "acme/orbital#7",
          title: "acme/orbital#7",
          compositionId: `composition-${remoteRevision}`,
        };
      },
    });

    expect(await r.findByText("Before the remote edit.")).toBeTruthy();
    remoteRevision = 1;
    act(() =>
      r.bridge.emitAskProjection("r1", {
        ...EMPTY_PROJECTION,
        stagedAsks: {
          remote: {
            id: "remote",
            anchor: "Review summary",
            type: "comment",
            body: "added from the phone",
          },
        },
      }),
    );

    // Invalidation hides the signed bytes and disarms Post before the replacement arrives.
    await r.findByText("temporary compose failure");
    expect(r.queryByText("Before the remote edit.")).toBeNull();
    expect(r.getByRole("button", { name: /Post Review/ }).hasAttribute("disabled")).toBe(true);

    // A failed refresh is retryable in place; the older cached aggregate never becomes current
    // again, and the successful retry replaces it without route navigation.
    expect(await r.findByText("After the remote edit.", {}, { timeout: 2_000 })).toBeTruthy();
    expect(r.queryByText("Before the remote edit.")).toBeNull();
    expect(composedRevisions).toEqual([0, 1, 1]);
  });

  it("an inline edit that can't reach the composition is marked pending — never silently divergent", async () => {
    // The reviewer stages an ask AND types an inline edit into the store. `publish.compose` takes
    // no edit input, so that edit cannot reach the outbound bytes. The lane must (a) still post the
    // composed bytes byte-for-byte, and (b) visibly mark the unreachable edit — not drop it silently.
    let posted: CommandInput<"publish.review"> | undefined;
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": () => ({
        status: "review",
        artifact: ARTIFACT,
        post: POST,
        ledger: LEDGER,
        payload: PAYLOAD,
        destination: "acme/orbital#7",
        title: "acme/orbital#7",
        compositionId: "comp-1",
      }),
      "publish.review": (input: CommandInput<"publish.review">) => {
        posted = input;
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
    expect(posted?.payload).toBe(PAYLOAD);
    expect(posted?.artifact).toEqual(ARTIFACT);
    expect(posted?.post).toEqual(POST);
  });

  it("a daemon that lands no outcome fails honest — never a faked post", async () => {
    stage("src/a.ts:5", "request-change");
    const handlers: MemoryBridgeHandlers = {
      "publish.compose": () => ({
        status: "review",
        artifact: ARTIFACT,
        post: POST,
        ledger: LEDGER,
        payload: PAYLOAD,
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

  it("a compose the daemon REFUSED states its reason beside the dead Post CTA", async () => {
    // The silent half of the exits, and the only thing here that read as a gate: `publish.compose`
    // answers `unavailable` with words (an unsafe comment path, here), the CTA has nothing to post
    // through and renders disabled — and the reason used to be dropped, leaving a grey button and
    // no account of it. `HandoffAction` surfaces only errors a CLICK threw, which disabled forbids.
    stage("src/a.ts:5", "request-change");
    const r = mountHandoff(review({ postTarget }), {
      "publish.compose": () => ({
        status: "unavailable",
        reason: "A review comment has an unsafe path (/etc/passwd); it cannot be posted.",
      }),
    });
    expect(
      await r.findByText("A review comment has an unsafe path (/etc/passwd); it cannot be posted."),
    ).toBeTruthy();
    expect(r.getByRole("button", { name: /Post Review/ }).hasAttribute("disabled")).toBe(true);
  });

  it("retries a transient board-drafting composition without leaving the signing view", async () => {
    let attempts = 0;
    const r = mountHandoff(review({ postTarget }), {
      "publish.compose": () => {
        attempts += 1;
        return attempts === 1
          ? {
              status: "unavailable",
              reason: "The current review boards are still drafting.",
              retryable: true,
            }
          : {
              status: "review",
              artifact: ARTIFACT,
              post: POST,
              ledger: LEDGER,
              payload: PAYLOAD,
              destination: "acme/orbital#7",
              title: "acme/orbital#7",
              compositionId: "comp-after-drafting",
            };
      },
    });

    expect(await r.findByText("The current review boards are still drafting.")).toBeTruthy();
    expect(await r.findByText("Exact daemon opener.", {}, { timeout: 2_000 })).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("a PR the daemon REFUSED to compose says why, instead of a lane that silently never becomes one", async () => {
    // Own-branch, nothing left to ask — the lane would BECOME the pull request if compose landed
    // one. It refused, so there is no Open Pull Request button at all; without the reason that is
    // a dead end the reviewer cannot read (they see "Nothing staged yet." and nothing else).
    const r = mountHandoff(review(), {
      "publish.compose": () => ({
        status: "unavailable",
        reason: "HEAD is detached — there is no branch to open a pull request from.",
      }),
    });
    expect(
      await r.findByText("HEAD is detached — there is no branch to open a pull request from."),
    ).toBeTruthy();
    expect(r.queryByRole("button", { name: /Open Pull Request/ })).toBeNull();
  });

  it("your own already-open PR narrates nothing — it never asks for a PR it cannot open", async () => {
    // The inverse of the two tests above, and the trap that comes WITH them: a refusal that
    // renders can state a fault during correct operation. `resolveEntryMode` routes your own
    // already-open PR to own-branch (C14 §6 — rounds keep going, the round loop IS the exit), and
    // `publish.compose(mode:"pr")` refuses it with `"This is a team-PR review…"`: wrong twice over
    // here, since the reviewer AUTHORED the PR and nothing is broken. Driven before the fix, this
    // exact copy rendered under Dispatch Round on a perfectly healthy session.
    //
    // Aimed at the shape that would break it, not at the current absence: this bridge refuses
    // mode "pr" the way the real daemon does, so re-enabling the fetch reddens BOTH assertions.
    const modes: string[] = [];
    const r = mountHandoff(
      review({
        postTarget: { ...postTarget, viewerDidAuthor: true },
      }),
      {
        "publish.compose": (input) => {
          modes.push(input.mode);
          return {
            status: "unavailable",
            reason:
              'This is a team-PR review — post it as a review (mode "review"), not a new pull request.',
          };
        },
      },
    );
    // The own-branch rounds lane, and nothing narrating it.
    expect(await r.findByRole("button", { name: "Dispatch Round" })).toBeTruthy();
    expect(r.queryByText(/team-PR review/)).toBeNull();
    // A round-trip that could only ever have been refused is never made.
    expect(modes).toEqual([]);
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
    expect(r.getByText("main ← feat/x · Draft")).toBeTruthy();

    await r.user.click(open);
    // The submitted payload is the byte-exact one compose returned (what you preview is what opens).
    expect(submittedPayload).toBe(PAYLOAD);
    expect(await r.findByText(/Pull request opened · #42/)).toBeTruthy();
    expect(r.getByText("github.com/acme/orbital/pull/42")).toBeTruthy();
  });
});
