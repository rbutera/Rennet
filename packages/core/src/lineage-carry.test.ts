import { parseCommandOutput } from "@rennet/protocol";
import type { Disposition, HandoffAskTrace, PatchFile, Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { carryDispositionsByLineage, fileContentDigest, foldReview } from "./index";

// The application half of issue #16: the deterministic disposition carry seam.
// The force-push acceptance criteria as live behaviour — approved-unchanged
// carries (the preserved #10 byte-identical floor), edited reopens, disappeared
// surfaces orphaned (never vanishes). A rename reopens (move carry was removed —
// see the verdict doc). No fuzzy matching decides a carry here.

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

// ── PATH-grained renames REOPEN; never orphan (issue #16) ─────────────────────
// The path-grained move-carry branch was removed (a real rename's whole-file patch
// differs in its diff/index headers, so it never carried in production — F1). A
// path-grained disposition on a rename therefore reopens, and a rename is never
// orphaned (it relocated, did not vanish). The one safe move-carry — a byte-
// identical SPAN — is covered in dispositions-span.test.ts (F4).
describe("carry seam — path-grained rename reopens", () => {
  it("a path-grained rename REOPENS the disposition (dropped), never carrying it onto the new path", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("old.ts", "X")])), "old.ts", "X");
    const renamed = file("new.ts", "X", { status: "renamed", previousPath: "old.ts" });
    const next = activate(review, patchsetOf("p2", [renamed]));
    expect(next.dispositions).toEqual([]); // reopens at the new location
    expect(next.orphaned).toBeUndefined(); // moved, not vanished — so not orphaned
  });

  it("a rename that ALSO changed content REOPENS, never a wrong carry", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("old.ts", "X")])), "old.ts", "X");
    const renamedEdited = file("new.ts", "Y", { status: "renamed", previousPath: "old.ts" });
    const next = activate(review, patchsetOf("p2", [renamedEdited]));
    expect(next.dispositions).toEqual([]);
    expect(next.orphaned).toBeUndefined();
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

// ── The IPC boundary: orphaned must survive the real command-output schema ────
// `Review.orphaned` is an OPTIONAL field, and the `z.ZodType<Review>` annotation
// only guards REQUIRED fields — an optional one satisfies the type by being
// absent, so it can be omitted from `reviewSchema` and Zod strips it at IPC with
// every fold-level test still green (the hole that ate hunkOccurrences /
// verification / tier). This test crosses the REAL boundary: a real fold produces
// an orphan, then `parseCommandOutput` (the exact function dispatch validates
// command outputs with) round-trips it, and the tray must survive.
describe("carry seam — orphaned survives the IPC command-output boundary", () => {
  it("round-trips a foldReview-produced orphan tray through parseCommandOutput('review.capture')", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("a.ts", "X")])), "a.ts", "X");
    const orphanedReview = activate(review, patchsetOf("p2", [file("b.ts", "Z")]));
    // Precondition: the fold really produced an orphan (else the test is vacuous).
    expect(paths(orphanedReview.orphaned ?? [])).toEqual(["a.ts"]);

    // The real output-validation path. If `orphaned` were absent from reviewSchema,
    // Zod would strip it here and the assertion below would fail.
    const parsed = parseCommandOutput("review.capture", { review: orphanedReview });
    expect(parsed.review.orphaned).toBeDefined();
    expect(paths(parsed.review.orphaned ?? [])).toEqual(["a.ts"]);
    expect(parsed.review.orphaned).toEqual(orphanedReview.orphaned);
  });

  it("carries an orphan-free review through the boundary with orphaned absent (back-compat)", () => {
    const review = withDisposition(created(patchsetOf("p1", [file("a.ts", "X")])), "a.ts", "X");
    const carried = activate(review, patchsetOf("p2", [file("a.ts", "X")]));
    const parsed = parseCommandOutput("review.capture", { review: carried });
    expect(parsed.review.orphaned).toBeUndefined();
  });
});

