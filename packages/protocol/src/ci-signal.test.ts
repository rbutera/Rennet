import type { CiSignal, FlaggedReview } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { flaggedReviewSchema } from "./index";

const checked: CiSignal = {
  status: "checked",
  overall: "failing",
  failures: [
    {
      checkId: "check-run-1",
      checkName: "core:test",
      verdict: "change-caused",
      evidence: "pipeline.test.ts failed",
      implicatedPaths: ["packages/core/src/pipeline.ts"],
      detailsUrl: "https://example.test/check/1",
      classifiedBy: "deterministic",
      findingId: "ci-finding-1",
    },
  ],
  headOid: "abc123",
  incomplete: true,
};

const variants: CiSignal[] = [
  checked,
  {
    status: "checked",
    overall: "passing",
    failures: [],
    headOid: "abc123",
    incomplete: false,
  },
  { status: "no-checks", headOid: "abc123" },
  { status: "unavailable", reason: "forge timed out" },
];

describe("ciSignal wire contract", () => {
  it.each(variants)("round-trips the $status variant", (ciSignal) => {
    const review: FlaggedReview = { status: "ok", findings: [], ciSignal };
    expect(flaggedReviewSchema.parse(review)).toEqual(review);
  });

  it("strip-proofs ciSignal on both flagged review branches", () => {
    const ok: FlaggedReview = { status: "ok", findings: [], ciSignal: checked };
    const failed: FlaggedReview = { status: "failed", reason: "model failed", ciSignal: checked };

    expect(flaggedReviewSchema.parse(ok)).toEqual(ok);
    expect(flaggedReviewSchema.parse(failed)).toEqual(failed);
  });
});
