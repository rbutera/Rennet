import type { Decomposition, DecompositionChunk } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildRoutePlan, DEFAULT_MAX_HARNESS_INVOCATIONS } from "./route-plan";

function substantiveChunk(index: number): DecompositionChunk {
  return {
    chunkId: `c${index}`,
    kind: "substantive",
    title: `chunk ${index}`,
    layer: 2,
    filePaths: [`f${index}.ts`],
    hunkIds: [`h${index}`],
    changedLoc: 1,
  };
}

function decompositionWith(chunks: DecompositionChunk[]): Decomposition {
  return {
    patchsetId: "ps_1",
    hunks: [],
    classifications: [],
    chunks,
    edges: [],
    readingOrder: chunks.map((chunk) => chunk.chunkId),
    residue: [],
    ingestionGaps: [],
  };
}

function withSubstantiveChunks(n: number): Decomposition {
  return decompositionWith(Array.from({ length: n }, (_, i) => substantiveChunk(i + 1)));
}

describe("buildRoutePlan — the budget is a mechanical gate", () => {
  it("plans skeleton + proposal + batched rationale within budget", () => {
    const result = buildRoutePlan(withSubstantiveChunks(5));
    expect(result.refused).toBe(false);
    if (result.refused) return;
    const purposes = result.invocations.map((invocation) => invocation.purpose);
    expect(purposes[0]).toBe("skeleton");
    expect(purposes[1]).toBe("proposal");
    expect(purposes.filter((purpose) => purpose === "rationale")).toHaveLength(1);
    expect(result.harnessInvocationCount).toBe(3);
  });

  it("keeps the largest fixture (30 chunks) within five invocations", () => {
    const result = buildRoutePlan(withSubstantiveChunks(30));
    expect(result.refused).toBe(false);
    if (result.refused) return;
    // 30 chunks -> 3 rationale batches (10 each) + skeleton + proposal = 5.
    expect(result.harnessInvocationCount).toBe(5);
    expect(result.harnessInvocationCount).toBeLessThanOrEqual(DEFAULT_MAX_HARNESS_INVOCATIONS);
  });

  it("refuses a seeded sixth invocation (31 chunks -> 4 batches + 2 = 6)", () => {
    const result = buildRoutePlan(withSubstantiveChunks(31));
    expect(result.refused).toBe(true);
    if (!result.refused) return;
    expect(result.harnessInvocationCount).toBe(6);
    expect(result.maxHarnessInvocations).toBe(5);
    expect(result.reason).toContain("6");
    expect(result.reason).toContain("5");
  });

  it("does not count appendix (mechanical) chunks toward the plan", () => {
    const chunks = [substantiveChunk(1), substantiveChunk(2)];
    const appendix: DecompositionChunk = {
      chunkId: "cLock",
      kind: "appendix",
      title: "pnpm-lock.yaml",
      layer: 6,
      filePaths: ["pnpm-lock.yaml"],
      hunkIds: ["hLock"],
      changedLoc: 0,
    };
    const result = buildRoutePlan(decompositionWith([...chunks, appendix]));
    expect(result.refused).toBe(false);
    if (result.refused) return;
    // Two substantive chunks -> one rationale batch; the lockfile appendix adds none.
    expect(result.harnessInvocationCount).toBe(3);
  });
});
