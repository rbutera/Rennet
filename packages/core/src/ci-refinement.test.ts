import type { CiFailure, RspTokenUsage } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { refineCiFailures } from "./ci-refinement";
import { createInvocationBudget } from "./invocation-budget";

const deterministic: CiFailure = {
  checkId: "check:core-test",
  checkName: "core:test",
  verdict: "change-caused",
  evidence: "pipeline.ts failed",
  implicatedPaths: ["packages/core/src/pipeline.ts"],
  classifiedBy: "deterministic",
};
const uncertain: CiFailure = {
  checkId: "check:acceptance",
  checkName: "acceptance",
  verdict: "unclassified",
  evidence: "snapshot mismatch",
  implicatedPaths: [],
  classifiedBy: "deterministic",
};

describe("refineCiFailures", () => {
  it("refines only unclassified failures, stamps model, and meters one shared-budget turn", async () => {
    const budget = createInvocationBudget(1);
    const tokens: RspTokenUsage = {
      input: 10,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
      total: 13,
    };
    const runTurn = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain('"checkName":"core:test"');
      expect(prompt).toContain('"checkName":"acceptance"');
      return {
        status: "emitted" as const,
        body: { classifications: [{ ref: "failure-1", verdict: "change-caused" }] },
        tokens,
      };
    });
    const result = await refineCiFailures({
      failures: [deterministic, uncertain],
      changedPaths: ["packages/core/src/pipeline.ts"],
      runTurn,
      budget,
    });
    expect(result.failures).toEqual([
      deterministic,
      { ...uncertain, verdict: "change-caused", classifiedBy: "model" },
    ]);
    expect(runTurn).toHaveBeenCalledOnce();
    expect(budget.consumed).toBe(1);
    expect(result.telemetry).toMatchObject({
      candidates: 1,
      turns: 1,
      refined: 1,
      budgetRefused: false,
      tokensSpent: tokens,
    });
  });

  it("never adopts a model-produced environmental verdict for an uncertain failure", async () => {
    const result = await refineCiFailures({
      failures: [uncertain],
      changedPaths: ["packages/core/src/pipeline.ts"],
      runTurn: async () => ({
        status: "emitted",
        body: { classifications: [{ ref: "failure-0", verdict: "environmental" }] },
      }),
    });
    expect(result.failures).toEqual([uncertain]);
    expect(result.telemetry).toMatchObject({ turns: 1, refined: 0 });
  });

  it("rejects an incomplete or extra result as a whole, never partially adopting it", async () => {
    const second = { ...uncertain, checkName: "browser" };
    const result = await refineCiFailures({
      failures: [deterministic, uncertain, second],
      changedPaths: ["packages/core/src/pipeline.ts"],
      runTurn: async () => ({
        status: "emitted",
        body: {
          classifications: [
            { ref: "failure-1", verdict: "change-caused" },
            { ref: "failure-0", verdict: "environmental" },
          ],
        },
      }),
    });
    expect(result.failures).toEqual([deterministic, uncertain, second]);
    expect(result.telemetry.refined).toBe(0);
    expect(result.telemetry.failureReason).toContain("invalid");
  });

  it("never lets a model demote a deterministic change-caused verdict", async () => {
    const result = await refineCiFailures({
      failures: [deterministic, uncertain],
      changedPaths: ["packages/core/src/pipeline.ts"],
      runTurn: async () => ({
        status: "emitted",
        body: {
          classifications: [
            { ref: "failure-0", verdict: "environmental" },
            { ref: "failure-1", verdict: "change-caused" },
          ],
        },
      }),
    });
    expect(result.failures).toEqual([deterministic, uncertain]);
  });

  it("degrades a shared-budget refusal without running a turn", async () => {
    const budget = createInvocationBudget(0);
    const runTurn = vi.fn();
    const result = await refineCiFailures({
      failures: [uncertain],
      changedPaths: [],
      runTurn,
      budget,
    });
    expect(result.failures).toEqual([uncertain]);
    expect(result.telemetry).toMatchObject({
      candidates: 1,
      turns: 0,
      refined: 0,
      budgetRefused: true,
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("degrades a failed or throwing turn without changing deterministic results", async () => {
    const failed = await refineCiFailures({
      failures: [uncertain],
      changedPaths: [],
      runTurn: async () => ({ status: "failed", message: "seat unavailable" }),
    });
    const thrown = await refineCiFailures({
      failures: [uncertain],
      changedPaths: [],
      runTurn: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(failed.failures).toEqual([uncertain]);
    expect(failed.telemetry.failureReason).toContain("seat unavailable");
    expect(thrown.failures).toEqual([uncertain]);
    expect(thrown.telemetry.failureReason).toContain("spawn failed");
  });
});
