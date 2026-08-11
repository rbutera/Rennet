import type { PatchFile, Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  anchorKey,
  foldReview,
  type PatchsetCapturePort,
  type ReviewEvent,
  ReviewService,
  type ReviewStorePort,
} from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// The Spec-view disposition DURABILITY proof (review finding #1).
//
// The Spec angle's review affordances author a disposition against the REAL
// OpenSpec artifact file path (`openspec/changes/<name>/<artifact>`) at a per-node
// line span. This test drives that write THROUGH the engine's `ReviewService`
// disposition path — the same path the `canvas.disposition` command dispatches to —
// and proves:
//   1. a Spec disposition on a real artifact file IN the patchset is ACCEPTED and
//      recorded (it persists — not a swallowed no-op),
//   2. distinct nodes on ONE file (five requirements in one `spec.md`) coexist via
//      distinct span-grained anchor keys, rather than colliding on one path,
//   3. the OLD synthetic `openspec:<name>/…` key — what the affordance used before —
//      is REJECTED as a path outside the patchset (the exact bug this fixes).
//
// The OpenSpec artifacts ARE reviewable patchset files: rennet's `.gitignore`
// un-ignores `openspec/`, so a PR that adds/edits a change ships those files in its
// diff, and a disposition against them is accepted.
// ─────────────────────────────────────────────────────────────────────────────

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

/** An ADDED file whose post-image is `count` lines: line i = `<path> L<i>`. */
function addedFile(path: string, count: number): PatchFile {
  const body = Array.from({ length: count }, (_v, i) => `+${path} L${i + 1}`).join("\n");
  return {
    path,
    status: "added",
    additions: count,
    deletions: 0,
    binary: false,
    patch: `@@ -0,0 +1,${count} @@\n${body}`,
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

/** A one-review in-memory store — enough to exercise `ReviewService.setDisposition`. */
function storeOf(initial: Review): ReviewStorePort {
  let current = initial;
  return {
    latestReview: () => current,
    reviewById: (id) => (id === current.id ? current : null),
    receipt: () => null,
    commit: (_commandId, _digest, _events, result) => {
      current = result;
      return result;
    },
  };
}

const noCapture: PatchsetCapturePort = {
  capture: () => {
    throw new Error("capture is not used in this test");
  },
};

const PROPOSAL = "openspec/changes/add-review-intelligence-core/proposal.md";
const SPEC = "openspec/changes/add-review-intelligence-core/specs/review-hypothesis-pass/spec.md";

function seed(): { service: ReviewService; review: Review; patchsetId: string } {
  const patchset = patchsetOf("ps1", [addedFile(PROPOSAL, 30), addedFile(SPEC, 20)]);
  const review = foldReview(null, {
    type: "ReviewCreated",
    version: 1,
    reviewId: "review-1",
    patchset,
  } satisfies ReviewEvent);
  return {
    service: new ReviewService(noCapture, storeOf(review)),
    review,
    patchsetId: patchset.id,
  };
}

describe("Spec-view disposition durability (finding #1)", () => {
  it("ACCEPTS and records a span-grained disposition on a real artifact file", () => {
    const { service, review, patchsetId } = seed();
    const after = service.setDisposition(
      "cmd-1",
      review.id,
      patchsetId,
      SPEC,
      "request-change",
      "this requirement needs a guard",
      { startLine: 3 },
      "additions",
    );
    // It persisted: the review now carries exactly this disposition, keyed span-grained.
    const active = after.patchsets.find((p) => p.id === after.activePatchsetId);
    expect(active).toBeDefined();
    const dispositions = after.dispositions ?? [];
    expect(dispositions).toHaveLength(1);
    const only = dispositions[0];
    expect(only?.type).toBe("request-change");
    expect(only?.body).toBe("this requirement needs a guard");
    expect(anchorKey(only?.anchor ?? { path: "" })).toBe(`${SPEC}#L3-L3@additions`);
  });

  it("lets DISTINCT nodes on ONE spec.md coexist (no collision across requirements)", () => {
    const { service, review, patchsetId } = seed();
    const one = service.setDisposition(
      "cmd-a",
      review.id,
      patchsetId,
      SPEC,
      "comment",
      "on requirement one",
      { startLine: 3 },
      "additions",
    );
    const two = service.setDisposition(
      "cmd-b",
      one.id,
      patchsetId,
      SPEC,
      "comment",
      "on requirement two",
      { startLine: 11 },
      "additions",
    );
    // Both live — five requirements in one file would be five dispositions, not one
    // overwriting the rest (the path-grained collision the fix avoids).
    const keys = (two.dispositions ?? []).map((d) => anchorKey(d.anchor)).sort();
    expect(keys).toEqual([`${SPEC}#L11-L11@additions`, `${SPEC}#L3-L3@additions`]);
  });

  it("ACCEPTS a path-grained disposition on the proposal doc (the whole-change rollup)", () => {
    const { service, review, patchsetId } = seed();
    const after = service.setDisposition(
      "cmd-r",
      review.id,
      patchsetId,
      PROPOSAL,
      "comment",
      "a comment on the whole change",
    );
    expect(after.dispositions ?? []).toHaveLength(1);
    expect(anchorKey((after.dispositions ?? [])[0]?.anchor ?? { path: "" })).toBe(PROPOSAL);
  });

  it("REJECTS the OLD synthetic key — the exact pre-fix failure", () => {
    const { service, review, patchsetId } = seed();
    expect(() =>
      service.setDisposition(
        "cmd-x",
        review.id,
        patchsetId,
        // What the affordance emitted BEFORE the fix: a structural key, not a file.
        "openspec:add-review-intelligence-core/spec/review-hypothesis-pass/a-requirement",
        "request-change",
        "would have been silently swallowed",
        { startLine: 3 },
        "additions",
      ),
    ).toThrow(/outside the active patchset/);
  });
});
