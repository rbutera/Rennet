import type { InvocationBudget, Patchset, RspCapabilitySnapshot } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import type { CodexUtilityPort } from "./codex-utility-port";
import { decompose } from "./decomposition";
import { VERIFIER_UNAVAILABLE_CAVEAT } from "./finding-verification";
import { createInvocationBudget } from "./invocation-budget";
import {
  buildReviewCanvases as buildReviewCanvasesCore,
  type ReviewPipelineInput,
} from "./pipeline";
import {
  DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
  reviewInvocationCeiling,
} from "./review-intelligence-budget";

type TestPipelineInput = Omit<ReviewPipelineInput, "budget"> & { budget?: InvocationBudget };

function buildReviewCanvases(input: TestPipelineInput) {
  const { budget = createInvocationBudget(12), ...rest } = input;
  return buildReviewCanvasesCore({ ...rest, budget });
}

const PATCHSET: Patchset = {
  id: "ps_intelligence",
  createdAt: "2026-08-15T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    {
      path: "src/store.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patch:
        "diff --git a/src/store.ts b/src/store.ts\n--- a/src/store.ts\n+++ b/src/store.ts\n@@ -1,1 +1,2 @@\n export const store = new Map();\n+export const key = branch;\n",
    },
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
};

const HUNK_ID = buildOfferedManifest(decompose(PATCHSET)).occurrences.find(
  (occurrence) => occurrence.kind === "hunk",
)?.id;
if (!HUNK_ID) throw new Error("expected an offered hunk");
const FINDING_ANCHOR = `rennet:hunk/${HUNK_ID}`;

const PROVENANCE = {
  harness: "claude-code",
  harnessVersion: "test",
  adapterVersion: "test",
  model: "claude-test",
  modelReportedBy: "config" as const,
  capability: CAPABILITY,
};

function hypothesisBody(): unknown {
  return {
    domain: "repository store keying",
    scope: { inScope: ["store identity"], outOfScope: [] },
    designExpectation: "key state by repository root",
    risks: Array.from({ length: 6 }, (_, index) => ({
      statement: `repository branch key collision ${index}`,
      severity: "high",
      disconfirmer: `check repository branch key isolation ${index}`,
    })),
  };
}

function findingBody(anchor: string): unknown {
  return {
    findings: [
      {
        anchor,
        summary: "repository branch key collision leaks store state",
        severity: "high",
      },
    ],
  };
}

function codexPort(body: () => unknown, calls: string[]): CodexUtilityPort {
  return {
    complete: async (request: Parameters<CodexUtilityPort["complete"]>[0]) => {
      calls.push("codex");
      return {
        status: "admitted",
        document: {
          rsp: 1,
          docType: request.docType,
          schemaVersion: 1,
          docId: "codex-doc",
          patchsetId: PATCHSET.id,
          provenance: {
            harness: "codex",
            harnessVersion: "test",
            adapterVersion: "test",
            model: request.model ?? "codex-test",
            modelReportedBy: "config",
            tier: "heavy",
            route: "agentic",
            runId: "codex-run",
            inputDigest: "digest",
            capability: CAPABILITY,
            tokens: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: null,
              total: 0,
            },
            reportedUsd: null,
            derivedUsd: null,
          },
          body: body(),
          x: {},
        },
        report: { admitted: true, errors: [], rejectedCount: 0 },
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: null,
          total: 0,
        },
        attempts: [],
      };
    },
  } as unknown as CodexUtilityPort;
}

describe("ReviewIntelligenceBudget defaults", () => {
  it("sets Rai-adjustable defaults without creating independent counters", () => {
    expect(DEFAULT_REVIEW_INTELLIGENCE_BUDGET).toEqual({
      totalInvocations: 12,
      quickReviewInvocations: 6,
      hypothesis: { maxTurns: 1 },
      dualModel: { enabled: true, lenses: ["flagged"] },
      verification: { maxVerifications: 6, batchSize: 3 },
      adjudication: { maxAdjudications: 4 },
    });
    expect(reviewInvocationCeiling(DEFAULT_REVIEW_INTELLIGENCE_BUDGET, true)).toBe(12);
    expect(reviewInvocationCeiling(DEFAULT_REVIEW_INTELLIGENCE_BUDGET, false)).toBe(6);
  });
});

