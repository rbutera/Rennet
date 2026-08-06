import type { Disposition, PatchFile, Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { fileContentDigest, foldReview, payloadDigest, type ReviewEvent } from "./index";

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false, patch };
}

function patchsetOf(id: string, files: PatchFile[]): Patchset {
  return {
    id,
    createdAt: "2026-08-06T00:00:00.000Z",
    repository,
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

const emptyPatchset = patchsetOf("patch-1", []);

function created(patchset: Patchset): Review {
  return foldReview(null, { type: "ReviewCreated", version: 1, reviewId: "review", patchset });
}

function withDisposition(
  review: Review,
  path: string,
  patch: string,
  type: Disposition["type"],
): Review {
  const disposition: Disposition = {
    anchor: { path, contentDigest: fileContentDigest(file(path, patch)) },
    type,
    body: "",
  };
  return foldReview(review, {
    type: "DispositionSet",
    version: 1,
    reviewId: review.id,
    patchsetId: review.activePatchsetId,
    disposition,
  });
}

describe("review fold", () => {
  it("starts a fresh review with no dispositions", () => {
    expect(created(emptyPatchset).dispositions).toEqual([]);
  });

  it("records a disposition against the active patchset, keyed by path", () => {
    const review = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X")])),
      "a.ts",
      "X",
      "approve",
    );
    expect(review.dispositions).toHaveLength(1);
    expect(review.dispositions[0]?.anchor.path).toBe("a.ts");
    expect(review.dispositions[0]?.type).toBe("approve");
  });

  it("replaces an existing disposition on the same path rather than duplicating it", () => {
    const one = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X")])),
      "a.ts",
      "X",
      "approve",
    );
    const two = withDisposition(one, "a.ts", "X", "request-change");
    expect(two.dispositions).toHaveLength(1);
    expect(two.dispositions[0]?.type).toBe("request-change");
  });

  it("clears a disposition on mark-unread", () => {
    const review = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X")])),
      "a.ts",
      "X",
      "comment",
    );
    const cleared = foldReview(review, {
      type: "DispositionCleared",
      version: 1,
      reviewId: review.id,
      patchsetId: review.activePatchsetId,
      path: "a.ts",
    });
    expect(cleared.dispositions).toEqual([]);
  });

  it("carries a disposition across a new patchset when its anchor is byte-identical", () => {
    const review = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X"), file("b.ts", "Y")])),
      "a.ts",
      "X",
      "approve",
    );
    // a.ts is byte-identical in the new patchset; b.ts changed.
    const activated = foldReview(review, {
      type: "PatchsetActivated",
      version: 1,
      reviewId: review.id,
      patchset: patchsetOf("patch-2", [file("a.ts", "X"), file("b.ts", "Y-CHANGED")]),
    });
    expect(activated.dispositions.map((disposition) => disposition.anchor.path)).toEqual(["a.ts"]);
  });

  it("fails closed: drops a disposition whose anchor content changed", () => {
    const review = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X")])),
      "a.ts",
      "X",
      "approve",
    );
    const activated = foldReview(review, {
      type: "PatchsetActivated",
      version: 1,
      reviewId: review.id,
      patchset: patchsetOf("patch-2", [file("a.ts", "X-CHANGED")]),
    });
    expect(activated.dispositions).toEqual([]);
  });

  it("fails closed: drops a disposition whose file was removed from the changeset", () => {
    const review = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X")])),
      "a.ts",
      "X",
      "approve",
    );
    const activated = foldReview(review, {
      type: "PatchsetActivated",
      version: 1,
      reviewId: review.id,
      patchset: patchsetOf("patch-2", [file("b.ts", "Z")]),
    });
    expect(activated.dispositions).toEqual([]);
  });

  it("does not blanket-wipe dispositions on re-capture (the killed MVP behaviour)", () => {
    const review = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X"), file("b.ts", "Y")])),
      "a.ts",
      "X",
      "approve",
    );
    // Both files unchanged: both dispositions must survive, not be wiped to [].
    const twice = withDisposition(review, "b.ts", "Y", "comment");
    const activated = foldReview(twice, {
      type: "PatchsetActivated",
      version: 1,
      reviewId: review.id,
      patchset: patchsetOf("patch-2", [file("a.ts", "X"), file("b.ts", "Y")]),
    });
    expect(activated.dispositions).toHaveLength(2);
  });

  it("preserves the visible patchset and dispositions when a review is invalidated", () => {
    const review = withDisposition(
      created(patchsetOf("patch-1", [file("a.ts", "X")])),
      "a.ts",
      "X",
      "approve",
    );
    const invalid = foldReview(review, {
      type: "ReviewInvalidated",
      version: 1,
      reviewId: review.id,
      candidate: patchsetOf("patch-2", [file("a.ts", "X-CHANGED")]),
    });
    expect(invalid.activePatchsetId).toBe("patch-1");
    expect(invalid.pendingPatchsetId).toBe("patch-2");
    expect(invalid.status).toBe("invalid");
    expect(invalid.dispositions).toHaveLength(1);
  });

  it("rejects a disposition that does not target the active patchset", () => {
    const review = created(patchsetOf("patch-1", [file("a.ts", "X")]));
    expect(() =>
      foldReview(review, {
        type: "DispositionSet",
        version: 1,
        reviewId: review.id,
        patchsetId: "patch-stale",
        disposition: { anchor: { path: "a.ts", contentDigest: "d" }, type: "approve", body: "" },
      }),
    ).toThrow("active patchset");
  });

  it("fails closed on an unknown event", () => {
    expect(() => foldReview(null, { type: "FutureEvent" } as unknown as ReviewEvent)).toThrow(
      "Unknown review event",
    );
  });

  it("creates stable payload digests independent of key order", () => {
    expect(payloadDigest({ b: 2, a: 1 })).toBe(payloadDigest({ a: 1, b: 2 }));
  });
});
