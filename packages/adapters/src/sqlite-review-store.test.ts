import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "@rennet/core";
import type { Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { SqliteReviewStore } from "./sqlite-review-store";

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
  files: [],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const review: Review = {
  id: "review",
  repositoryRoot: "/repo",
  patchsets: [patchset],
  activePatchsetId: patchset.id,
  readPaths: [],
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

  it("persists read state, invalidation, and explicit regeneration", async () => {
    const next = { ...patchset, id: "patch-next", rawDiff: "+next" };
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
    const created = await service.capture("11111111-1111-4111-8111-111111111111", "/repo");
    const read = service.setFileRead(
      "22222222-2222-4222-8222-222222222222",
      created.id,
      created.activePatchsetId,
      "file.ts",
      true,
    );
    expect(read.readPaths).toEqual(["file.ts"]);
    const invalid = await service.checkFreshness(
      "33333333-3333-4333-8333-333333333333",
      created.id,
      "/repo",
    );
    expect(invalid.status).toBe("invalid");
    expect(invalid.activePatchsetId).toBe("patch");
    const regenerated = await service.regenerate(
      "44444444-4444-4444-8444-444444444444",
      created.id,
      "/repo",
    );
    expect(regenerated.status).toBe("current");
    expect(regenerated.activePatchsetId).toBe("patch-next");
    expect(regenerated.readPaths).toEqual([]);
    store.close();
  });
});
