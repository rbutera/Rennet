import { describe, expect, it } from "vitest";
import type { CollationDraft } from "./collation";
import {
  composePrSubmission,
  composePrSubmissionBody,
  deriveReviewEvent,
  type LineAnchors,
  type PublishContext,
  previewPublishTarget,
  previewTargetLabel,
  prSubmissionPayload,
  publishTarget,
  publishTargetAgrees,
  publishTargetPayload,
  refinedCount,
  reviewComments,
  reviewCommentsPayload,
  targetItemCount,
} from "./publish";

// A single review state (one collation draft), the source BOTH variants derive
// from. Draft order is significant: it is the output order.
const draft: CollationDraft = [
  { id: "src/beta.ts", path: "src/beta.ts", type: "request-change", raw: 'rename "x" to "y"' },
  { id: "src/alpha.ts", path: "src/alpha.ts", type: "approve", raw: "looks right" },
  { id: "src/gamma.ts", path: "src/gamma.ts", type: "comment", raw: "" },
];

const context: PublishContext = {
  submission: { base: "main", head: "feat/publish-sheet", draftDefault: true },
};

describe("own-branch: the PR submission preview", () => {
  it("composes the body from the draft, grouped by type, requested-changes first", () => {
    const body = composePrSubmissionBody(draft);
    // Grouped and ordered: request-change before comment before approve.
    expect(body.indexOf("Requested changes")).toBeLessThan(body.indexOf("Comments"));
    expect(body.indexOf("Comments")).toBeLessThan(body.indexOf("Approvals"));
    // The effective body lands next to its path; an empty body is a bare bullet.
    expect(body).toContain('- `src/beta.ts` — rename "x" to "y"');
    expect(body).toContain("- `src/gamma.ts`");
    expect(body).not.toContain("gamma.ts` —");
  });

  it("derives the title from the head branch when no override is given", () => {
    // If `titleFromHead` were dropped and title defaulted to "" or head verbatim,
    // this reddens.
    expect(composePrSubmission(draft, context.submission).title).toBe("Publish sheet");
  });

  it("uses an explicit title override when present", () => {
    const submission = composePrSubmission(draft, { ...context.submission, title: "Ship it" });
    expect(submission.title).toBe("Ship it");
  });

  it("uses the drafted body override (M26) in place of the composed grouping", () => {
    // The own-branch composer's drafted-then-edited body REPLACES the deterministic
    // disposition grouping — this is the whole #74 feature. Dropping the override
    // wiring in `composePrSubmission` reddens this.
    const drafted = "## What\nBounds the fail-open path with a local bucket (decision 2).";
    const submission = composePrSubmission(draft, { ...context.submission, body: drafted });
    expect(submission.body).toBe(drafted);
    // The composed grouping did NOT leak through alongside the override.
    expect(submission.body).not.toContain("Requested changes");
  });

  it("falls back to the composed body when the override is empty/whitespace (never a blank preview)", () => {
    const submission = composePrSubmission(draft, { ...context.submission, body: "   " });
    // An empty override must not blank the preview — the deterministic grouping stands.
    expect(submission.body).toContain("Requested changes");
  });

  it("carries base, head, and the draft default verbatim", () => {
    const submission = composePrSubmission(draft, context.submission);
    expect(submission.base).toBe("main");
    expect(submission.head).toBe("feat/publish-sheet");
    expect(submission.draft).toBe(true);
  });

  it("ZERO mutation: composing a submission never mutates the draft or context (frozen inputs)", () => {
    // The own-branch publish path is PURE — no Git, no GitHub, no I/O. Freezing the
    // inputs proves the composition writes nothing back: a stray `draft.push`,
    // `item.raw = …`, or `context.base = …` would throw on a frozen object → red.
    const frozenDraft = Object.freeze(draft.map((item) => Object.freeze({ ...item })));
    const frozenContext = Object.freeze({ ...context.submission });
    const before = JSON.stringify(frozenDraft);
    expect(() => composePrSubmission(frozenDraft as CollationDraft, frozenContext)).not.toThrow();
    // And the value is unchanged: no in-place edit slipped through under the freeze.
    expect(JSON.stringify(frozenDraft)).toBe(before);
  });

  it("payload is stable field-ordered bytes that round-trip to the submission", () => {
    const submission = composePrSubmission(draft, context.submission);
    const bytes = prSubmissionPayload(submission);
    const parsed = JSON.parse(bytes);
    expect(parsed.kind).toBe("pr-submission");
    expect(parsed.title).toBe(submission.title);
    expect(parsed.base).toBe("main");
    expect(parsed.head).toBe("feat/publish-sheet");
    expect(parsed.draft).toBe(true);
    // Field order is explicit, not object-key order: title before body before base.
    expect(bytes.indexOf('"title"')).toBeLessThan(bytes.indexOf('"body"'));
    expect(bytes.indexOf('"body"')).toBeLessThan(bytes.indexOf('"base"'));
  });
});

