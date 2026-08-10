import { askReview } from "@rennet/core";
import { describe, expect, it } from "vitest";
import {
  codexAskFixture,
  orchestratorAskFixture,
  reviewAskFixturePorts,
} from "./review-ask-fixture";

// The fixture (issue #139) stands behind the REAL boundary: the deferred half is
// the live model invocation, so here we drive the REAL core `askReview` router with
// the fixture ports and prove the whole command comes alive with canned answers —
// orchestrator once, both adds Codex, never a synthesis — exactly as it will with
// live sessions once they replace the ports.

describe("review-ask fixture — driven through the real router", () => {
  it("orchestrator mode returns ONLY the orchestrator's canned answer", async () => {
    const result = await askReview("orchestrator", "is the retry-after seconds or ms?", {
      askOrchestrator: orchestratorAskFixture,
      askCodex: codexAskFixture,
    });
    expect(result.mode).toBe("orchestrator");
    expect(result.primary.model).toBe("Orchestrator · Claude");
    expect(result.primary.answer).toMatch(/milliseconds/i);
    expect(result.secondOpinion).toBeUndefined();
  });

  it("both mode returns two DISTINCT labelled answers, orchestrator + codex, no third", async () => {
    const result = await askReview("both", "does the client agree?", {
      askOrchestrator: orchestratorAskFixture,
      askCodex: codexAskFixture,
    });
    expect(result.mode).toBe("both");
    expect(result.primary.model).toBe("Orchestrator · Claude");
    expect(result.secondOpinion?.model).toBe("codex");
    expect(result.primary.answer).not.toBe(result.secondOpinion?.answer);
    expect(Object.keys(result).sort()).toEqual(["mode", "primary", "secondOpinion"]);
  });

  it("the dispatch-dep-shaped ports ignore reviewId and delegate to the bare fixtures", async () => {
    const ports = reviewAskFixturePorts();
    const primary = await ports.askOrchestrator({ reviewId: "review-1", question: "q" });
    const second = await ports.askCodex({ reviewId: "review-1", question: "q" });
    expect(primary.model).toBe("Orchestrator · Claude");
    expect(second.model).toBe("codex");
  });
});
