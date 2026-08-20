import type { ReviewNarration } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { narrationForZoom } from "./logic";

const NARRATION: ReviewNarration = {
  rollup: { status: "narrated", oneLine: "the whole change", paragraph: "all of it" },
  cohorts: {
    "cohort:c1": { status: "narrated", oneLine: "the store", paragraph: "the base" },
    "cohort:c2": { status: "failed" },
  },
};

describe("narrationForZoom (issue #70) — the account for the altitude in view", () => {
  it("returns the roll-up account at roll-up zoom", () => {
    expect(narrationForZoom(NARRATION, { level: "rollup" })).toEqual(NARRATION.rollup);
  });

  it("returns the cohort's account at cohort zoom", () => {
    expect(narrationForZoom(NARRATION, { level: "cohort", cohortKey: "cohort:c1" })).toEqual(
      NARRATION.cohorts["cohort:c1"],
    );
  });

  it("resolves a cohort with no delivered account to an honest pending — never blank", () => {
    expect(narrationForZoom(NARRATION, { level: "cohort", cohortKey: "cohort:UNKNOWN" })).toEqual({
      status: "pending",
    });
  });

  it("shows nothing below a cohort (element/diff are the CodeView's concern)", () => {
    expect(narrationForZoom(NARRATION, { level: "element", elementKey: "e1" })).toBeUndefined();
    expect(narrationForZoom(NARRATION, { level: "diff", elementKey: "e1" })).toBeUndefined();
  });

  it("returns undefined when there is no narration at all", () => {
    expect(narrationForZoom(undefined, { level: "rollup" })).toBeUndefined();
  });
});