describe("other-pr: the line-anchored review comments", () => {
  const anchors: LineAnchors = {
    "src/beta.ts": { line: 42, side: "RIGHT" },
    "src/alpha.ts": { line: 7, side: "LEFT" },
  };

  it("derives one comment per draft item, IN DRAFT ORDER", () => {
    const comments = reviewComments(draft, anchors);
    expect(comments.map((comment) => comment.path)).toEqual([
      "src/beta.ts",
      "src/alpha.ts",
      "src/gamma.ts",
    ]);
  });

  it("line-anchors from the #78 span payload; a disposition with no anchor posts file-level", () => {
    const comments = reviewComments(draft, anchors);
    // Anchored: carries the line + side from the anchor map.
    expect(comments[0]).toMatchObject({ path: "src/beta.ts", line: 42, side: "RIGHT" });
    expect(comments[1]).toMatchObject({ path: "src/alpha.ts", line: 7, side: "LEFT" });
    // Unanchored: no line (file-level), side defaults to RIGHT. If `reviewComments`
    // invented a line for the unanchored item, `toBeUndefined` reddens.
    expect(comments[2]?.line).toBeUndefined();
    expect(comments[2]?.side).toBe("RIGHT");
  });

  it("marks each comment refined-or-raw from the item's refined form (#19 seam)", () => {
    const withRefined: CollationDraft = [
      { id: "a", path: "a", type: "comment", raw: "raw", refined: "cleaned" },
      { id: "b", path: "b", type: "comment", raw: "raw only" },
    ];
    const comments = reviewComments(withRefined);
    // The refined body is effective and flagged refined; the raw-only is flagged raw.
    expect(comments[0]).toMatchObject({ body: "cleaned", refined: true });
    expect(comments[1]).toMatchObject({ body: "raw only", refined: false });
    expect(refinedCount(comments)).toBe(1);
  });

  it("payload carries line as null when file-level, and preserves order", () => {
    const bytes = reviewCommentsPayload(reviewComments(draft, anchors));
    const parsed = JSON.parse(bytes);
    expect(parsed.kind).toBe("pr-review");
    expect(parsed.comments[0]).toMatchObject({ path: "src/beta.ts", line: 42, side: "RIGHT" });
    // File-level → line is explicitly null (not omitted), so the wire shape is total.
    expect(parsed.comments[2]).toMatchObject({ path: "src/gamma.ts", line: null });
  });
});

describe("one review state, two variants — the target", () => {
  it("own-branch yields a submission; other-pr yields comments, from the SAME draft", () => {
    const own = publishTarget("own-branch", draft, context);
    const other = publishTarget("other-pr", draft, context);
    expect(own.mode).toBe("own-branch");
    expect(other.mode).toBe("other-pr");
    if (own.mode !== "own-branch" || other.mode !== "other-pr") throw new Error("variant mismatch");
    expect(own.submission.head).toBe("feat/publish-sheet");
    expect(other.comments).toHaveLength(3);
  });

  it("payload matches the variant-specific canonical bytes (what the sheet signs)", () => {
    const own = publishTarget("own-branch", draft, context);
    const other = publishTarget("other-pr", draft, context);
    if (own.mode !== "own-branch" || other.mode !== "other-pr") throw new Error("variant mismatch");
    // The two variants serialise DIFFERENTLY — the outbound artifacts differ.
    expect(publishTargetPayload(own)).toBe(prSubmissionPayload(own.submission));
    expect(publishTargetPayload(other)).toBe(reviewCommentsPayload(other.comments));
    expect(publishTargetPayload(own)).not.toBe(publishTargetPayload(other));
  });

  it("targetItemCount reflects the outbound count for each variant", () => {
    expect(targetItemCount(publishTarget("other-pr", draft, context))).toBe(3);
    expect(targetItemCount(publishTarget("own-branch", draft, context))).toBe(1);
    // An empty draft → an own-branch submission with an empty body → count 0.
    expect(targetItemCount(publishTarget("own-branch", [], context))).toBe(0);
    expect(targetItemCount(publishTarget("other-pr", [], context))).toBe(0);
  });
});

