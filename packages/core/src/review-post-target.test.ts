import type { PatchFile, Patchset, Review, ReviewPostTarget } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  foldReview,
  type PatchsetCapturePort,
  type ReviewEvent,
  ReviewService,
  type ReviewStorePort,
} from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Review.postTarget persistence (issue #21, the real-post flip).
//
// A review opened from a REAL pull request carries the exact forge coordinates a
// real GitHub egress needs (repo + PR number + the forge node id + the reviewed
// head). Its PRESENCE is precisely "this review may post to a real PR", so the
// renderer's sign path keys the real-vs-dry-run decision off it. This proves the
// producer half:
//   • the `ReviewCreated` fold stamps a supplied target onto the review snapshot,
//   • `createReviewFromPatchset` persists it through the store,
//   • a RETROSPECTIVE review DROPS the target (nothing may ever be posted from it),
//   • a local review with no target stays byte-identical to before (back-compat).
// ─────────────────────────────────────────────────────────────────────────────

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

const POST_TARGET: ReviewPostTarget = {
  repo: { forge: "github", owner: "rbutera", name: "rennet" },
  number: 7,
  forgeRef: "PR_kwREAL7",
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

function patchsetOf(id: string, files: PatchFile[]): Patchset {
  return {
    id,
    createdAt: "2026-08-11T00:00:00.000Z",
    repository,
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

/** A patchset with an explicit source + head, for the activation-survival tests. */
function patchsetSourced(id: string, source: Patchset["source"], headOid: string): Patchset {
  return {
    ...patchsetOf(id, [addedFile("src/a.ts")]),
    source,
    repository: { ...repository, headOid },
  };
}

/** A one-review in-memory store with a working command receipt (idempotency). */
function storeOf(initial: Review | null): ReviewStorePort {
  let current = initial;
  const receipts = new Map<string, Review>();
  return {
    latestReview: () => current,
    reviewById: (id) => (id !== null && current?.id === id ? current : null),
    patchsetById: (id) => current?.patchsets.find((patchset) => patchset.id === id) ?? null,
    receipt: (commandId, digest) => receipts.get(`${commandId} ${digest}`) ?? null,
    commit: (commandId, digest, _events, result) => {
      current = result;
      receipts.set(`${commandId} ${digest}`, result);
      return result;
    },
  };
}

const noCapture: PatchsetCapturePort = {
  capture: () => {
    throw new Error("capture is not used in this test");
  },
};

describe("Review.postTarget — the real-post flip producer half (issue #21)", () => {
  it("the ReviewCreated fold stamps a supplied post-target onto the snapshot", () => {
    const review = foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "review-1",
      patchset: patchsetOf("ps1", [addedFile("src/a.ts")]),
      postTarget: POST_TARGET,
    } satisfies ReviewEvent);
    expect(review.postTarget).toEqual(POST_TARGET);
  });

  it("a ReviewCreated with NO post-target omits the field (byte-identical back-compat)", () => {
    const review = foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "review-1",
      patchset: patchsetOf("ps1", [addedFile("src/a.ts")]),
    } satisfies ReviewEvent);
    expect("postTarget" in review).toBe(false);
  });

  it("createReviewFromPatchset persists the post-target through the store", async () => {
    const service = new ReviewService(noCapture, storeOf(null));
    const created = await service.createReviewFromPatchset(
      "cmd-1",
      patchsetOf("ps1", [addedFile("src/a.ts")]),
      {
        postTarget: POST_TARGET,
      },
    );
    expect(created.postTarget).toEqual(POST_TARGET);
    expect(created.retrospective).toBeUndefined();
  });

  it("a RETROSPECTIVE review DROPS the post-target even when one is supplied (nothing may post)", async () => {
    const service = new ReviewService(noCapture, storeOf(null));
    const created = await service.createReviewFromPatchset(
      "cmd-1",
      patchsetOf("ps1", [addedFile("src/a.ts")]),
      {
        retrospective: true,
        postTarget: POST_TARGET,
      },
    );
    expect(created.retrospective).toBe(true);
    expect(created.postTarget).toBeUndefined();
  });

  it("a local capture with no post-target leaves the review postable-but-targetless (dry-run only)", async () => {
    const service = new ReviewService(noCapture, storeOf(null));
    const created = await service.createReviewFromPatchset(
      "cmd-1",
      patchsetOf("ps1", [addedFile("src/a.ts")]),
    );
    expect(created.postTarget).toBeUndefined();
    expect(created.retrospective).toBeUndefined();
  });

  it("the post-target is part of review identity: two opens of the same patchset at different PRs are different reviews", async () => {
    const service = new ReviewService(noCapture, storeOf(null));
    const patchset = patchsetOf("ps1", [addedFile("src/a.ts")]);
    const first = await service.createReviewFromPatchset("cmd-1", patchset, {
      postTarget: POST_TARGET,
    });
    const otherPr: ReviewPostTarget = { ...POST_TARGET, number: 8, forgeRef: "PR_kwREAL8" };
    const second = await service.createReviewFromPatchset("cmd-2", patchset, {
      postTarget: otherPr,
    });
    expect(first.postTarget).toEqual(POST_TARGET);
    expect(second.postTarget).toEqual(otherPr);
    // A receipt replay of the SAME command returns the SAME review (idempotent), so the
    // digest is stable — not a fresh mint each call.
    const replay = await service.createReviewFromPatchset("cmd-1", patchset, {
      postTarget: POST_TARGET,
    });
    expect(replay.id).toBe(first.id);
  });
});

