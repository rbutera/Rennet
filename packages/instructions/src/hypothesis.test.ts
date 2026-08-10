import type { ReviewHypothesis } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  PROMPT_LAYER_ORDER,
  REVIEW_HYPOTHESIS_CONTRACT,
  renderBaseInstruction,
  renderHypothesisLayer,
} from "./index";

const HYPOTHESIS: ReviewHypothesis = {
  domain: "key the review store per repository",
  scope: { inScope: ["store keying"], outOfScope: ["the knowledge layer"] },
  designExpectation: "resolve the key from realpath(git-common-dir)",
  risks: [
    {
      riskId: "R1",
      statement: "the key is computed per branch instead of per repository root",
      severity: "high",
      disconfirmer: "verify the key uses git-common-dir, not the branch name",
    },
    {
      riskId: "R2",
      statement: "worktrees collide on a single entry",
      severity: "medium",
      disconfirmer: "check each worktree keys its own entry",
    },
  ],
  repoContextPresent: true,
};

describe("REVIEW_HYPOTHESIS_CONTRACT (#178)", () => {
  it("is a review.hypothesis@1 contract that renders its base instruction", () => {
    expect(REVIEW_HYPOTHESIS_CONTRACT.docType).toBe("review.hypothesis");
    const base = renderBaseInstruction(REVIEW_HYPOTHESIS_CONTRACT);
    expect(base).toContain("# Rennet base instruction: review.hypothesis@1");
    // It must instruct the model NOT to read the code (a genuine prior).
    expect(base.toLowerCase()).toContain("not given the code hunks");
  });
});

describe("the hypothesis prompt layer (#178)", () => {
  it("sits between base and the payload in the fixed layer order", () => {
    const order = [...PROMPT_LAYER_ORDER];
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("hypothesis"));
    expect(order.indexOf("hypothesis")).toBeLessThan(order.indexOf("payload"));
  });

  it("renderHypothesisLayer carries the domain, scope, design, and numbered risks-with-disconfirmers", () => {
    const layer = renderHypothesisLayer(HYPOTHESIS);
    expect(layer).toContain("Committed review hypothesis");
    expect(layer).toContain("key the review store per repository");
    expect(layer).toContain("EXPECTATIONS to disconfirm");
    expect(layer).toContain("1. [high] the key is computed per branch");
    expect(layer).toContain("disconfirm: verify the key uses git-common-dir");
    expect(layer).toContain("2. [medium] worktrees collide");
  });

  it("notes when the prior was formed without repo context", () => {
    const layer = renderHypothesisLayer({ ...HYPOTHESIS, repoContextPresent: false });
    expect(layer).toContain("Repo context was unavailable");
  });

  it("assembles as a labelled layer after the base, never truncating the base under budget", () => {
    const assembled = assemblePrompt(
      {
        base: renderBaseInstruction(REVIEW_HYPOTHESIS_CONTRACT),
        hypothesis: renderHypothesisLayer(HYPOTHESIS),
        payload: "the payload",
      },
      { maxBytes: 200 },
    );
    // The base is always included in full, whatever the budget.
    const baseLayer = assembled.layers.find((l) => l.layer === "base");
    expect(baseLayer?.included).toBe(true);
    // The hypothesis layer is the highest-priority optional layer (after base).
    const order = assembled.layers.map((l) => l.layer);
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("hypothesis"));
  });
});
