import { describe, expect, it } from "vitest";
import {
  type CoverageHunkInput,
  type CoverageRequirementInput,
  runCoverageMapping,
} from "./coverage-mapping";
import type { HarnessTurnResult } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";

const REQUIREMENTS: CoverageRequirementInput[] = [
  {
    capability: "review-hypothesis-pass",
    name: "A hypothesis is committed before the runners read the diff",
    statement: "The system SHALL run a hypothesis pre-read pass.",
    scenarios: ["The hypothesis is produced from intent"],
  },
  {
    capability: "review-hypothesis-pass",
    name: "The pass degrades honestly when context is absent",
    statement: "The pass SHALL never fabricate an input.",
    scenarios: [],
  },
];

const HUNKS: CoverageHunkInput[] = [
  {
    id: "h1",
    filePath: "src/hypothesis.ts",
    addedLines: ["export function run() {}"],
    deletedLines: [],
  },
  { id: "h2", filePath: "src/hypothesis.test.ts", addedLines: ["it('runs')"], deletedLines: [] },
];

/** An injected turn that emits a fixed body (one attempt), for the grounding tests. */
function emit(body: unknown): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return () => Promise.resolve({ status: "emitted", body });
}

function budget() {
  return createInvocationBudget(4);
}

describe("runCoverageMapping — grounding + completeness", () => {
  it("maps a requirement to its grounded hunks (as rennet:hunk anchors) + test count", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      runTurn: emit({
        mappings: [
          {
            capability: "review-hypothesis-pass",
            requirement: "A hypothesis is committed before the runners read the diff",
            hunks: ["h1", "h2"],
            tests: 1,
          },
          {
            capability: "review-hypothesis-pass",
            requirement: "The pass degrades honestly when context is absent",
            hunks: [],
            tests: 0,
          },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.edges).toEqual([
      {
        capability: "review-hypothesis-pass",
        requirement: "A hypothesis is committed before the runners read the diff",
        hunks: ["rennet:hunk/h1", "rennet:hunk/h2"],
        tests: 1,
      },
      {
        capability: "review-hypothesis-pass",
        requirement: "The pass degrades honestly when context is absent",
        hunks: [],
        tests: 0,
      },
    ]);
  });

  it("DROPS a hallucinated hunk the model named but was never offered", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: [REQUIREMENTS[0] as CoverageRequirementInput],
      hunks: HUNKS,
      budget: budget(),
      runTurn: emit({
        mappings: [
          {
            capability: "review-hypothesis-pass",
            requirement: "A hypothesis is committed before the runners read the diff",
            // h1 is offered, "ghost" is not: only h1 survives grounding.
            hunks: ["h1", "ghost", "h1"],
            tests: 0,
          },
        ],
      }),
    });
    expect(result.edges[0]?.hunks).toEqual(["rennet:hunk/h1"]);
  });

  it("gives a requirement the model OMITTED an honest computed zero (unimplemented)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      // The model mapped only the first requirement; the second must still get an edge.
      runTurn: emit({
        mappings: [
          {
            capability: "review-hypothesis-pass",
            requirement: "A hypothesis is committed before the runners read the diff",
            hunks: ["h1"],
            tests: 0,
          },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.edges).toHaveLength(2);
    expect(result.edges[1]).toEqual({
      capability: "review-hypothesis-pass",
      requirement: "The pass degrades honestly when context is absent",
      hunks: [],
      tests: 0,
    });
  });

  it("clamps a negative or fractional test count to a non-negative integer", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: [REQUIREMENTS[0] as CoverageRequirementInput],
      hunks: HUNKS,
      budget: budget(),
      runTurn: emit({
        mappings: [
          {
            capability: "review-hypothesis-pass",
            requirement: "A hypothesis is committed before the runners read the diff",
            hunks: ["h1"],
            tests: 2.9,
          },
        ],
      }),
    });
    expect(result.edges[0]?.tests).toBe(2);
  });
});

describe("runCoverageMapping — the ran / did-not-run boundary (honest chips)", () => {
  it("returns an empty OK when there are no requirements (nothing to map, no turn)", async () => {
    let called = false;
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: [],
      hunks: HUNKS,
      budget: budget(),
      runTurn: () => {
        called = true;
        return Promise.resolve({ status: "emitted", body: { mappings: [] } });
      },
    });
    expect(result).toEqual({ status: "ok", edges: [] });
    expect(called).toBe(false);
  });

  it("FAILS (no fabricated zeros) when an ABSENT budget refuses the turn", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      // No budget: fail-closed money circuit (Rule 75). No turn runs.
      runTurn: emit({ mappings: [] }),
    });
    expect(result.status).toBe("failed");
    expect(result.edges).toEqual([]);
  });

  it("FAILS when every turn fails (no all-unimplemented masquerade)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      maxRetries: 1,
      runTurn: () => Promise.resolve({ status: "failed", message: "seat down" }),
    });
    expect(result.status).toBe("failed");
    expect(result.edges).toEqual([]);
  });

  it("FAILS when the body carries no usable mappings array (a garbled zero is not a real zero)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      maxRetries: 0,
      // Completed turn, but the structured output has no `mappings` array.
      runTurn: emit({ notMappings: true }),
    });
    expect(result.status).toBe("failed");
    expect(result.edges).toEqual([]);
  });

  it("retries a failed turn, then succeeds on the second attempt", async () => {
    let attempt = 0;
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: [REQUIREMENTS[0] as CoverageRequirementInput],
      hunks: HUNKS,
      budget: budget(),
      maxRetries: 1,
      runTurn: () => {
        attempt += 1;
        if (attempt === 1) return Promise.resolve({ status: "failed", message: "transient" });
        return Promise.resolve({
          status: "emitted",
          body: {
            mappings: [
              {
                capability: "review-hypothesis-pass",
                requirement: "A hypothesis is committed before the runners read the diff",
                hunks: ["h1"],
                tests: 1,
              },
            ],
          },
        });
      },
    });
    expect(attempt).toBe(2);
    expect(result.status).toBe("ok");
    expect(result.edges[0]?.hunks).toEqual(["rennet:hunk/h1"]);
  });
});