describe("publishTargetAgrees — the #106 fail-closed check (what you see is what leaves)", () => {
  it("agrees when both the bytes and the variant mode match the target", () => {
    const own = publishTarget("own-branch", draft, context);
    const other = publishTarget("other-pr", draft, context);
    expect(publishTargetAgrees(own, publishTargetPayload(own), "own-branch")).toBe(true);
    expect(publishTargetAgrees(other, publishTargetPayload(other), "other-pr")).toBe(true);
  });

  it("DISAGREES when the payload differs from the target's canonical bytes", () => {
    const own = publishTarget("own-branch", draft, context);
    // A payload that is NOT publishTargetPayload(own): the card says one thing, the
    // signed bytes another. Fail closed.
    expect(publishTargetAgrees(own, "TAMPERED::not-the-target-bytes", "own-branch")).toBe(false);
    // A payload from the OTHER variant is also a disagreement, even though it is a
    // real canonical payload — it is not THIS target's.
    const other = publishTarget("other-pr", draft, context);
    expect(publishTargetAgrees(own, publishTargetPayload(other), "own-branch")).toBe(false);
  });

  it("requires EXACT bytes: a near-match payload (trailing byte, truncation, single-byte flip) DISAGREES", () => {
    const own = publishTarget("own-branch", draft, context);
    const canonical = publishTargetPayload(own);
    // Guards the strict `===` against a SUFFIX-tolerant regression (e.g. a
    // `canonical.startsWith(payload)` compare): one extra trailing byte is a
    // different artifact, so it must still fail closed.
    expect(publishTargetAgrees(own, `${canonical}\n`, "own-branch")).toBe(false);
    // Guards against a PREFIX-tolerant regression (e.g. `payload.startsWith(canonical)`
    // or a `.includes(...)`): dropping the final byte is a different artifact even
    // though it is a prefix of the canonical bytes.
    expect(publishTargetAgrees(own, canonical.slice(0, -1), "own-branch")).toBe(false);
    // Guards against a substring/loose compare: a single-byte substitution at the
    // end (same length, one byte different) is a different artifact.
    const flipped = `${canonical.slice(0, -1)}${canonical.at(-1) === "X" ? "Y" : "X"}`;
    expect(flipped).not.toBe(canonical);
    expect(publishTargetAgrees(own, flipped, "own-branch")).toBe(false);
  });

  it("DISAGREES when the variant mode does not match the target's mode", () => {
    const own = publishTarget("own-branch", draft, context);
    // Right bytes, wrong frame: the sheet is labelled other-pr while rendering an
    // own-branch target. Fail closed.
    expect(publishTargetAgrees(own, publishTargetPayload(own), "other-pr")).toBe(false);
  });
});

describe("the review verdict twin (deriveReviewEvent) — mirrors @rennet/core", () => {
  it("escalates to REQUEST_CHANGES when any comment requests a change", () => {
    const comments = reviewComments([
      { id: "a", path: "a.ts", type: "approve", raw: "" },
      { id: "b", path: "b.ts", type: "request-change", raw: "" },
    ]);
    expect(deriveReviewEvent(comments)).toBe("REQUEST_CHANGES");
  });

  it("resolves APPROVE when there are approvals and nothing was requested-changed", () => {
    const comments = reviewComments([
      { id: "a", path: "a.ts", type: "approve", raw: "" },
      { id: "c", path: "c.ts", type: "comment", raw: "" },
      { id: "q", path: "q.ts", type: "question", raw: "" },
    ]);
    expect(deriveReviewEvent(comments)).toBe("APPROVE");
  });

  it("stays a neutral COMMENT for questions and plain comments alone", () => {
    const comments = reviewComments([
      { id: "c", path: "c.ts", type: "comment", raw: "" },
      { id: "q", path: "q.ts", type: "question", raw: "" },
    ]);
    expect(deriveReviewEvent(comments)).toBe("COMMENT");
    // An empty review has no verdict-bearing comment; neutral COMMENT.
    expect(deriveReviewEvent([])).toBe("COMMENT");
  });
});

describe("the local-preview publish target", () => {
  it("carries the REAL reviewed head with labelled placeholder coordinates", () => {
    const target = previewPublishTarget({
      id: "repository",
      root: "/home/rai/dev/rennet",
      commonDir: "/home/rai/dev/rennet/.git",
      baseRef: "main",
      baseOid: "1111111111111111",
      headOid: "abcdef1234567890",
    });
    // The head is real (the reviewed commit); the rest is a labelled local preview.
    expect(target.headOid).toBe("abcdef1234567890");
    expect(target.repo).toEqual({ forge: "github", owner: "local", name: "rennet" });
    // Placeholder coordinates still satisfy the protocol schema (number >= 1, non-empty).
    expect(target.number).toBeGreaterThanOrEqual(1);
    expect(target.forgeRef.length).toBeGreaterThan(0);
    expect(previewTargetLabel(target)).toBe("local/rennet#1");
  });

  it("falls back to a stable name when the repo root has no basename", () => {
    const target = previewPublishTarget({
      id: "repository",
      root: "/",
      commonDir: "/.git",
      baseRef: "main",
      baseOid: "1",
      headOid: "2",
    });
    expect(target.repo.name).toBe("repository");
  });
});
