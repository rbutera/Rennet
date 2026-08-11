import type { Disposition, PatchFile, Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { carryDispositionsByLineage, fileContentDigest, foldReview } from "./index";

// The application half of issue #16: the successor-canvas carry seam upgraded
// from #10's exact-only v1. These are the force-push acceptance criteria as live
// behaviour — approved-unchanged carries, edited reopens, disappeared surfaces
// orphaned (never vanishes) — plus the new byte-verifiable move carry.

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

function file(path: string, patch: string, over: Partial<PatchFile> = {}): PatchFile {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false, patch, ...over };
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

function created(patchset: Patchset): Review {
  return foldReview(null, { type: "ReviewCreated", version: 1, reviewId: "review", patchset });
}

function withDisposition(review: Review, path: string, patch: string): Review {
  const disposition: Disposition = {
    anchor: { path, contentDigest: fileContentDigest(file(path, patch)) },
    type: "approve",
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

function activate(review: Review, patchset: Patchset): Review {
  return foldReview(review, {
    type: "PatchsetActivated",
    version: 1,
    reviewId: review.id,
    patchset,
  });
}

const paths = (dispositions: Disposition[]) => dispositions.map((d) => d.anchor.path).sort();

// ── The force-push acceptance criteria (issue #16 DoD) ────────────────────────
describe("carry seam — the force-push criteria", () => {
  it("approved-unchanged CARRIES across the new patchset (the preserved floor)", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("a.ts", "X")])), "a.ts", "X");
    const next = activate(review, patchsetOf("p2", [file("a.ts", "X")]));
    expect(paths(next.dispositions)).toEqual(["a.ts"]);
    expect(next.orphaned).toBeUndefined();
  });

  it("an EDITED occurrence REOPENS — dropped from dispositions, and NOT orphaned", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("a.ts", "X")])), "a.ts", "X");
    const next = activate(review, patchsetOf("p2", [file("a.ts", "Y")]));
    expect(next.dispositions).toEqual([]); // reopens: the reviewer re-reads
    expect(next.orphaned).toBeUndefined(); // the code is present, not vanished
  });

  it("a DISAPPEARED occurrence surfaces ORPHANED and never vanishes", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("a.ts", "X")])), "a.ts", "X");
    const next = activate(review, patchsetOf("p2", [file("b.ts", "Z")]));
    expect(next.dispositions).toEqual([]);
    expect(paths(next.orphaned ?? [])).toEqual(["a.ts"]); // surfaced, not dropped to void
  });

  it("a DELETED file (present as a deletion) also orphans, never reopens", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("a.ts", "X")])), "a.ts", "X");
    const next = activate(
      review,
      patchsetOf("p2", [file("a.ts", "deletion", { status: "deleted" })]),
    );
    expect(next.dispositions).toEqual([]);
    expect(paths(next.orphaned ?? [])).toEqual(["a.ts"]);
  });

  it("the mixed force-push: one kept, one edited, one gone — carried, reopened, orphaned", () => {
    let review = created(
      patchsetOf("p1", [file("k.ts", "K"), file("e.ts", "E"), file("g.ts", "G")]),
    );
    review = withDisposition(review, "k.ts", "K");
    review = withDisposition(review, "e.ts", "E");
    review = withDisposition(review, "g.ts", "G");
    const next = activate(review, patchsetOf("p2", [file("k.ts", "K"), file("e.ts", "E2")]));
    expect(paths(next.dispositions)).toEqual(["k.ts"]); // kept carries
    expect(paths(next.orphaned ?? [])).toEqual(["g.ts"]); // gone orphans
    // e.ts is neither carried nor orphaned — it reopened.
    expect([...paths(next.dispositions), ...paths(next.orphaned ?? [])]).not.toContain("e.ts");
  });
});

// ── Move carry: byte-verifiable renames carry, unverifiable renames reopen ─────
describe("carry seam — move (rename)", () => {
  it("carries a disposition across a byte-identical rename, re-anchored to the new path", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("old.ts", "X")])), "old.ts", "X");
    const renamed = file("new.ts", "X", { status: "renamed", previousPath: "old.ts" });
    const next = activate(review, patchsetOf("p2", [renamed]));
    expect(paths(next.dispositions)).toEqual(["new.ts"]); // re-anchored, not orphaned
    expect(next.orphaned).toBeUndefined();
  });

  it("a rename that ALSO changed content REOPENS (patch-digest cannot certify it), never a wrong carry", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("old.ts", "X")])), "old.ts", "X");
    const renamedEdited = file("new.ts", "Y", { status: "renamed", previousPath: "old.ts" });
    const next = activate(review, patchsetOf("p2", [renamedEdited]));
    expect(next.dispositions).toEqual([]); // reopens at the new location
    expect(next.orphaned).toBeUndefined(); // moved, not vanished
  });
});

// ── The orphan tray is recomputed, not sticky ─────────────────────────────────
describe("carry seam — orphan tray lifecycle", () => {
  it("clears the orphan tray when the occurrence returns byte-identical", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("a.ts", "X")])), "a.ts", "X");
    const gone = activate(review, patchsetOf("p2", [file("b.ts", "Z")]));
    expect(paths(gone.orphaned ?? [])).toEqual(["a.ts"]);
    // The disposition was dropped when it orphaned, so a later re-appearance does
    // NOT resurrect the approval — but the stale orphan tray must not persist.
    const back = activate(gone, patchsetOf("p3", [file("a.ts", "X")]));
    expect(back.orphaned).toBeUndefined();
  });
});

// ── The pure function directly (no fold), for the split carried/orphaned shape ─
describe("carryDispositionsByLineage", () => {
  it("partitions into carried and orphaned without dropping anything to void", () => {
    const dispositions: Disposition[] = [
      {
        anchor: { path: "keep.ts", contentDigest: fileContentDigest(file("keep.ts", "K")) },
        type: "approve",
        body: "",
      },
      {
        anchor: { path: "gone.ts", contentDigest: fileContentDigest(file("gone.ts", "G")) },
        type: "comment",
        body: "",
      },
    ];
    const next = patchsetOf("p2", [file("keep.ts", "K")]);
    const { carried, orphaned } = carryDispositionsByLineage(dispositions, next);
    expect(paths(carried)).toEqual(["keep.ts"]);
    expect(paths(orphaned)).toEqual(["gone.ts"]);
    // Nothing is lost: every input disposition lands in exactly one tray.
    expect(carried.length + orphaned.length).toBe(dispositions.length);
  });
});
