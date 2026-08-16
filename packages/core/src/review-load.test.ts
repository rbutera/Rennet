import type { PatchFile, Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { foldReview, type PatchsetCapturePort, ReviewService, type ReviewStorePort } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// ReviewService.reviewById — the pure by-id read behind review.load (#324).
// The store already resolves any review by id; this exposes that read publicly so
// dispatch can reopen a persisted review that is NOT the globally-latest one,
// without asserting it equals the latest (the old requireLatestReview pin).
// ─────────────────────────────────────────────────────────────────────────────

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

function addedFile(path: string): PatchFile {
  return {
    path,
    status: "added",
    additions: 1,
    deletions: 0,
    binary: false,
    patch: "@@ -0,0 +1,1 @@\n+const reviewed = true;",
  };
}

function patchsetOf(id: string): Patchset {
  return {
    id,
    createdAt: "2026-08-11T00:00:00.000Z",
    repository,
    files: [addedFile("src/a.ts")],
    rawDiff: "+const reviewed = true;",
    byteLength: 0,
    truncated: false,
  };
}

function reviewOf(id: string): Review {
  return foldReview(null, {
    type: "ReviewCreated",
    version: 1,
    reviewId: id,
    patchset: patchsetOf(`ps-${id}`),
  });
}

/** A many-review in-memory store keyed by id, latest = last inserted. */
function storeOf(reviews: Review[]): ReviewStorePort {
  const byId = new Map(reviews.map((review) => [review.id, review]));
  return {
    latestReview: () => reviews[reviews.length - 1] ?? null,
    reviewById: (id) => byId.get(id) ?? null,
    receipt: () => null,
    commit: (_c, _d, _e, result) => result,
  };
}

const noCapture: PatchsetCapturePort = {
  capture: () => {
    throw new Error("capture is not used in this test");
  },
};

describe("ReviewService.reviewById (#324)", () => {
  it("returns a persisted review by id even when a newer review exists", () => {
    const older = reviewOf("review-old");
    const newer = reviewOf("review-new");
    const service = new ReviewService(noCapture, storeOf([older, newer]));
    expect(service.bootstrap()?.id).toBe("review-new");
    expect(service.reviewById("review-old")?.id).toBe("review-old");
  });

  it("returns null for an unknown id", () => {
    const service = new ReviewService(noCapture, storeOf([reviewOf("review-1")]));
    expect(service.reviewById("nope")).toBeNull();
  });
});
