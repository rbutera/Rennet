import type { PromptContextFile } from "@rennet/prompts";
import type { CiFailure, RspTokenUsage } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refineCiFailures } from "./ci-refinement";
import type { TurnContextWriter } from "./harness-run-turn";
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

/** The directory the fake writer answers with; the prompt's pointer path is built on it. */
const CONTEXT_DIR = ".rennet/context/sess_test";

let contextWrites: PromptContextFile[] = [];
const writeContext: TurnContextWriter = (files) => {
  contextWrites = [...contextWrites, ...files];
  return CONTEXT_DIR;
};
const names = () => contextWrites.map((file) => file.name);
const bodyOf = (name: string) => contextWrites.find((file) => file.name === name)?.body;

beforeEach(() => {
  contextWrites = [];
});

describe("refineCiFailures", () => {
  it("writes the pointer file naming each failure's evidence — the WRITER call", async () => {
    await refineCiFailures({
      failures: [deterministic, uncertain],
      changedPaths: ["packages/core/src/pipeline.ts", "packages/server/src/ci-signal.ts"],
      writeContext,
      runTurn: async () => ({ status: "failed", message: "not the subject here" }),
    });
    // Paths inside the pointer file resolve beside it, which is where it says they do.
    expect(bodyOf("ci-pointers.json")).toBe(
      JSON.stringify({
        turn: "ci-failure-classification",
        pathsRelativeTo: "this file's directory",
        changedPaths: "ci-classification/changed-paths.txt",
        failures: [
          {
            ref: "failure-1",
            checkName: "acceptance",
            evidence: "ci-classification/evidence/failure-1.txt",
          },
        ],
      }),
    );
    expect(bodyOf("ci-classification/changed-paths.txt")).toBe(
      "packages/core/src/pipeline.ts\npackages/server/src/ci-signal.ts\n",
    );
  });

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
      // The prompt names the pointer file and carries no failure data at all — the
      // check names, the evidence and the changed paths are files the turn reads.
      expect(prompt).toContain(`${CONTEXT_DIR}/ci-pointers.json`);
      expect(prompt).not.toContain("acceptance");
      expect(prompt).not.toContain("snapshot mismatch");
      // Only the UNCLASSIFIED failure's evidence is offered; the deterministic one is
      // settled and pays for nothing.
      expect(bodyOf("ci-classification/evidence/failure-1.txt")).toBe("snapshot mismatch");
      expect(names()).not.toContain("ci-classification/evidence/failure-0.txt");
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
      writeContext,
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
      writeContext,
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
      writeContext,
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
      writeContext,
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
      writeContext,
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
      writeContext,
      runTurn: async () => ({ status: "failed", message: "seat unavailable" }),
    });
    const thrown = await refineCiFailures({
      failures: [uncertain],
      changedPaths: [],
      writeContext,
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
