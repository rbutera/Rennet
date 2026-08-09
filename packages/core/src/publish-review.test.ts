import { describe, expect, it } from "vitest";
import type { ForgeCapabilities } from "./forge-port";
import {
  buildForgeReviewPost,
  buildReviewMarker,
  canonicalReviewPayload,
  extractMarker,
  FORGE_REVIEW_EVENT,
  type ForgeReviewTarget,
  forgeTargetKey,
  markerComment,
  type ReviewCommentInput,
} from "./publish-review";

const TARGET: ForgeReviewTarget = {
  ref: { repo: { forge: "github", owner: "rbutera", name: "rennet-egress-sandbox" }, number: 7 },
  forgeRef: "PR_kwABC",
  headOid: "deadbeef0007",
};

const CAPS: ForgeCapabilities = {
  supportsThreadResolution: true,
  supportsBatchedReview: true,
  supportsMultiLineAnchors: true,
  supportsFileLevelThreads: true,
};

describe("canonicalReviewPayload (issue #21) — the egress round-trip bytes", () => {
  it("matches the ui `reviewCommentsPayload` byte-for-byte (pinned exact string)", () => {
    // ⚠️ This EXACT string is the coupling with `packages/ui/src/canvas/publish.ts`
    // `reviewCommentsPayload`. If this pin ever changes, the ui counterpart must
    // change with it, or the egress round-trip refuses every legitimate publish.
    const comments: ReviewCommentInput[] = [
      { path: "src/a.ts", line: 2, side: "RIGHT", type: "request-change", body: "rename" },
      { path: "README.md", side: "RIGHT", type: "comment", body: "note" },
    ];
    expect(canonicalReviewPayload(comments)).toBe(
      '{"kind":"pr-review","comments":[' +
        '{"path":"src/a.ts","line":2,"side":"RIGHT","type":"request-change","body":"rename"},' +
        '{"path":"README.md","line":null,"side":"RIGHT","type":"comment","body":"note"}]}',
    );
  });

  it("serialises a missing line as null (a file-level note)", () => {
    const payload = canonicalReviewPayload([
      { path: "x.ts", side: "RIGHT", type: "comment", body: "b" },
    ]);
    expect(payload).toContain('"line":null');
  });

  it("distinguishes a single-byte body change (so a === check is not a prefix check)", () => {
    const base: ReviewCommentInput[] = [
      { path: "a", line: 1, side: "RIGHT", type: "comment", body: "hello" },
    ];
    const flipped: ReviewCommentInput[] = [
      { path: "a", line: 1, side: "RIGHT", type: "comment", body: "hellp" },
    ];
    expect(canonicalReviewPayload(base)).not.toBe(canonicalReviewPayload(flipped));
  });
});

describe("buildForgeReviewPost (issue #21)", () => {
  const comments: ReviewCommentInput[] = [
    { path: "src/a.ts", line: 5, side: "RIGHT", type: "request-change", body: "rename this" },
    { path: "src/b.ts", line: 9, side: "LEFT", type: "question", body: "why removed?" },
    { path: "README.md", side: "RIGHT", type: "comment", body: "a file-level note" },
  ];
  const payload = canonicalReviewPayload(comments);
  const post = buildForgeReviewPost(comments, {
    reviewId: "rev-1",
    target: TARGET,
    payload,
    capabilities: CAPS,
  });

  it("keeps line-anchored comments as threads and folds no-line ones into the body", () => {
    expect(post.threads).toHaveLength(2);
    expect(post.threads.map((thread) => thread.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(post.threads[1]?.side).toBe("LEFT");
    // The no-line comment folds into the body as a file-level note.
    expect(post.body).toContain("File-level notes");
    expect(post.body).toContain("README.md");
  });

  it("ledgers every fold — a no-line disposition is surfaced, never silently dropped", () => {
    expect(post.ledger).toEqual([
      expect.objectContaining({ kind: "file-level-fold", path: "README.md" }),
    ]);
  });

  it("renders the disposition TYPE into each body (the event stays a neutral comment)", () => {
    expect(post.threads[0]?.body).toContain("Requested change");
    expect(post.threads[1]?.body).toContain("Question");
  });

  it("carries NO event field — there is nothing on a post for an APPROVE to be read from", () => {
    // The event is not post data; it is hardcoded at the wire (see the adapter test
    // "emits COMMENT even when handed a forged APPROVE"). A post has no event field, so
    // even an all-`approve` review has nowhere to carry an APPROVE toward the request.
    expect(FORGE_REVIEW_EVENT).toBe("COMMENT");
    expect("event" in post).toBe(false);
    const approvals = buildForgeReviewPost(
      [{ path: "a.ts", line: 1, side: "RIGHT", type: "approve", body: "lgtm" }],
      { reviewId: "rev-2", target: TARGET, payload: "p", capabilities: CAPS },
    );
    expect("event" in approvals).toBe(false);
  });

  it("embeds the deterministic idempotency marker in the body", () => {
    expect(post.body).toContain(markerComment(post.marker));
    expect(extractMarker(post.body)).toBe(post.marker);
    // Deterministic in (reviewId, target, payload): identical inputs ⇒ identical marker.
    expect(buildReviewMarker("rev-1", TARGET, payload)).toBe(post.marker);
    // A different payload ⇒ a different marker (a retry after an edit is a new review).
    expect(buildReviewMarker("rev-1", TARGET, `${payload} `)).not.toBe(post.marker);
  });
});

describe("forgeTargetKey (issue #21)", () => {
  it("pins the head OID AND the forgeRef so a token cannot cross to a different PR", () => {
    expect(forgeTargetKey(TARGET)).toBe(
      "github/rbutera/rennet-egress-sandbox#7@deadbeef0007:PR_kwABC",
    );
    // A moved head yields a different key (a token cannot cross to a different head).
    const moved: ForgeReviewTarget = { ...TARGET, headOid: "feed0008" };
    expect(forgeTargetKey(moved)).not.toBe(forgeTargetKey(TARGET));
    // A different node id yields a different key too, even with identical coordinates
    // and head: the adapter POSTS by forgeRef, so the binding must include it.
    const otherNode: ForgeReviewTarget = { ...TARGET, forgeRef: "PR_kwDIFFERENT" };
    expect(forgeTargetKey(otherNode)).not.toBe(forgeTargetKey(TARGET));
  });
});
