// @vitest-environment happy-dom
//
// THE REAL-POST FLIP (issue #21) and its ONE invariant: a review reaches GitHub
// ONLY on a human's completed hold-to-sign, and never any other way.
//
// This mounts the whole `RennetApp` over a recording bridge, opens a review that
// carries a real PR `postTarget` (the coordinates `review.openPr` stamps on a real
// pull request), stages a comment, and drives the actual sign gesture. It asserts:
//   (a) a COMPLETED sign mints the single-use consent token (bound to the exact
//       target+payload) and posts for REAL (`dryRun:false`, carrying that token);
//   (b) NO post — and NO consent minted — without a completed sign (no sign at all;
//       a partial pointer hold below the budget);
//   (c) the POSTED bytes equal the PREVIEWED bytes (the `<pre>` the human read);
//   (d) a LOCAL review (no `postTarget`) signs a DRY RUN and mints no token — it has
//       no PR to post to;
//   (e) a failed GitHub post surfaces the error, never a silent success.
//
// The consent token is minted in exactly one place in `app.tsx` — inside the sign
// handler — so these renderer-level proofs, together with `dispatch.test.ts`'s
// main-side gate proofs (no-token / wrong-payload / wrong-node / single-use /
// retrospective refusals), pin the whole "only a human sign posts" circuit.
import type { CommandInput, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { Review, ReviewPostTarget } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor } from "./test/dom";

const POST_TARGET: ReviewPostTarget = {
  repo: { forge: "github", owner: "rbutera", name: "rennet" },
  number: 7,
  forgeRef: "PR_kwREAL7",
  headOid: "2222222222222222",
};

/** A ready review with one changed file. `postTarget` present ⇒ a real PR review. */
function reviewWith(postTarget?: ReviewPostTarget): Review {
  return {
    id: "review",
    repositoryRoot: "/code/rennet",
    activePatchsetId: "patch-one",
    dispositions: [],
    status: "current",
    ...(postTarget ? { postTarget } : {}),
    patchsets: [
      {
        id: "patch-one",
        createdAt: "2026-08-11T00:00:00.000Z",
        repository: {
          id: "repository",
          root: "/code/rennet",
          commonDir: "/code/rennet/.git",
          baseRef: "main",
          baseOid: "1111111111111111",
          headOid: "2222222222222222",
        },
        files: [
          {
            path: "src/x.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            binary: false,
            patch: "+const reviewed = true;",
          },
        ],
        rawDiff: "+const reviewed = true;",
        byteLength: 24,
        truncated: false,
      },
    ],
  };
}

interface Recorder {
  bridge: RennetBridge;
  consentCalls: CommandInput<"publish.requestConsent">[];
  publishCalls: CommandInput<"publish.review">[];
  realPosts: () => CommandInput<"publish.review">[];
}

// A recording bridge modelling MAIN honestly enough to prove the renderer contract:
// `publish.requestConsent` mints a fresh token; `publish.review` records its input and
// returns a real outcome for `dryRun:false`, a dry-run outcome otherwise. `failPost`
// makes a REAL post throw (a GitHub auth/network error) so the honest-failure path shows.
function recordingBridge(ready: Review, opts: { failPost?: boolean } = {}): Recorder {
  const consentCalls: CommandInput<"publish.requestConsent">[] = [];
  const publishCalls: CommandInput<"publish.review">[] = [];
  let minted = 0;
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "publish.requestConsent") {
      consentCalls.push(input as CommandInput<"publish.requestConsent">);
      minted += 1;
      const out: CommandOutput<"publish.requestConsent"> = { authorization: `token-${minted}` };
      return out;
    }
    if (name === "publish.review") {
      const call = input as CommandInput<"publish.review">;
      publishCalls.push(call);
      const real = call.dryRun === false;
      if (real && opts.failPost) {
        throw new Error("GitHub post failed: Bad credentials (401)");
      }
      const out: CommandOutput<"publish.review"> = {
        dryRun: !real,
        request: {
          endpoint: "https://api.github.com/graphql",
          method: "POST",
          body: { query: "mutation {}", variables: {} },
        },
        marker: "a".repeat(64),
        ledger: [],
        outcome: real
          ? { reviewRef: "PRR_1", url: "https://github.com/rbutera/rennet/pull/7", reused: false }
          : null,
      };
      return out;
    }
    return { review: ready };
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
    consentCalls,
    publishCalls,
    realPosts: () => publishCalls.filter((call) => call.dryRun === false),
  };
}

// Mount, mark the one file read, select other-pr framing (the post act), open the
// draft canvas, stage the comment (blue → ink), then freeze the paper. Returns the
// handle + recorders. The review is a parameter so the local-vs-PR cases share it.
async function reachPaper(
  ready: Review,
  opts: { failPost?: boolean } = {},
): Promise<ReturnType<typeof mount> & Recorder> {
  const rec = recordingBridge(ready, opts);
  const handle = mount(<RennetApp bridge={rec.bridge} />);
  const { container, getByRole } = handle;
  await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
  fireEvent.click(getByRole("tab", { name: "Files" }));
  fireEvent.click(getByRole("button", { name: "Mark read" }));
  await waitFor(() =>
    expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
      "1",
    ),
  );
  fireEvent.click(getByRole("tab", { name: "Review to post" }));
  await waitFor(() =>
    expect(container.querySelector(".destination-frame")?.getAttribute("data-mode")).toBe(
      "other-pr",
    ),
  );
  const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
  if (!openDraft) throw new Error("the open-draft control did not render");
  fireEvent.click(openDraft);
  await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());
  // Stage the Mark-read comment (blue → ink) so there is a non-empty payload to sign.
  const box = container.querySelector<HTMLInputElement>(".collation-item-stage-box");
  if (!box) throw new Error("the stage toggle did not render");
  fireEvent.click(box);
  await waitFor(() =>
    expect(container.querySelector(".collation-item")?.getAttribute("data-lane")).toBe("ink"),
  );
  const signDraft = container.querySelector<HTMLButtonElement>(".collation-sign");
  if (!signDraft) throw new Error("the draft sign control did not render");
  fireEvent.click(signDraft);
  await waitFor(() => expect(container.querySelector(".publish-sheet")).not.toBeNull());
  return { ...handle, ...rec };
}