describe("buildReviewCanvases review-intelligence sequence", () => {
  it("runs the deep sequence in order and meters every stage on one counter", async () => {
    const calls: string[] = [];
    const sessionBudget = createInvocationBudget(12);
    const result = await buildReviewCanvases({
      reviewId: "review-deep",
      patchset: PATCHSET,
      dispositions: [],
      budget: sessionBudget,
      provenance: PROVENANCE,
      council: { availability: { installed: ["claude-code", "codex"] } },
      hypothesisConfig: {
        runTurn: async () => {
          calls.push("hypothesis");
          return { status: "emitted", body: hypothesisBody() };
        },
      },
      dualModelConfig: {
        deepReviewOn: true,
        codexPort: codexPort(() => findingBody(FINDING_ANCHOR), calls),
        runFindingTurn: async () => {
          calls.push("claude");
          return { status: "emitted", body: findingBody(FINDING_ANCHOR) };
        },
      },
      verificationConfig: {
        readFileWindow: async () => ({
          path: "src/store.ts",
          startLine: 1,
          endLine: 2,
          text: "export const store = new Map();\nexport const key = branch;",
        }),
        runTurn: async () => {
          calls.push("verification");
          return {
            status: "emitted",
            body: {
              verifications: [
                { ref: "f1", verdict: "reproduced", evidence: "branch key is shared" },
              ],
            },
          };
        },
      },
      mintDocId: (() => {
        let next = 0;
        return () => `0000000000000000000000000${next++}`.slice(-26);
      })(),
      newRunId: () => "run-test",
    });

    expect(calls).toEqual(["hypothesis", "claude", "codex", "verification"]);
    expect(result.invocationBudget.max).toBe(12);
    expect(result.invocationBudget).toBe(sessionBudget);
    expect(result.invocationBudget.consumed).toBe(4);
    expect(result.hypothesis).toBeDefined();
    expect(result.crossCheckRisks?.some((risk) => risk.status === "confirmed")).toBe(true);
    const findingDoc = result.admittedDocs.find((doc) => doc.docType === "finding");
    expect(findingDoc).toBeDefined();
    if (!findingDoc) throw new Error("expected an admitted finding document");
    const findings = (findingDoc.body as { findings?: Array<Record<string, unknown>> }).findings;
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.agreement).toEqual({ kind: "concur", agree: 2, total: 2 });
    expect(findings?.[0]?.verification).toEqual({
      verdict: "reproduced",
      evidence: "branch key is shared",
    });
  });

  it("keeps quick review cheap: hypothesis and one Flagged seat, never dual or verification", async () => {
    const calls: string[] = [];
    const result = await buildReviewCanvases({
      reviewId: "review-quick",
      patchset: PATCHSET,
      dispositions: [],
      budget: createInvocationBudget(6),
      provenance: PROVENANCE,
      council: { availability: { installed: ["claude-code", "codex"] } },
      hypothesisConfig: {
        runTurn: async () => {
          calls.push("hypothesis");
          return { status: "emitted", body: hypothesisBody() };
        },
      },
      dualModelConfig: {
        deepReviewOn: false,
        codexPort: codexPort(() => findingBody(FINDING_ANCHOR), calls),
        runFindingTurn: async () => {
          calls.push("claude");
          return { status: "emitted", body: findingBody(FINDING_ANCHOR) };
        },
      },
      verificationConfig: {
        readFileWindow: async () => {
          throw new Error("quick review must not read verification content");
        },
        runTurn: async () => {
          calls.push("verification");
          return { status: "failed", message: "must not run" };
        },
      },
    });

    expect(calls).toEqual(["hypothesis", "claude"]);
    expect(result.invocationBudget.max).toBe(6);
    expect(result.invocationBudget.consumed).toBe(2);
  });

  it("surfaces a shared-budget refusal as an inconclusive verification floor", async () => {
    const budget = {
      ...DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
      totalInvocations: 3,
    };
    const result = await buildReviewCanvases({
      reviewId: "review-refused",
      patchset: PATCHSET,
      dispositions: [],
      provenance: PROVENANCE,
      council: { availability: { installed: ["claude-code", "codex"] } },
      reviewIntelligenceBudget: budget,
      budget: createInvocationBudget(3),
      hypothesisConfig: {
        runTurn: async () => ({ status: "emitted", body: hypothesisBody() }),
      },
      dualModelConfig: {
        deepReviewOn: true,
        codexPort: codexPort(() => findingBody(FINDING_ANCHOR), []),
        runFindingTurn: async () => {
          return { status: "emitted", body: findingBody(FINDING_ANCHOR) };
        },
      },
      verificationConfig: {
        readFileWindow: async () => ({
          path: "src/store.ts",
          startLine: 1,
          endLine: 2,
          text: "export const key = branch;",
        }),
        runTurn: async () => {
          throw new Error("the shared budget must refuse before this turn");
        },
      },
    });

    expect(result.budgetRefused).toBe(true);
    expect(result.invocationBudget.consumed).toBe(3);
    const findingDoc = result.admittedDocs.find((doc) => doc.docType === "finding");
    expect(findingDoc).toBeDefined();
    if (!findingDoc) throw new Error("expected an admitted finding document");
    const findings = (findingDoc.body as { findings?: Array<Record<string, unknown>> }).findings;
    expect(findings?.[0]?.verification).toMatchObject({
      verdict: "inconclusive",
      evidence: expect.stringContaining("budget was exhausted"),
    });
  });

  it("surfaces non-obvious findings as verification-unavailable when deep review has no verifier", async () => {
    const result = await buildReviewCanvases({
      reviewId: "review-no-verifier",
      patchset: PATCHSET,
      dispositions: [],
      provenance: PROVENANCE,
      council: { availability: { installed: ["claude-code"] } },
      dualModelConfig: {
        deepReviewOn: true,
        runFindingTurn: async () => ({
          status: "emitted",
          body: findingBody(FINDING_ANCHOR),
        }),
      },
    });

    const findingDoc = result.admittedDocs.find((doc) => doc.docType === "finding");
    expect(findingDoc).toBeDefined();
    if (!findingDoc) throw new Error("expected an admitted finding document");
    const findings = (findingDoc.body as { findings?: Array<Record<string, unknown>> }).findings;
    expect(findings?.[0]?.verification).toEqual({
      verdict: "inconclusive",
      evidence: VERIFIER_UNAVAILABLE_CAVEAT,
    });
  });

  it("keeps the intelligence ceiling canonical when the legacy route-plan ceiling is higher", async () => {
    const result = await buildReviewCanvases({
      reviewId: "review-conflicting-ceilings",
      patchset: PATCHSET,
      dispositions: [],
      reviewIntelligenceBudget: {
        ...DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
        totalInvocations: 3,
      },
      budget: createInvocationBudget(3),
      routePlanOptions: { maxHarnessInvocations: 12 },
    });

    expect(result.routePlan.maxHarnessInvocations).toBe(3);
    expect(result.invocationBudget.max).toBe(3);
  });
});

