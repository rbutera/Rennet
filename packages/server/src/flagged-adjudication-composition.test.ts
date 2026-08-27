import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop flagged composition (B2 trim)", () => {
  it("keeps the flagged runner on the late-enrichment seam with no live adjudication/verify-ui", () => {
    const source = readFileSync(new URL("./create-server.ts", import.meta.url), "utf8");

    // The composition seam and its return shape survive the Board rebuild.
    expect(source).toContain("composeFlaggedLateEnrichment({");
    expect(source).toContain(
      "return { review: composed.review, adjudication: composed.enrichment };",
    );
    // The model-backed cross-harness adjudication and verify-ui late passes died with
    // the Board rebuild (their adapter backends were deleted in B2) — no live enrichment.
    expect(source).not.toContain("adjudicateFlaggedReview");
    expect(source).not.toContain("runUiVerification");
  });
});
