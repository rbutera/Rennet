import { describe, expect, it } from "vitest";
import type { CollationDraft } from "./collation";
import {
  composePrSubmission,
  composePrSubmissionBody,
  type LineAnchors,
  type PublishContext,
  prSubmissionPayload,
  publishTarget,
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