describe("Review.postTarget — survives a patchset swap ONLY as the forge PR's own (issue #21)", () => {
  // POST_TARGET.headOid is "head"; the review below is minted against it.
  function prReview(): Review {
    return foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "review-1",
      patchset: patchsetSourced("ps-pr", "github-local", "head"),
      postTarget: POST_TARGET,
    } satisfies ReviewEvent);
  }

  it("DROPS the post-target when a LOCAL working-tree patchset is activated (the exploit)", () => {
    // A local recapture under the same review id — source absent/local. The PR target
    // must not survive onto local content, or local diffs could post to the real PR.
    const after = foldReview(prReview(), {
      type: "PatchsetActivated",
      version: 1,
      reviewId: "review-1",
      patchset: patchsetSourced("ps-local", undefined, "head"),
    } satisfies ReviewEvent);
    expect(after.postTarget).toBeUndefined();
    expect("postTarget" in after).toBe(false); // the key is gone, not merely undefined
  });

  it("KEEPS the post-target when the SAME forge PR patchset (github source, same head) is re-activated", () => {
    const after = foldReview(prReview(), {
      type: "PatchsetActivated",
      version: 1,
      reviewId: "review-1",
      patchset: patchsetSourced("ps-pr-2", "github-local", "head"),
    } satisfies ReviewEvent);
    expect(after.postTarget).toEqual(POST_TARGET);
  });

  it("DROPS the post-target when a github patchset at a DIFFERENT head is activated (a moved head)", () => {
    const after = foldReview(prReview(), {
      type: "PatchsetActivated",
      version: 1,
      reviewId: "review-1",
      patchset: patchsetSourced("ps-moved", "github-local", "movedhead"),
    } satisfies ReviewEvent);
    expect(after.postTarget).toBeUndefined();
  });
});

describe("ReviewService.activatePatchset", () => {
  it("activates one prebuilt successor idempotently without invoking working-tree capture", async () => {
    const initial = foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "review-branch",
      patchset: patchsetSourced("ps-before", "local-branch", "head-before"),
    } satisfies ReviewEvent);
    let current = initial;
    let commits = 0;
    const receipts = new Map<string, Review>();
    const store: ReviewStorePort = {
      latestReview: () => current,
      reviewById: (id) => (id === current.id ? current : null),
      patchsetById: (id) => current.patchsets.find((patchset) => patchset.id === id) ?? null,
      receipt: (commandId, digest) => receipts.get(`${commandId} ${digest}`) ?? null,
      commit: (commandId, digest, _events, result) => {
        commits += 1;
        current = result;
        receipts.set(`${commandId} ${digest}`, result);
        return result;
      },
    };
    const service = new ReviewService(noCapture, store);
    const successor = patchsetSourced("ps-after", "local-branch", "head-after");

    const activated = await service.activatePatchset("round-report-attempt", initial.id, successor);
    const replay = await service.activatePatchset("round-report-attempt", initial.id, successor);

    expect(activated.id).toBe(initial.id);
    expect(activated.activePatchsetId).toBe(successor.id);
    expect(activated.patchsets.map((patchset) => patchset.id)).toEqual(["ps-before", "ps-after"]);
    expect(replay).toEqual(activated);
    expect(commits).toBe(1);
  });
});
