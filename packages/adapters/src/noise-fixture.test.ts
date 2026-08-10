import { describe, expect, it } from "vitest";
import {
  emptyNoiseReviewFixture,
  failedNoiseReviewFixture,
  noiseReviewFixture,
} from "./noise-fixture";

describe("noiseReviewFixture (issue #34)", () => {
  const review = noiseReviewFixture();
  if (review.status !== "ok") throw new Error("noiseReviewFixture must be an ok review");
  const groups = review.groups;

  it("emits several grouped-away churn groups, each with a plain-speech summary", () => {
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.summary.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("exercises BOTH judged-by chip types — a mechanical rule AND the LLM noise job", () => {
    const kinds = new Set(groups.map((group) => group.judgedBy.kind));
    expect(kinds.has("rule")).toBe(true);
    expect(kinds.has("noise-job")).toBe(true);
  });

  it("includes a DEVIATING line so the deviating-line ejection path renders", () => {
    const deviating = groups.flatMap((group) => group.items).filter((item) => item.deviates);
    expect(deviating.length).toBeGreaterThan(0);
  });

  it("uses only closed-vocabulary categories", () => {
    const allowed = [
      "formatting",
      "lockfile",
      "import-order",
      "generated",
      "fixture-rename",
      "comment-typo",
      "other",
    ];
    for (const group of groups) expect(allowed).toContain(group.category);
  });

  it("keeps empty vs failed honestly distinct", () => {
    expect(emptyNoiseReviewFixture()).toEqual({ status: "ok", groups: [] });
    expect(failedNoiseReviewFixture().status).toBe("failed");
  });
});
