import type { DecompositionBlockingState, FlaggedReview } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { stampBlockingStates } from "./flagged-blocking-states";

const blockingStates: DecompositionBlockingState[] = [
  {
    reason: "binary",
    path: "assets/logo.png",
    detail: "assets/logo.png: binary file; its content was not ingested.",
  },
];
const decomposition = { blockingStates };

describe("stampBlockingStates", () => {
  it("stamps the deterministic blockers onto an ok review", () => {
    const result: FlaggedReview = { status: "ok", findings: [] };
    expect(stampBlockingStates(result, decomposition)).toEqual({
      status: "ok",
      findings: [],
      blockingStates,
    });
  });

  it("stamps the deterministic blockers onto a failed review", () => {
    const result: FlaggedReview = { status: "failed", reason: "model unavailable" };
    expect(stampBlockingStates(result, decomposition)).toEqual({
      status: "failed",
      reason: "model unavailable",
      blockingStates,
    });
  });
});