// The canvas pipeline carries verified disagree rows without adjudicating them.
// Adjudication is a live desktop post-hoc enrichment; keeping a second optional
// pipeline path here would be dead configuration with no production caller.

function findingDoc(result: Awaited<ReturnType<typeof buildReviewCanvasesCore>>) {
  const doc = result.admittedDocs.find((d) => d.docType === "finding");
  if (!doc) throw new Error("expected an admitted finding document");
  return (doc.body as { findings: Array<Record<string, unknown>> }).findings;
}

describe("buildReviewCanvases adjudication ownership (#41)", () => {
  it("with no adjudication config the disagree row surfaces unadjudicated and the review completes", async () => {
    const result = await buildReviewCanvases({
      reviewId: "review-no-adjudicator",
      patchset: PATCHSET,
      dispositions: [],
      budget: createInvocationBudget(12),
      provenance: PROVENANCE,
      council: { availability: { installed: ["claude-code", "codex"] } },
      dualModelConfig: {
        deepReviewOn: true,
        codexPort: codexPort(() => ({ findings: [] }), []),
        runFindingTurn: async () => ({ status: "emitted", body: findingBody(FINDING_ANCHOR) }),
      },
      verificationConfig: {
        readFileWindow: async () => ({
          path: "src/store.ts",
          startLine: 1,
          endLine: 2,
          text: "export const key = branch;",
        }),
        runTurn: async () => ({
          status: "emitted",
          body: { verifications: [{ ref: "f1", verdict: "reproduced", evidence: "kept" }] },
        }),
      },
    });
    const findings = findingDoc(result);
    expect(findings).toHaveLength(1);
    const agreement = findings[0]?.agreement as Record<string, unknown>;
    expect(agreement.kind).toBe("disagree");
    expect(agreement.adjudication).toBeUndefined();
  });
});
