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

// h1 implements; h2 + h3 are two hunks in ONE test file; h4 is a second test file.
const HUNKS: CoverageHunkInput[] = [
  {
    id: "h1",
    filePath: "src/hypothesis.ts",
    addedLines: ["export function run() {}"],
    deletedLines: [],
  },
  { id: "h2", filePath: "src/hypothesis.test.ts", addedLines: ["it('runs')"], deletedLines: [] },
  {
    id: "h3",
    filePath: "src/hypothesis.test.ts",
    addedLines: ["it('degrades')"],
    deletedLines: [],
  },
  { id: "h4", filePath: "src/other.test.ts", addedLines: ["it('covers')"], deletedLines: [] },
];

/** An injected turn that emits a fixed body (one attempt), for the grounding tests. */
function emit(body: unknown): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return () => Promise.resolve({ status: "emitted", body });
}

function budget() {
  return createInvocationBudget(4);
}

const FIRST = "A hypothesis is committed before the runners read the diff";
const SECOND = "The pass degrades honestly when context is absent";

describe("runCoverageMapping — grounding + completeness", () => {
  it("maps a requirement to its grounded hunks (as rennet:hunk anchors) + grounded test count", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      runTurn: emit({
        mappings: [
          {
            capability: "review-hypothesis-pass",
            requirement: FIRST,
            hunks: ["h1"],
            // h2 + h3 are one test FILE, h4 another ⇒ 2 distinct tests.
            testHunks: ["h2", "h3", "h4"],
          },
          {
            capability: "review-hypothesis-pass",
            requirement: SECOND,
            hunks: [],
            testHunks: [],
          },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.edges).toEqual([
      {
        capability: "review-hypothesis-pass",
        requirement: FIRST,
        hunks: ["rennet:hunk/h1"],
        tests: 2,
      },
      {
        capability: "review-hypothesis-pass",
        requirement: SECOND,
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
            requirement: FIRST,
            // h1 is offered, "ghost" is not: only h1 survives grounding.
            hunks: ["h1", "ghost", "h1"],
            testHunks: [],
          },
        ],
      }),
    });
    expect(result.edges[0]?.hunks).toEqual(["rennet:hunk/h1"]);
  });

  it("GROUNDS the test count: a ghost test hunk is dropped, one file counts once", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: [REQUIREMENTS[0] as CoverageRequirementInput],
      hunks: HUNKS,
      budget: budget(),
      runTurn: emit({
        mappings: [
          {
            capability: "review-hypothesis-pass",
            requirement: FIRST,
            hunks: ["h1"],
            // h2 + h3 are the SAME file (count once); "ghostTest" was never offered.
            testHunks: ["h2", "h3", "ghostTest"],
          },
        ],
      }),
    });
    // One distinct grounded test file ⇒ tests: 1 — never the 3 the model listed.
    expect(result.edges[0]?.tests).toBe(1);
  });

  it("does NOT count an IMPLEMENTATION file the model cited as a test (no impl inflation)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: [REQUIREMENTS[0] as CoverageRequirementInput],
      hunks: HUNKS,
      budget: budget(),
      runTurn: emit({
        mappings: [
          {
            capability: "review-hypothesis-pass",
            requirement: FIRST,
            hunks: ["h1"],
            // h1 is src/hypothesis.ts — an offered hunk, but an IMPLEMENTATION file,
            // not a test. It must not count toward the test total.
            testHunks: ["h1"],
          },
        ],
      }),
    });
    expect(result.edges[0]?.tests).toBe(0);
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
            requirement: FIRST,
            hunks: ["h1"],
            testHunks: [],
          },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.edges).toHaveLength(2);
    expect(result.edges[1]).toEqual({
      capability: "review-hypothesis-pass",
      requirement: SECOND,
      hunks: [],
      tests: 0,
    });
  });

  it("KEEPS a genuine all-unimplemented (entries join real requirements, empty hunks)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      // The model EXPLICITLY mapped each requirement to nothing — a real verdict.
      runTurn: emit({
        mappings: [
          { capability: "review-hypothesis-pass", requirement: FIRST, hunks: [], testHunks: [] },
          { capability: "review-hypothesis-pass", requirement: SECOND, hunks: [], testHunks: [] },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.edges.map((edge) => edge.hunks)).toEqual([[], []]);
    expect(result.edges.map((edge) => edge.tests)).toEqual([0, 0]);
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

  it("runs the turn UNGATED when NO budget is provided (#260) — no short-circuit refusal", async () => {
    let ran = false;
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      // #260: no budget means no ceiling, so the turn RUNS. An empty mappings body
      // still fails the garbled-zero guard, but because it ran and produced nothing
      // real — NOT because an absent budget short-circuited it.
      runTurn: () => {
        ran = true;
        return Promise.resolve({ status: "emitted", body: { mappings: [] } });
      },
    });
    expect(ran).toBe(true);
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

  it("FAILS when the body carries no mappings array at all (a garbled zero is not a real zero)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      maxRetries: 0,
      runTurn: emit({ notMappings: true }),
    });
    expect(result.status).toBe("failed");
    expect(result.edges).toEqual([]);
  });

  // The three ways a completed turn can carry ZERO usable mappings — each MUST fail
  // (no chips), never a confident all-unimplemented (codex P1).
  it("FAILS on an EMPTY mappings array (the model said nothing, not 'all unimplemented')", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      maxRetries: 0,
      runTurn: emit({ mappings: [] }),
    });
    expect(result.status).toBe("failed");
    expect(result.edges).toEqual([]);
  });

  it("FAILS when every mapping entry is MALFORMED (all filtered out)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      maxRetries: 0,
      // No entry has a string capability + requirement ⇒ all dropped ⇒ zero usable.
      runTurn: emit({ mappings: [{ nope: true }, { capability: 5, requirement: 6 }] }),
    });
    expect(result.status).toBe("failed");
    expect(result.edges).toEqual([]);
  });

  it("FAILS when no mapping entry joins a real requirement (all unknown identities)", async () => {
    const result = await runCoverageMapping({
      patchsetId: "ps-1",
      requirements: REQUIREMENTS,
      hunks: HUNKS,
      budget: budget(),
      maxRetries: 0,
      // Well-formed entries, but for requirements that DON'T exist in this change.
      runTurn: emit({
        mappings: [
          {
            capability: "ghost-cap",
            requirement: "a made-up requirement",
            hunks: ["h1"],
            testHunks: [],
          },
        ],
      }),
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
                requirement: FIRST,
                hunks: ["h1"],
                testHunks: [],
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
