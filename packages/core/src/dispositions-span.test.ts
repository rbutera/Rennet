import { createHash } from "node:crypto";
import type {
  AnchorSide,
  AnchorSpan,
  Disposition,
  DispositionAnchor,
  DispositionRelevanceJudge,
  PatchFile,
  Patchset,
  RelevanceCandidate,
  RelevanceVerdict,
  Review,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  anchorKey,
  applyRelevanceVerdicts,
  carryWithRelevance,
  extractSpanText,
  fileContentDigest,
  foldReview,
  type PatchsetCapturePort,
  partitionCarry,
  type ReviewEvent,
  ReviewService,
  type ReviewStorePort,
  toPublishThread,
} from "./index";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 0, deletions: 0, binary: false, patch };
}

function patchsetOf(id: string, files: PatchFile[]): Patchset {
  return {
    id,
    createdAt: "2026-08-08T00:00:00.000Z",
    repository,
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

function created(patchset: Patchset): Review {
  return foldReview(null, { type: "ReviewCreated", version: 1, reviewId: "review", patchset });
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The authored span text (throws if the fixture span is out of bounds). */
function spanText(patchFile: PatchFile, span: AnchorSpan, side: AnchorSide): string {
  const text = extractSpanText(patchFile, span, side);
  if (text === undefined)
    throw new Error(`fixture span out of bounds: ${JSON.stringify(span)} ${side}`);
  return text;
}

/** A span anchor whose spanDigest is the real digest of the authored span text. */
function spanAnchor(patchFile: PatchFile, span: AnchorSpan, side: AnchorSide): DispositionAnchor {
  return {
    path: patchFile.path,
    contentDigest: fileContentDigest(patchFile),
    span,
    side,
    spanDigest: digest(spanText(patchFile, span, side)),
  };
}

function setDisposition(
  review: Review,
  anchor: DispositionAnchor,
  type: Disposition["type"],
): Review {
  return foldReview(review, {
    type: "DispositionSet",
    version: 1,
    reviewId: review.id,
    patchsetId: review.activePatchsetId,
    disposition: { anchor, type, body: "" },
  });
}

function activate(review: Review, patchset: Patchset): Review {
  return foldReview(review, {
    type: "PatchsetActivated",
    version: 1,
    reviewId: review.id,
    patchset,
  });
}

// A file whose post-image lines are: 1=keep1, 2=span2, 3=span3, 4=keep4.
const PATCH_A = "@@ -1,2 +1,4 @@\n keep1\n+span2\n+span3\n keep4";
// A file whose pre-image lines are: 1=keep1, 2=del2, 3=del3, 4=keep4.
const PATCH_DEL = "@@ -1,4 +1,2 @@\n keep1\n-del2\n-del3\n keep4";

// ── extractSpanText ───────────────────────────────────────────────────────────

describe("extractSpanText (issue #78)", () => {
  it("reads additions (post-image) side-text at a file-line span", () => {
    expect(extractSpanText(file("a.ts", PATCH_A), { startLine: 2, endLine: 3 }, "additions")).toBe(
      "span2\nspan3",
    );
  });

  it("reads context (post-image) side-text", () => {
    expect(extractSpanText(file("a.ts", PATCH_A), { startLine: 1 }, "context")).toBe("keep1");
  });

  it("reads deletions (pre-image) side-text", () => {
    expect(
      extractSpanText(file("a.ts", PATCH_DEL), { startLine: 2, endLine: 3 }, "deletions"),
    ).toBe("del2\ndel3");
  });

  it("returns undefined for an out-of-bounds span", () => {
    expect(extractSpanText(file("a.ts", PATCH_A), { startLine: 99 }, "additions")).toBeUndefined();
  });

  it("returns undefined when the side has no such image (deletions on an all-add file)", () => {
    // PATCH_A has no pre-image at line 2 that is a deletion; line 2 is not in the
    // pre-image at all (the pre-image is keep1/keep4 at old lines 1/2).
    expect(extractSpanText(file("a.ts", PATCH_A), { startLine: 3 }, "deletions")).toBeUndefined();
  });
});

// ── anchorKey + full-anchor fold identity (task 2) ────────────────────────────

describe("full-anchor fold identity (issue #78)", () => {
  it("keys path-grained on path and span-grained on path#L..-L..@side", () => {
    expect(anchorKey({ path: "a.ts" })).toBe("a.ts");
    expect(anchorKey({ path: "a.ts", span: { startLine: 2, endLine: 3 }, side: "additions" })).toBe(
      "a.ts#L2-L3@additions",
    );
    expect(anchorKey({ path: "a.ts", span: { startLine: 5 }, side: "deletions" })).toBe(
      "a.ts#L5-L5@deletions",
    );
  });

  // Reddening: revert anchorKey to `path`-only → the second set wipes the first
  // and this coexistence test reddens.
  it("two spans on one file coexist after two sets", () => {
    const f = file("a.ts", PATCH_A);
    const review = created(patchsetOf("p1", [f]));
    const one = setDisposition(review, spanAnchor(f, { startLine: 2 }, "additions"), "comment");
    const two = setDisposition(one, spanAnchor(f, { startLine: 3 }, "additions"), "approve");
    expect(two.dispositions).toHaveLength(2);
    expect(two.dispositions.map((d) => anchorKey(d.anchor))).toEqual([
      "a.ts#L2-L2@additions",
      "a.ts#L3-L3@additions",
    ]);
  });

  it("clearing one span leaves the other", () => {
    const f = file("a.ts", PATCH_A);
    const review = created(patchsetOf("p1", [f]));
    const one = setDisposition(review, spanAnchor(f, { startLine: 2 }, "additions"), "comment");
    const two = setDisposition(one, spanAnchor(f, { startLine: 3 }, "additions"), "approve");
    const cleared = foldReview(two, {
      type: "DispositionCleared",
      version: 1,
      reviewId: two.id,
      patchsetId: two.activePatchsetId,
      path: "a.ts",
      span: { startLine: 2 },
      side: "additions",
    });
    expect(cleared.dispositions.map((d) => anchorKey(d.anchor))).toEqual(["a.ts#L3-L3@additions"]);
  });

  it("a path-grained and a span disposition on the same file coexist", () => {
    const f = file("a.ts", PATCH_A);
    const review = created(patchsetOf("p1", [f]));
    const one = setDisposition(
      review,
      { path: "a.ts", contentDigest: fileContentDigest(f) },
      "comment",
    );
    const two = setDisposition(one, spanAnchor(f, { startLine: 2 }, "additions"), "approve");
    expect(two.dispositions).toHaveLength(2);
  });

  it("a bare-path clear still clears the file-level disposition", () => {
    const f = file("a.ts", PATCH_A);
    const review = created(patchsetOf("p1", [f]));
    const one = setDisposition(
      review,
      { path: "a.ts", contentDigest: fileContentDigest(f) },
      "comment",
    );
    const cleared = foldReview(one, {
      type: "DispositionCleared",
      version: 1,
      reviewId: one.id,
      patchsetId: one.activePatchsetId,
      path: "a.ts",
    });
    expect(cleared.dispositions).toEqual([]);
  });

  it("a re-set on the same span replaces rather than duplicating", () => {
    const f = file("a.ts", PATCH_A);
    const review = created(patchsetOf("p1", [f]));
    const one = setDisposition(review, spanAnchor(f, { startLine: 2 }, "additions"), "comment");
    const two = setDisposition(one, spanAnchor(f, { startLine: 2 }, "additions"), "request-change");
    expect(two.dispositions).toHaveLength(1);
    expect(two.dispositions[0]?.type).toBe("request-change");
  });
});

// ── The deterministic carry floor (task 3) ────────────────────────────────────

describe("span-aware carry — the deterministic floor (issue #78)", () => {
  function withSpan(patch: string, span: AnchorSpan, side: AnchorSide): Review {
    const f = file("a.ts", patch);
    return setDisposition(created(patchsetOf("p1", [f])), spanAnchor(f, span, side), "approve");
  }

  it("carries an unchanged span", () => {
    const review = withSpan(PATCH_A, { startLine: 2, endLine: 3 }, "additions");
    const next = activate(review, patchsetOf("p2", [file("a.ts", PATCH_A)]));
    expect(next.dispositions.map((d) => anchorKey(d.anchor))).toEqual(["a.ts#L2-L3@additions"]);
  });

  // Reddening: this NAMED carry test reddens if the floor stops digesting the
  // span's side-text (e.g. compares the whole file, or ignores spanDigest).
  it("drops a span with a one-byte edit inside it", () => {
    const review = withSpan(PATCH_A, { startLine: 2, endLine: 3 }, "additions");
    const edited = "@@ -1,2 +1,4 @@\n keep1\n+span2X\n+span3\n keep4";
    const next = activate(review, patchsetOf("p2", [file("a.ts", edited)]));
    expect(next.dispositions).toEqual([]);
  });

  it("carries an unchanged span even when the file changed ELSEWHERE (span beats file-grained)", () => {
    const f = file("a.ts", PATCH_A);
    const base = created(patchsetOf("p1", [f]));
    // Both a span AND a path-grained disposition on the same file.
    const withBoth = setDisposition(
      setDisposition(base, spanAnchor(f, { startLine: 2, endLine: 3 }, "additions"), "approve"),
      { path: "a.ts", contentDigest: fileContentDigest(f) },
      "comment",
    );
    // The successor keeps the span's hunk byte-identical but adds a second hunk
    // elsewhere → the whole-file patch differs (path-grained drops), the span
    // carries.
    const elsewhere = `${PATCH_A}\n@@ -20,1 +22,2 @@\n far\n+farAdd`;
    const next = activate(withBoth, patchsetOf("p2", [file("a.ts", elsewhere)]));
    const keys = next.dispositions.map((d) => anchorKey(d.anchor));
    expect(keys).toContain("a.ts#L2-L3@additions"); // span carried
    expect(keys).not.toContain("a.ts"); // path-grained dropped
  });

  it("drops a span shifted by a line inserted above it (fail-closed)", () => {
    const review = withSpan(PATCH_A, { startLine: 2, endLine: 3 }, "additions");
    // Insert a line at the top: span2/span3 now live at new-file lines 3/4, so
    // reading lines 2-3 yields different text → drop.
    const shifted = "@@ -1,2 +1,5 @@\n keep1\n+inserted\n+span2\n+span3\n keep4";
    const next = activate(review, patchsetOf("p2", [file("a.ts", shifted)]));
    expect(next.dispositions).toEqual([]);
  });

  it("drops an out-of-bounds span", () => {
    const review = withSpan(PATCH_A, { startLine: 2, endLine: 3 }, "additions");
    // The successor's hunk only covers new lines 1-2 → line 3 is out of bounds.
    const smaller = "@@ -1,2 +1,2 @@\n keep1\n+span2";
    const next = activate(review, patchsetOf("p2", [file("a.ts", smaller)]));
    expect(next.dispositions).toEqual([]);
  });

  it("drops a span whose file was removed from the changeset", () => {
    const review = withSpan(PATCH_A, { startLine: 2, endLine: 3 }, "additions");
    const next = activate(review, patchsetOf("p2", [file("b.ts", "@@ -1,1 +1,1 @@\n x")]));
    expect(next.dispositions).toEqual([]);
  });

  it("drops when the side is gone (additions span becomes a deletions-only image)", () => {
    const review = withSpan(PATCH_A, { startLine: 2, endLine: 3 }, "additions");
    // The successor has no additions at new lines 2-3 (a pure-deletion hunk).
    const noAdds = "@@ -1,4 +1,1 @@\n keep1\n-span2\n-span3\n-keep4";
    const next = activate(review, patchsetOf("p2", [file("a.ts", noAdds)]));
    expect(next.dispositions).toEqual([]);
  });

  it("still carries a path-grained disposition on a byte-identical file (regression)", () => {
    const f = file("a.ts", PATCH_A);
    const review = setDisposition(
      created(patchsetOf("p1", [f])),
      { path: "a.ts", contentDigest: fileContentDigest(f) },
      "approve",
    );
    const next = activate(review, patchsetOf("p2", [file("a.ts", PATCH_A)]));
    expect(next.dispositions.map((d) => anchorKey(d.anchor))).toEqual(["a.ts"]);
  });
});

// ── setDisposition authors span anchors (task 4) ──────────────────────────────

class InMemoryStore implements ReviewStorePort {
  #latest: Review | null = null;
  readonly #byId = new Map<string, Review>();
  readonly #receipts = new Map<string, Review>();
  latestReview(repositoryRoot?: string): Review | null {
    if (repositoryRoot === undefined) return this.#latest;
    return this.#latest && this.#latest.repositoryRoot === repositoryRoot ? this.#latest : null;
  }
  reviewById(reviewId: string): Review | null {
    return this.#byId.get(reviewId) ?? null;
  }
  receipt(commandId: string, digestKey: string): Review | null {
    return this.#receipts.get(`${commandId}:${digestKey}`) ?? null;
  }
  commit(commandId: string, digestKey: string, _events: ReviewEvent[], result: Review): Review {
    this.#latest = result;
    this.#byId.set(result.id, result);
    this.#receipts.set(`${commandId}:${digestKey}`, result);
    return result;
  }
}

function serviceWith(patchset: Patchset): {
  service: ReviewService;
  store: InMemoryStore;
  review: Review;
} {
  const store = new InMemoryStore();
  const capture: PatchsetCapturePort = { capture: () => Promise.resolve(patchset) };
  const service = new ReviewService(capture, store);
  return { service, store, review: store.latestReview() as Review };
}

describe("ReviewService.setDisposition authors span anchors (issue #78)", () => {
  async function seed(patch: string): Promise<{ service: ReviewService; review: Review }> {
    const { service } = serviceWith(patchsetOf("p1", [file("a.ts", patch)]));
    const review = await service.capture("11111111-1111-1111-1111-111111111111", "/repo");
    return { service, review };
  }

  it("round-trips a span disposition (span + side + spanDigest stored)", async () => {
    const { service, review } = await seed(PATCH_A);
    const after = service.setDisposition(
      "22222222-2222-2222-2222-222222222222",
      review.id,
      review.activePatchsetId,
      "a.ts",
      "comment",
      "note",
      { startLine: 2, endLine: 3 },
      "additions",
    );
    const anchor = after.dispositions[0]?.anchor;
    expect(anchor?.span).toEqual({ startLine: 2, endLine: 3 });
    expect(anchor?.side).toBe("additions");
    expect(anchor?.spanDigest).toBe(digest("span2\nspan3"));
  });

  it("errors on an out-of-bounds span at author time", async () => {
    const { service, review } = await seed(PATCH_A);
    expect(() =>
      service.setDisposition(
        "33333333-3333-3333-3333-333333333333",
        review.id,
        review.activePatchsetId,
        "a.ts",
        "comment",
        "",
        { startLine: 99 },
        "additions",
      ),
    ).toThrow("out of bounds");
  });

  it("errors when a span is supplied without a side", async () => {
    const { service, review } = await seed(PATCH_A);
    expect(() =>
      service.setDisposition(
        "44444444-4444-4444-4444-444444444444",
        review.id,
        review.activePatchsetId,
        "a.ts",
        "comment",
        "",
        { startLine: 2 },
      ),
    ).toThrow("both a span and a side");
  });

  it("leaves a path-grained set unchanged (no span/side)", async () => {
    const { service, review } = await seed(PATCH_A);
    const after = service.setDisposition(
      "55555555-5555-5555-5555-555555555555",
      review.id,
      review.activePatchsetId,
      "a.ts",
      "approve",
      "",
    );
    const anchor = after.dispositions[0]?.anchor;
    expect(anchor?.span).toBeUndefined();
    expect(anchor?.side).toBeUndefined();
  });
});

// ── The relevance judge — the model layer above the floor (task 5) ────────────

class StubRelevanceJudge implements DispositionRelevanceJudge {
  constructor(private readonly fn: (candidates: RelevanceCandidate[]) => RelevanceVerdict[]) {}
  judge(candidates: RelevanceCandidate[]): Promise<RelevanceVerdict[]> {
    return Promise.resolve(this.fn(candidates));
  }
}

describe("partitionCarry (issue #78)", () => {
  it("splits floor-carried from dropped candidates, with the successor patch on survivors", () => {
    const fA = file("a.ts", PATCH_A);
    const carriedAnchor = spanAnchor(fA, { startLine: 2, endLine: 3 }, "additions");
    const droppedAnchor = spanAnchor(fA, { startLine: 1 }, "context"); // keep1 → will change
    const previous: Disposition[] = [
      { anchor: carriedAnchor, type: "approve", body: "" },
      { anchor: droppedAnchor, type: "comment", body: "" },
    ];
    // Successor: span2/span3 unchanged (carries), keep1 → keepZZZ (drops the context span).
    const nextPatch = "@@ -1,2 +1,4 @@\n keepZZZ\n+span2\n+span3\n keep4";
    const { carried, candidates } = partitionCarry(
      previous,
      patchsetOf("p2", [file("a.ts", nextPatch)]),
    );
    expect(carried.map((d) => anchorKey(d.anchor))).toEqual(["a.ts#L2-L3@additions"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.successorPatch).toBe(nextPatch);
  });
});

describe("applyRelevanceVerdicts (issue #78)", () => {
  const fA = file("a.ts", PATCH_A);
  const dropped: Disposition = {
    anchor: spanAnchor(fA, { startLine: 1 }, "context"),
    type: "comment",
    body: "still relevant",
  };
  const nextPatch = "@@ -1,2 +1,4 @@\n keepZZZ\n+span2\n+span3\n keep4";
  const next = patchsetOf("p2", [file("a.ts", nextPatch)]);

  it("re-attaches a carry-true verdict at a valid re-anchor, re-digesting from next", () => {
    const candidates: RelevanceCandidate[] = [{ disposition: dropped, successorPatch: nextPatch }];
    const verdicts: RelevanceVerdict[] = [
      {
        carry: true,
        reAnchor: {
          path: "a.ts",
          contentDigest: "ignored",
          span: { startLine: 2, endLine: 3 },
          side: "additions",
        },
      },
    ];
    const carried = applyRelevanceVerdicts(candidates, verdicts, next);
    expect(carried).toHaveLength(1);
    expect(carried.map((d) => anchorKey(d.anchor))).toEqual(["a.ts#L2-L3@additions"]);
    // The re-anchored span's digest is recomputed from `next`, not copied.
    expect(carried[0]?.anchor.spanDigest).toBe(digest("span2\nspan3"));
  });

  // Reddening: make applyRelevanceVerdicts trust the re-anchor blindly (skip the
  // in-bounds check + re-digest) → this fail-closed test reddens.
  it("drops a carry-true verdict whose re-anchor is out of bounds (fail-closed)", () => {
    const candidates: RelevanceCandidate[] = [{ disposition: dropped, successorPatch: nextPatch }];
    const verdicts: RelevanceVerdict[] = [
      {
        carry: true,
        reAnchor: {
          path: "a.ts",
          contentDigest: "ignored",
          span: { startLine: 99 },
          side: "additions",
        },
      },
    ];
    expect(applyRelevanceVerdicts(candidates, verdicts, next)).toEqual([]);
  });

  it("drops a carry-true verdict whose re-anchor file is gone (fail-closed)", () => {
    const candidates: RelevanceCandidate[] = [{ disposition: dropped }];
    const verdicts: RelevanceVerdict[] = [
      { carry: true, reAnchor: { path: "gone.ts", contentDigest: "x" } },
    ];
    expect(applyRelevanceVerdicts(candidates, verdicts, next)).toEqual([]);
  });

  it("does not carry a carry-false verdict", () => {
    const candidates: RelevanceCandidate[] = [{ disposition: dropped }];
    expect(applyRelevanceVerdicts(candidates, [{ carry: false }], next)).toEqual([]);
  });
});

describe("carryWithRelevance (issue #78)", () => {
  const fA = file("a.ts", PATCH_A);

  it("runs the judge ABOVE the floor: floor keeps the unchanged span, judge re-attaches a shifted one", async () => {
    const stableAnchor = spanAnchor(fA, { startLine: 2 }, "additions"); // span2 alone
    const shiftedAnchor = spanAnchor(fA, { startLine: 3 }, "additions"); // span3 alone — will shift
    const previous: Disposition[] = [
      { anchor: stableAnchor, type: "approve", body: "" },
      { anchor: shiftedAnchor, type: "comment", body: "" },
    ];
    // Successor: span2 stays at line 2 (floor carries); span3 shifts to line 4
    // (floor drops → candidate). The stub judge re-anchors it to line 4.
    const nextPatch = "@@ -1,2 +1,5 @@\n keep1\n+span2\n+midInsert\n+span3\n keep4";
    const next = patchsetOf("p2", [file("a.ts", nextPatch)]);
    const judge = new StubRelevanceJudge((candidates) =>
      candidates.map(() => ({
        carry: true,
        reAnchor: {
          path: "a.ts",
          contentDigest: "ignored",
          span: { startLine: 4 },
          side: "additions" as const,
        },
      })),
    );
    const { carried, orphaned } = await carryWithRelevance(previous, next, judge);
    const keys = carried.map((d) => anchorKey(d.anchor)).sort();
    expect(keys).toEqual(["a.ts#L2-L2@additions", "a.ts#L4-L4@additions"]);
    expect(orphaned).toEqual([]);
  });

  it("orphans everything the floor dropped and the judge declined", async () => {
    const shiftedAnchor = spanAnchor(fA, { startLine: 3 }, "additions");
    const previous: Disposition[] = [{ anchor: shiftedAnchor, type: "comment", body: "" }];
    const nextPatch = "@@ -1,2 +1,5 @@\n keep1\n+span2\n+midInsert\n+span3\n keep4";
    const next = patchsetOf("p2", [file("a.ts", nextPatch)]);
    const judge = new StubRelevanceJudge((candidates) => candidates.map(() => ({ carry: false })));
    const { carried, orphaned } = await carryWithRelevance(previous, next, judge);
    expect(carried).toEqual([]);
    expect(orphaned.map((d) => anchorKey(d.anchor))).toEqual(["a.ts#L3-L3@additions"]);
  });
});

describe("ReviewService.recaptureWithRelevance — the live judge wiring (issue #78)", () => {
  it("commits the floor carry then a DispositionsCarried re-attach for the judge-approved", async () => {
    // Author: a path-grained disposition that will carry via the floor, plus a
    // span disposition on keep1 that the successor edits (floor drops → judged).
    const fA = file("a.ts", PATCH_A);
    const store = new InMemoryStore();
    const nextPatch = "@@ -1,2 +1,4 @@\n keepZZZ\n+span2\n+span3\n keep4";
    const capture: PatchsetCapturePort = {
      capture: () => Promise.resolve(patchsetOf("p2", [file("a.ts", nextPatch)])),
    };
    const service = new ReviewService(capture, store);
    // Seed a prior review directly through the fold + store.
    let review = created(patchsetOf("p1", [fA]));
    review = setDisposition(
      review,
      { path: "a.ts", contentDigest: fileContentDigest(fA) },
      "approve",
    );
    review = setDisposition(review, spanAnchor(fA, { startLine: 1 }, "context"), "comment");
    store.commit("seed", "seed", [], review);

    // The stub judge re-anchors the dropped context span to the still-present
    // keep4 line (new-file line 4).
    const judge = new StubRelevanceJudge((candidates) =>
      candidates.map(() => ({
        carry: true,
        reAnchor: {
          path: "a.ts",
          contentDigest: "ignored",
          span: { startLine: 4 },
          side: "context" as const,
        },
      })),
    );
    const after = await service.recaptureWithRelevance(
      "66666666-6666-6666-6666-666666666666",
      "/repo",
      review.id,
      judge,
    );
    const keys = after.dispositions.map((d) => anchorKey(d.anchor)).sort();
    // Floor drops the path-grained anchor (keepZZZ changed the whole file) but the
    // judge re-attaches the context span at line 4.
    expect(keys).toContain("a.ts#L4-L4@context");
    expect(after.activePatchsetId).toBe("p2");
  });

  it("leaves the default capture() path floor-only (no judge)", async () => {
    const fA = file("a.ts", PATCH_A);
    const store = new InMemoryStore();
    const capture: PatchsetCapturePort = {
      capture: () => Promise.resolve(patchsetOf("p1", [fA])),
    };
    const service = new ReviewService(capture, store);
    const review = await service.capture("77777777-7777-7777-7777-777777777777", "/repo");
    expect(review.dispositions).toEqual([]);
  });
});

// ── The publish payload contract (task 7) ─────────────────────────────────────

describe("toPublishThread (issue #78)", () => {
  function spanDisposition(span: AnchorSpan, side: AnchorSide): Disposition {
    return {
      anchor: { path: "a.ts", contentDigest: "cd", span, side, spanDigest: "sd" },
      type: "comment",
      body: "b",
    };
  }

  // Reddening: flip the side map (additions → LEFT) → this side test reddens.
  it("maps an additions span to RIGHT with the end line", () => {
    expect(toPublishThread(spanDisposition({ startLine: 2, endLine: 3 }, "additions"))).toEqual({
      path: "a.ts",
      line: 3,
      startLine: 2,
      side: "RIGHT",
      body: "b",
      type: "comment",
    });
  });

  it("maps a deletions span to LEFT", () => {
    expect(toPublishThread(spanDisposition({ startLine: 5 }, "deletions"))).toMatchObject({
      side: "LEFT",
      line: 5,
    });
  });

  it("maps a context span to RIGHT", () => {
    expect(toPublishThread(spanDisposition({ startLine: 7 }, "context"))).toMatchObject({
      side: "RIGHT",
    });
  });

  it("omits startLine for a single-line span (line only)", () => {
    const thread = toPublishThread(spanDisposition({ startLine: 9 }, "additions"));
    expect(thread.line).toBe(9);
    expect(thread.startLine).toBeUndefined();
  });

  it("maps a path-grained disposition to a file-level payload (no line/side)", () => {
    const thread = toPublishThread({
      anchor: { path: "a.ts", contentDigest: "cd" },
      type: "approve",
      body: "b",
    });
    expect(thread).toEqual({ path: "a.ts", body: "b", type: "approve" });
  });
});
