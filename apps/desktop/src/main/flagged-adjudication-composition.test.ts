import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop flagged adjudication composition (#41)", () => {
  it("keeps the real flagged runner plugged into non-blocking late enrichment", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("adjudicateFlaggedReview(immediate, adjudicationOptions).then");
    expect(source).toContain("return { review: immediate, adjudication };");
    expect(source).not.toContain("await adjudicateFlaggedReview");
  });
});
