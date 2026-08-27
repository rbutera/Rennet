// @vitest-environment happy-dom
//
// The hand-off exits, wired LIVE (C08 cluster 6, tasks 6.1/6.3). Load-bearing claims over a
// MemoryBridge: Post Review resolves `publish.compose(mode:"review")` → `publish.requestConsent`
// → `publish.review` on the sign-click, and the bytes `publish.review` receives are EXACTLY the
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
import { act, cleanup, mount } from "../test/dom";
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
    useRennetStore.getState().reviewActions.stageAsk({ anchor, type, body: `ask ${anchor}` }),
  );
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
  it("Post Review composes → requests consent → posts the byte-exact bytes, then receipts", async () => {
    const calls: string[] = [];
    let postedPayload: string | undefined;
    let postedDryRun: boolean | undefined;
    let postedAuth: string | undefined;
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
      "publish.requestConsent": (input: CommandInput<"publish.requestConsent">) => {
        calls.push("consent");
        // The token binds the previewed payload + the human's verdict.
        expect(input.payload).toBe(PAYLOAD);
        expect(input.verdict).toBe("REQUEST_CHANGES");
        return { authorization: "tok-abc" };
      },
      "publish.review": (input: CommandInput<"publish.review">) => {
        calls.push("review");
        postedPayload = input.payload;
        postedDryRun = input.dryRun;
        postedAuth = input.authorization;
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

    // Nothing has been invoked yet — nothing leaves without the sign-click.
    expect(calls).toEqual([]);

    await r.user.click(r.getByRole("button", { name: /Post Review/ }));

    // The sign-click ran the full egress, in order.
    expect(calls).toEqual(["compose:review", "consent", "review"]);
    // The preview equals what posts: publish.review received the exact bytes compose returned.
    expect(postedPayload).toBe(PAYLOAD);
    // Real egress is the explicit opt-in, carrying the minted token.
    expect(postedDryRun).toBe(false);
    expect(postedAuth).toBe("tok-abc");
    // The receipt names the verdict + line-comment count (one of two comments carries a line) + link.
    expect(await r.findByText(/Review posted to acme\/orbital#7/)).toBeTruthy();
    expect(r.getByText(/Request Changes · 1 line comment · body/)).toBeTruthy();
    expect(r.getByText("github.com/acme/orbital/pull/7#r1")).toBeTruthy();
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
      "publish.requestConsent": () => ({ authorization: "tok-abc" }),
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
