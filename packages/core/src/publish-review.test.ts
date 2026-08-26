import type { Disposition } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { ForgeCapabilities } from "./forge-port";
import {
  buildForgeReviewPost,
  buildReviewMarker,
  canonicalReviewPayload,
  DEFAULT_REVIEW_EVENT,
  deriveReviewEvent,
  extractMarker,
  type ForgeReviewTarget,
  forgeTargetKey,
  markerComment,
  type ReviewCommentInput,
  reviewCommentsFromDispositions,
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
    // ⚠️ This EXACT string is the coupling with `packages/app-ui/src/canvas/publish.ts`
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

describe("reviewCommentsFromDispositions (issue #382 M2) — the daemon's one-source review compose", () => {
  const disp = (
    path: string,
    type: Disposition["type"],
    body: string,
    span?: { startLine: number; side: "additions" | "deletions" | "context" },
  ): Disposition => ({
    anchor: {
      path,
      contentDigest: "d",
      ...(span ? { span: { startLine: span.startLine }, side: span.side, spanDigest: "s" } : {}),
    },
    type,
    body,
  });

  it("maps each disposition to one comment: span→line+side, path-grained→file-level", () => {
    const comments = reviewCommentsFromDispositions([
      disp("src/a.ts", "comment", "note", { startLine: 12, side: "additions" }),
      disp("src/a.ts", "request-change", "deleted here", { startLine: 3, side: "deletions" }),
      disp("README.md", "approve", "file-level ok"),
    ]);
    // Ordered path-then-line: README before src/a.ts; within src/a.ts line 3 before line 12.
    expect(comments).toEqual([
      { path: "README.md", side: "RIGHT", type: "approve", body: "file-level ok" },
      { path: "src/a.ts", line: 3, side: "LEFT", type: "request-change", body: "deleted here" },
      { path: "src/a.ts", line: 12, side: "RIGHT", type: "comment", body: "note" },
    ]);
  });

  it("its payload round-trips through canonicalReviewPayload byte-exact (preview == post)", () => {
    const dispositions = [
      disp("src/a.ts", "comment", "note", { startLine: 12, side: "context" }),
      disp("README.md", "question", "why?"),
    ];
    const comments = reviewCommentsFromDispositions(dispositions);
    // The bytes the phone previews are the bytes publish.review re-verifies.
    expect(() => JSON.parse(canonicalReviewPayload(comments))).not.toThrow();
    expect(deriveReviewEvent(comments)).toBe("COMMENT");
  });

  it("verdict derives from disposition types (a request-change escalates the whole review)", () => {
    const comments = reviewCommentsFromDispositions([
      disp("a", "approve", "ok"),
      disp("b", "request-change", "no"),
    ]);
    expect(deriveReviewEvent(comments)).toBe("REQUEST_CHANGES");
  });

  it("empty dispositions compose an empty (honest) review, not a throw", () => {
    expect(reviewCommentsFromDispositions([])).toEqual([]);
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

  it("resolves the verdict: derived from the dispositions, an explicit verdict wins", () => {
    expect(DEFAULT_REVIEW_EVENT).toBe("COMMENT");
    // The describe's comments include a request-change ⇒ the whole review is a change request.
    expect(post.event).toBe("REQUEST_CHANGES");
    // Derivation rules.
    const at = (type: ReviewCommentInput["type"]): ReviewCommentInput[] => [
      { path: "a.ts", line: 1, side: "RIGHT", type, body: "x" },
    ];
    expect(deriveReviewEvent(at("approve"))).toBe("APPROVE");
    expect(deriveReviewEvent(at("comment"))).toBe("COMMENT");
    expect(deriveReviewEvent(at("question"))).toBe("COMMENT");
    // A requested change dominates approvals.
    expect(
      deriveReviewEvent([
        { path: "a.ts", line: 1, side: "RIGHT", type: "approve", body: "x" },
        { path: "b.ts", line: 2, side: "RIGHT", type: "request-change", body: "y" },
      ]),
    ).toBe("REQUEST_CHANGES");
    // An explicit verdict OVERRIDES the derived one.
    const overridden = buildForgeReviewPost(at("comment"), {
      reviewId: "rev-3",
      target: TARGET,
      payload: "p",
      capabilities: CAPS,
      verdict: "APPROVE",
    });
    expect(overridden.event).toBe("APPROVE");
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
