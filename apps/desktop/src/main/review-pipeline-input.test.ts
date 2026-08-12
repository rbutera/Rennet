import type { Patchset } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildReviewCanvasesInput } from "./review-pipeline-input";

// The COMPOSITION boundary (issue #35, F4). The loader test proves ownership can be
// read off a snapshot; THIS proves the composition hands it to `buildReviewCanvases`.
// The original bug was the desktop composition omitting `ownership` from that call —
// which left every desktop test green and CODEOWNERS dead in the real app. Dropping
// `ownership` from `buildReviewCanvasesInput`'s returned object reddens this; dropping
// it at the call site is a type error (the parameter is required).

function patchset(): Patchset {
  return {
    id: "ps",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "r",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    },
    files: [],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

describe("buildReviewCanvasesInput — the composition hands ownership to the pipeline (F4)", () => {
  it("threads the review's CODEOWNERS rules onto the pipeline input", () => {
    const ownership = [{ pattern: "packages/a/**", owners: ["@team-a"] }];
    const input = buildReviewCanvasesInput({
      reviewId: "rv",
      patchset: patchset(),
      dispositions: [],
      ownership,
      installed: [],
      decisionDocs: [],
    });
    // Red-proof: remove `ownership: parts.ownership` from the builder and this reddens
    // — CODEOWNERS would be dead in the real app again with no other test failing.
    expect(input.ownership).toEqual(ownership);
    // Sanity: the rest of the input is assembled too (not a partial object).
    expect(input.reviewId).toBe("rv");
    expect(input.council).toEqual({ availability: { installed: [] } });
  });

  it("passes an EMPTY ownership through unchanged (honest degradation, still present)", () => {
    const input = buildReviewCanvasesInput({
      reviewId: "rv",
      patchset: patchset(),
      dispositions: [],
      ownership: [],
      installed: ["claude-code"],
      decisionDocs: [],
    });
    expect(input.ownership).toEqual([]);
  });

  it("spreads an optional model seat only when supplied", () => {
    const without = buildReviewCanvasesInput({
      reviewId: "rv",
      patchset: patchset(),
      dispositions: [],
      ownership: [],
      installed: [],
      decisionDocs: [],
    });
    expect("codexPort" in without).toBe(false);
  });
});
