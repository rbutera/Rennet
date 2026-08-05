import type { Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { foldReview, payloadDigest, type ReviewEvent } from "./index";

const patchset: Patchset = {
  id: "patch-1",
  createdAt: "2026-08-05T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "main",
    baseOid: "base",
    headOid: "head",
  },
  files: [],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

describe("review fold", () => {
  it("preserves the visible patchset when a review is invalidated", () => {
    const created = foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "review",
      patchset,
    });
    const next = { ...patchset, id: "patch-2" };
    const invalid = foldReview(created, {
      type: "ReviewInvalidated",
      version: 1,
      reviewId: "review",
      candidate: next,
    });

    expect(invalid.activePatchsetId).toBe("patch-1");
    expect(invalid.pendingPatchsetId).toBe("patch-2");
    expect(invalid.status).toBe("invalid");
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

export type _ReviewTypeCheck = Review;