// ── The delta re-review account at the fold (issue #73) ───────────────────────
// A successor activation that carries asks stamps `Review.deltaAccount`: each ask is
// classified (addressed / partially / untouched) and every changed-but-unasked path
// is surfaced beyond-asks. Also crosses the REAL command-output boundary, so an
// unlisted-optional strip (the hunkOccurrences hole) cannot silently drop it.
describe("delta account — stamped on a successor activation (#73)", () => {
  function withThree(): Review {
    let review = created(
      patchsetOf("p1", [file("a.ts", "A1"), file("b.ts", "B1"), file("c.ts", "C1")]),
    );
    review = withDisposition(review, "a.ts", "A1");
    review = withDisposition(review, "b.ts", "B1");
    review = withDisposition(review, "c.ts", "C1");
    return review;
  }

  it("classifies 2 addressed + 1 untouched and flags the unrequested change beyond-asks", () => {
    const successor = activate(
      withThree(),
      // a.ts + b.ts changed (addressed); c.ts byte-identical (untouched); d.ts is new
      // and nobody asked for it (beyond-asks).
      patchsetOf("p2", [
        file("a.ts", "A2"),
        file("b.ts", "B2"),
        file("c.ts", "C1"),
        file("d.ts", "D1"),
      ]),
    );
    const account = successor.deltaAccount;
    expect(account).toBeDefined();
    const status = (path: string) => account?.asks.find((entry) => entry.path === path)?.status;
    expect(status("a.ts")).toBe("addressed");
    expect(status("b.ts")).toBe("addressed");
    expect(status("c.ts")).toBe("untouched");
    expect(account?.beyondAsks).toEqual(["d.ts"]);
  });

  it("a first capture (no predecessor asks) carries no account (back-compat)", () => {
    const first = created(patchsetOf("p1", [file("a.ts", "A1")]));
    expect(first.deltaAccount).toBeUndefined();
  });

  it("survives the real command-output boundary (parseCommandOutput('review.capture'))", () => {
    const successor = activate(
      withThree(),
      patchsetOf("p2", [
        file("a.ts", "A2"),
        file("b.ts", "B2"),
        file("c.ts", "C1"),
        file("d.ts", "D1"),
      ]),
    );
    // Precondition: the fold really produced an account (else the boundary test is vacuous).
    expect(successor.deltaAccount?.beyondAsks).toEqual(["d.ts"]);
    const parsed = parseCommandOutput("review.capture", { review: successor });
    expect(parsed.review.deltaAccount).toBeDefined();
    expect(parsed.review.deltaAccount).toEqual(successor.deltaAccount);
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

describe("delta account — handoff task attribution on a traced activation (#73 wave 3)", () => {
  function withA(): Review {
    let review = created(patchsetOf("p1", [file("a.ts", "A1")]));
    review = withDisposition(review, "a.ts", "A1");
    return review;
  }

  function activateWithHandoff(
    review: Review,
    patchset: Patchset,
    handoff: readonly HandoffAskTrace[],
  ): Review {
    return foldReview(review, {
      type: "PatchsetActivated",
      version: 1,
      reviewId: review.id,
      patchset,
      handoff,
    });
  }

  it("attributes the ask to its composed task when the activation carries a matching trace", () => {
    const successor = activateWithHandoff(withA(), patchsetOf("p2", [file("a.ts", "A2")]), [
      { id: "d0", path: "a.ts", type: "approve", taskIndex: 1, taskTitle: "Fix the export" },
    ]);
    const ask = successor.deltaAccount?.asks.find((entry) => entry.path === "a.ts");
    expect(ask?.handoffTask).toEqual({ index: 1, title: "Fix the export" });
  });

  it("carries no attribution on a regenerate (no handoff on the activation)", () => {
    const successor = activate(withA(), patchsetOf("p2", [file("a.ts", "A2")]));
    expect(successor.deltaAccount?.asks[0]?.handoffTask).toBeUndefined();
  });

  it("an unmatched trace ask degrades to no attribution (belt-and-braces)", () => {
    const successor = activateWithHandoff(withA(), patchsetOf("p2", [file("a.ts", "A2")]), [
      { id: "d1", path: "other.ts", type: "approve", taskIndex: 3, taskTitle: "Unrelated" },
    ]);
    expect(successor.deltaAccount?.asks[0]?.handoffTask).toBeUndefined();
  });
});
