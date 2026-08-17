import type { FlaggedReview } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { projectUnavailableDeepVerification } from "./flagged-review-verification";

const NON_OBVIOUS_REVIEW: FlaggedReview = {
  status: "ok",
  findings: [
    {
      findingId: "F1",
      anchor: "rennet:hunk/h1",
      summary: "shared branch key leaks repository state",
      severity: "high",
      agreement: { kind: "concur", agree: 1, total: 1 },
    },
  ],
};

describe("projectUnavailableDeepVerification", () => {
  it("surfaces a visible verifier-unavailable caveat for the live deep-review floor", () => {
    const result = projectUnavailableDeepVerification(NON_OBVIOUS_REVIEW, true);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected an ok review");
    expect(result.findings[0]?.verification).toEqual({
      verdict: "inconclusive",
      evidence: "Not verified — no verifier was available for this review.",
    });
  });

  it("leaves quick review unchanged because verification was never promised", () => {
    expect(projectUnavailableDeepVerification(NON_OBVIOUS_REVIEW, false)).toBe(NON_OBVIOUS_REVIEW);
  });
});
