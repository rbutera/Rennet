import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldReview, ReviewService } from "@rennet/core";
import type { PatchFile, Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { SqliteReviewStore } from "./sqlite-review-store";

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false, patch };
}

const patchset: Patchset = {
  id: "patch",
  createdAt: "2026-08-05T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "main",
    baseOid: "base",
    headOid: "head",
  },
  files: [file("file.ts", "+base")],
  rawDiff: "+base",
  byteLength: 5,
  truncated: false,
};

const review: Review = {
  id: "review",
  repositoryRoot: "/repo",
  patchsets: [patchset],
  activePatchsetId: patchset.id,
  dispositions: [],
  status: "current",
};

describe("SqliteReviewStore", () => {
  it("persists events and replays the latest review", () => {
    const store = new SqliteReviewStore(":memory:");
    store.commit(
      "11111111-1111-4111-8111-111111111111",
      "digest",
      [{ type: "ReviewCreated", version: 1, reviewId: review.id, patchset }],
      review,
    );
    expect(store.latestReview()).toEqual(review);
    store.close();
  });

  it("replays the latest review after a real database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "rennet-store-"));
    const path = join(directory, "review.sqlite");
    const first = new SqliteReviewStore(path);
    first.commit(
      "11111111-1111-4111-8111-111111111111",
      "digest",
      [{ type: "ReviewCreated", version: 1, reviewId: review.id, patchset }],
      review,
    );
    first.close();
    const reopened = new SqliteReviewStore(path);
    expect(reopened.latestReview()).toEqual(review);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns an idempotent receipt and rejects command ID reuse", () => {
    const store = new SqliteReviewStore(":memory:");
    store.commit("command", "one", [], review);
    expect(store.receipt("command", "one")).toEqual(review);
    expect(() => store.receipt("command", "two")).toThrow("different payload");
    store.close();
  });

  it("fails closed when replay sees an unknown event", () => {
    const store = new SqliteReviewStore(":memory:");
    store.appendRawForTesting("review", "ReviewCreated", 1, {
      reviewId: "review",
      patchset,
    });
    store.appendRawForTesting("review", "FutureEvent", 1, { reviewId: "review" });
    expect(() => store.latestReview()).toThrow("Unknown review event");
    store.close();
  });

  it("keys the latest review per repository and retrieves any review by id", () => {
    const store = new SqliteReviewStore(":memory:");
    const repoA: Patchset = {
      ...patchset,
      id: "patch-a",
      repository: { ...patchset.repository, id: "A", root: "/repo-a" },
    };
    const repoB: Patchset = {
      ...patchset,
      id: "patch-b",
      repository: { ...patchset.repository, id: "B", root: "/repo-b" },
    };
    const reviewA = foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "rev-a",
      patchset: repoA,
    });
    const reviewB = foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "rev-b",
      patchset: repoB,
    });
    store.commit(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "da",
      [{ type: "ReviewCreated", version: 1, reviewId: "rev-a", patchset: repoA }],
      reviewA,
    );
    store.commit(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "db",
      [{ type: "ReviewCreated", version: 1, reviewId: "rev-b", patchset: repoB }],
      reviewB,
    );
    // Each repo resolves to its OWN latest review, not the globally newest.
    expect(store.latestReview("/repo-a")?.id).toBe("rev-a");
    expect(store.latestReview("/repo-b")?.id).toBe("rev-b");
    // No-arg latestReview is the global newest (bootstrap restore).
    expect(store.latestReview()?.id).toBe("rev-b");
    // rev-a is not the global latest yet is still retrievable by id.
    expect(store.reviewById("rev-a")?.id).toBe("rev-a");
    expect(store.latestReview("/repo-missing")).toBeNull();
    store.close();
  });

  it("persists dispositions and drops stale ones on regeneration", async () => {
    const next = {
      ...patchset,
      id: "patch-next",
      rawDiff: "+next",
      files: [file("file.ts", "+next")],
    };
    const captures = [patchset, next, next];
    const store = new SqliteReviewStore(":memory:");
    const service = new ReviewService(
      {
        capture: async () => {
          const captured = captures.shift();
          if (!captured) throw new Error("Unexpected capture");
          return captured;
        },
      },
      store,
    );
    const createdReview = await service.capture("11111111-1111-4111-8111-111111111111", "/repo");
    const dispositioned = service.setDisposition(
      "22222222-2222-4222-8222-222222222222",
      createdReview.id,
      createdReview.activePatchsetId,
      "file.ts",
      "comment",
      "",
    );
    expect(dispositioned.dispositions.map((entry) => entry.anchor.path)).toEqual(["file.ts"]);
    const invalid = await service.checkFreshness(
      "33333333-3333-4333-8333-333333333333",
      createdReview.id,
      "/repo",
    );
    expect(invalid.status).toBe("invalid");
    expect(invalid.activePatchsetId).toBe("patch");
    // The invalidation pins the old patchset, so the disposition still stands.
    expect(invalid.dispositions).toHaveLength(1);
    const regenerated = await service.regenerate(
      "44444444-4444-4444-8444-444444444444",
      createdReview.id,
      "/repo",
    );
    expect(regenerated.status).toBe("current");
    expect(regenerated.activePatchsetId).toBe("patch-next");
    // file.ts changed (+base -> +next), so its disposition fails closed and is dropped.
    expect(regenerated.dispositions).toEqual([]);
    store.close();
  });
});