const previewBytes = (container: HTMLElement) =>
  container.querySelector('[data-testid="publish-preview"]')?.textContent ?? "";
const signButton = (container: HTMLElement) => {
  const sign = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
  if (!sign) throw new Error("the paper sign control did not render");
  return sign;
};
/**
 * A completed hold-to-sign (issue #21): a single keypress no longer signs — the sign
 * is a real GitHub egress, so it takes a deliberate HOLD. Real timers here, so hold
 * past the 800ms budget in wall-clock time.
 */
async function completeSign(container: HTMLElement): Promise<void> {
  const sign = signButton(container);
  fireEvent.mouseDown(sign);
  await new Promise((resolve) => setTimeout(resolve, 850));
  fireEvent.mouseUp(sign);
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("real-post flip (issue #21) — a completed sign posts a real PR review", () => {
  it("(a,c) mints a bound consent token then posts for REAL, with the previewed bytes", async () => {
    const { container, consentCalls, realPosts } = await reachPaper(reviewWith(POST_TARGET));

    // Before signing the paper states honestly that signing WILL post (not a dry run).
    const notice = container.querySelector('[data-testid="will-post-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("rbutera/rennet#7");
    const preview = previewBytes(container);
    expect(preview).toContain("pr-review");

    await completeSign(container);
    await waitFor(() => expect(realPosts()).toHaveLength(1));

    // The consent token was minted exactly once, bound to the real target + the
    // previewed bytes — never autonomously, only as part of this sign.
    expect(consentCalls).toHaveLength(1);
    expect(consentCalls[0]?.target).toEqual(POST_TARGET);
    expect(consentCalls[0]?.payload).toBe(preview);
    // The verdict is bound into the token too (one comment ⇒ COMMENT), so it cannot be
    // swapped after approval.
    expect(consentCalls[0]?.verdict).toBe("COMMENT");

    // The real post carries that token, the real target, and byte-for-byte the
    // previewed payload — "what you see is what leaves".
    const post = realPosts()[0];
    if (!post) throw new Error("no real post recorded");
    expect(post.dryRun).toBe(false);
    expect(post.authorization).toBe("token-1");
    expect(post.target).toEqual(POST_TARGET);
    expect(post.payload).toBe(preview);
    expect(post.verdict).toBe("COMMENT");

    // The paper reports a real post, not a dry run.
    const result = container.querySelector('[data-testid="publish-result"]');
    expect(result?.getAttribute("data-dry-run")).toBe("false");
    expect(result?.textContent).toContain("Posted");
    expect(result?.textContent).toContain("rbutera/rennet#7");
  });

  it("(b) no post — and no consent minted — until the sign is completed", async () => {
    const { container, consentCalls, realPosts } = await reachPaper(reviewWith(POST_TARGET));
    // The paper is open and armed to post, but nothing has been signed.
    expect(signButton(container).disabled).toBe(false);
    await flush();
    expect(consentCalls).toHaveLength(0);
    expect(realPosts()).toHaveLength(0);
  });

  it("(b) a PARTIAL pointer hold below the budget posts nothing and mints no token", async () => {
    const { container, consentCalls, publishCalls } = await reachPaper(reviewWith(POST_TARGET));
    const sign = signButton(container);
    // Press and release immediately: the elapsed hold (~0ms) is far below the 800ms
    // budget, so `resolveSign` returns null and the sign never fires.
    fireEvent.mouseDown(sign);
    fireEvent.mouseUp(sign);
    await flush();
    expect(consentCalls).toHaveLength(0);
    expect(publishCalls).toHaveLength(0);
  });

  it("(d) a LOCAL review (no postTarget) signs a DRY RUN and mints no consent token", async () => {
    const { container, consentCalls, publishCalls, realPosts } = await reachPaper(reviewWith());
    // The honest local-capture notice, NOT the will-post notice.
    expect(container.querySelector('[data-testid="will-post-notice"]')).toBeNull();

    await completeSign(container);
    await waitFor(() => expect(publishCalls).toHaveLength(1));
    expect(consentCalls).toHaveLength(0); // never mint a token with no PR to post to
    expect(realPosts()).toHaveLength(0); // dry run only
    expect(publishCalls[0]?.dryRun).not.toBe(false);
    const result = container.querySelector('[data-testid="publish-result"]');
    expect(result?.getAttribute("data-dry-run")).toBe("true");
    expect(result?.textContent).toContain("Dry run");
  });

  it("(e) a failed GitHub post surfaces the error — never a silent success", async () => {
    const { container, realPosts } = await reachPaper(reviewWith(POST_TARGET), { failPost: true });
    await completeSign(container);
    await waitFor(() => expect(realPosts()).toHaveLength(1)); // the attempt was made
    // The error is shown; the paper never claims a post landed.
    await waitFor(() => expect(container.querySelector(".error-toast")).not.toBeNull());
    expect(container.querySelector(".error-toast")?.textContent).toContain("GitHub post failed");
    const result = container.querySelector('[data-testid="publish-result"]');
    expect(result?.textContent ?? "").not.toContain("Posted");
  });
});
