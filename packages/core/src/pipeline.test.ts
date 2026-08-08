import type {
  CouncilModel,
  OrderingBody,
  PatchFile,
  Patchset,
  RspEnvelope,
  RspProvenance,
  RspTokenUsage,
  ValidationReport,
} from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import type { DecompositionTurnResult } from "./angle-generation";
import { deterministicProposalBody } from "./angle-generation";
import type {
  CodexUtilityCompleteRequest,
  CodexUtilityPort,
  CodexUtilityResult,
} from "./codex-utility-port";
import { decompose } from "./decomposition";
import type { OrderingTurnResult } from "./ordering-pass";
import { buildReviewCanvases } from "./pipeline";

// ── Fake Codex port helpers (model calls are mocked in CI) ────────────────────

const CODEX_MODELS: ReadonlySet<CouncilModel> = new Set<CouncilModel>([
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

const ZERO_TOKENS: RspTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 0,
};

function fakeReport(admitted: boolean): ValidationReport {
  return {
    docType: null,
    admission: "atomic",
    admitted,
    errors: admitted ? [] : [{ code: "V000", pointer: "/body", message: "codex rejected" }],
    admittedItemCount: null,
    rejectedItemCount: 0,
    rejectedItems: [],
  };
}

const CODEX_PROVENANCE: RspProvenance = {
  harness: "codex",
  harnessVersion: "unknown",
  adapterVersion: "0.1.0",
  model: "gpt-5.6-terra",
  modelReportedBy: "config",
  tier: "light",
  route: "utility",
  runId: "codex-run",
  inputDigest: "digest",
  capability: {
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
  },
  tokens: ZERO_TOKENS,
  reportedUsd: null,
  derivedUsd: null,
};

function codexEnvelope(req: CodexUtilityCompleteRequest, body: unknown): RspEnvelope {
  return {
    rsp: 1,
    docType: req.docType,
    schemaVersion: 1,
    docId: "CODEXDOC",
    patchsetId: req.patchset.id,
    provenance: CODEX_PROVENANCE,
    body,
    x: {},
  };
}

/** A fake CodexUtilityPort that admits a per-request body, recording every call. */
function admittingCodexPort(bodyFor: (req: CodexUtilityCompleteRequest) => unknown): {
  port: CodexUtilityPort;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(
    async (req: CodexUtilityCompleteRequest): Promise<CodexUtilityResult> => ({
      status: "admitted",
      document: codexEnvelope(req, bodyFor(req)),
      report: fakeReport(true),
      tokens: ZERO_TOKENS,
      attempts: [],
    }),
  );
  return { port: { complete }, complete };
}

/** A fake CodexUtilityPort that always rejects, recording every call. */
function rejectingCodexPort(): {
  port: CodexUtilityPort;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(
    async (): Promise<CodexUtilityResult> => ({
      status: "rejected",
      report: fakeReport(false),
      attempts: [],
    }),
  );
  return { port: { complete }, complete };
}

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 3, deletions: 1, binary: false, patch };
}

function patchsetOf(id: string, files: PatchFile[]): Patchset {
  return {
    id,
    createdAt: "2026-08-07T00:00:00.000Z",
    repository,
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

// A diff where gamma.ts imports alpha.ts → the floor derives an edge c1 -> c2.
const ALPHA = `@@ -1,3 +1,6 @@
 export function alpha() {
-  return 1;
+  const value = compute(2);
+  logger.info(value);
+  return value;
 }
+
+export const beta = () => alpha() + 1;`;
const GAMMA = `@@ -1,2 +1,5 @@
 import { alpha } from "./alpha";
+
+export function gamma() {
+  return alpha() * 3;
+}`;
const edgedPatchset = patchsetOf("patch-1", [
  file("src/alpha.ts", ALPHA),
  file("src/gamma.ts", GAMMA),
]);

// Two files that do not reference each other → no dependency edges, so the
// ordering pass may legitimately reorder them.
const IND_A = `@@ -1,2 +1,5 @@
 export function alpha() {
+  const value = compute(2);
+  logger.info(value);
+  return value;
 }`;
const IND_B = `@@ -1,2 +1,5 @@
 export function omega() {
+  const total = sum(3);
+  report(total);
+  return total;
 }`;
const independentPatchset = patchsetOf("patch-ind", [
  file("src/alpha.ts", IND_A),
  file("src/omega.ts", IND_B),
]);

function sequenceTitles(canvas: {
  layers: { analysis: { elements: { title: string }[] } };
}): string[] {
  return canvas.layers.analysis.elements.map((element) => element.title);
}

describe("buildReviewCanvases", () => {
  it("populates all five canvases from the real decomposition of the diff", async () => {
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
    });

    // Five angles, each keyed.
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
    expect(Object.keys(result.canvases).sort()).toEqual([...CANVAS_ANGLES].sort());

    // The substrate derives from the captured diff, not fixtures.
    const substrateChunks = result.canvases.sequence.layers.substrate.chunks;
    expect(substrateChunks.flatMap((chunk) => chunk.filePaths)).toEqual([
      "src/alpha.ts",
      "src/gamma.ts",
    ]);

    // The agentic proposal was admitted (not the deterministic fallback) and the
    // sequence canvas presents its chunk elements, titled from the real chunks.
    expect(runDecompositionTurn).toHaveBeenCalled();
    expect(result.decompositionResult?.usedFallback).toBe(false);
    expect(result.budgetRefused).toBe(false);
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("refuses over budget and never runs a model turn (Brita gate)", async () => {
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: {} }),
    );
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: { readingOrder: [], rationale: "" } satisfies OrderingBody,
      }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
      routePlanOptions: { maxHarnessInvocations: 1 },
    });

    // The gate fired before any spend: NEITHER model phase ran. Asserting the
    // ordering spy independently (not just the decomposition one) proves the
    // whole model phase — decomposition AND ordering — is skipped on a refusal,
    // so a future refactor that lifts ordering out of the budget guard is caught.
    expect(runDecompositionTurn).not.toHaveBeenCalled();
    expect(runOrderingTurn).not.toHaveBeenCalled();
    expect(result.budgetRefused).toBe(true);
    // Canvases are still populated, from the deterministic floor.
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("runs the model turn when within budget (Brita gate, pass arm)", async () => {
    const decomposition = decompose(edgedPatchset);
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({
        status: "emitted",
        body: deterministicProposalBody(decomposition),
      }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
    });

    expect(runDecompositionTurn).toHaveBeenCalledTimes(1);
    expect(result.budgetRefused).toBe(false);
  });

  it("stands on the deterministic floor when no harness turn is injected", async () => {
    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
    });

    expect(result.admittedDocs).toEqual([]);
    expect(result.decompositionResult).toBeUndefined();
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
    // The sequence floor still places the real chunks from the diff.
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("emits a complete live narrative with the utility port stubbed and zero model calls", async () => {
    // The feed is built from pipeline milestones, not a light-tier garnish. A
    // passed-but-unused utility port makes the zero-model-call guarantee
    // red-provable: if a future feed implementation reaches for garnish, this
    // assertion fails while the deterministic events remain expected.
    const complete = vi.fn();
    const utilityPort = { complete } as unknown as CodexUtilityPort;
    const events = [] as import("@rennet/types").NarrativeProgressEvent[];

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      codexPort: utilityPort,
      onProgress: (event) => events.push(event),
    });

    expect(complete).not.toHaveBeenCalled();
    expect(events.map((event) => event.key)).toEqual([
      "starting",
      "capture",
      "floor",
      "structure",
      "angle:spec",
      "angle:sequence",
      "angle:decisions",
      "angle:claims",
      "angle:noise",
      "complete",
    ]);
    expect(events.find((event) => event.key === "floor")?.artifact).toEqual({ angle: "sequence" });
    expect(events.at(-1)?.status).toBe("complete");
    expect(result.progress).toEqual(events);
  });

  it("applies the ordering pass's comprehension order to the sequence canvas", async () => {
    const decomposition = decompose(independentPatchset);
    // Independent files → no dependency edges → a reorder is admissible.
    expect(decomposition.edges).toEqual([]);
    const proposal = deterministicProposalBody(decomposition);
    const reversedOrder = [...proposal.readingOrder].reverse();

    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: {
          readingOrder: reversedOrder,
          rationale: "high-level first, then ground-up",
        } satisfies OrderingBody,
      }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: independentPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
    });

    expect(runOrderingTurn).toHaveBeenCalled();
    expect(result.orderingResult?.usedFallback).toBe(false);
    // The baseline was [alpha, omega]; the comprehension pass reversed it.
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/omega.ts", "src/alpha.ts"]);
  });
});

describe("buildReviewCanvases — one shared budget across the model phase (acceptance 2)", () => {
  it("refuses the sixth invocation at runtime across the two runners", async () => {
    // Budget of five; the pre-flight plan passes (small diff). Both turns always
    // reject, so each runner WANTS three attempts: decomposition 3 + ordering 3
    // = six. The shared budget permits exactly five, refusing the sixth.
    const rejectDecomposition = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: {} }),
    );
    const rejectOrdering = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: { readingOrder: [], rationale: "" } satisfies OrderingBody,
      }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn: rejectDecomposition,
      runOrderingTurn: rejectOrdering,
      routePlanOptions: { maxHarnessInvocations: 5 },
    });

    // Exactly five turns combined; the sixth was refused at runtime.
    const combined = rejectDecomposition.mock.calls.length + rejectOrdering.mock.calls.length;
    expect(combined).toBe(5);
    // Decomposition burned its three attempts; ordering got the remaining two
    // then was refused before a third.
    expect(rejectDecomposition).toHaveBeenCalledTimes(3);
    expect(rejectOrdering).toHaveBeenCalledTimes(2);
    // Both phases fell to the deterministic floor — the review still renders.
    expect(result.decompositionResult?.usedFallback).toBe(true);
    expect(result.orderingResult?.usedFallback).toBe(true);
    expect(result.orderingResult?.budgetRefused).toBe(true);
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
  });
});

describe("buildReviewCanvases — the council selects the model and stamps provenance (acceptance 3)", () => {
  it("executes each seat on the resolved harness and stamps honest per-phase provenance", async () => {
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const orderingBody: OrderingBody = {
      readingOrder: [...proposal.readingOrder],
      rationale: "codex says the baseline is clearest",
    };
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    // A Claude ordering turn is injected too, purely to PROVE it is NOT used: under
    // `both` the ordering seat resolves to a Codex model and must go to the port.
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({ status: "emitted", body: orderingBody }),
    );
    const { port: codexPort, complete: codexComplete } = admittingCodexPort(() => orderingBody);

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
      codexPort,
      council: { availability: { installed: ["claude-code", "codex"] } },
    });

    // The decomposition proposal ran on the Claude turn; the ordering seat resolved
    // to Codex, so it ran on the port and the Claude ordering turn was untouched.
    expect(runDecompositionTurn).toHaveBeenCalledTimes(1);
    expect(runOrderingTurn).not.toHaveBeenCalled();
    // The ordering seat ran on the port exactly once. (The roll-up narration seat
    // #70 also resolves to Codex under `both` and calls the port; this test is
    // about the ordering seat, so it looks at the ordering call specifically.)
    const orderingCalls = codexComplete.mock.calls.filter(
      (call) => (call[0] as CodexUtilityCompleteRequest).docType === "ordering",
    );
    expect(orderingCalls).toHaveLength(1);
    const codexReq = orderingCalls[0]?.[0] as CodexUtilityCompleteRequest;
    expect(codexReq.docType).toBe("ordering");
    expect(codexReq.model).toBe("gpt-5.6-terra");
    expect(codexReq.effort).toBe("medium");

    // The decomposition proposal was resolved to Opus 4.8 high on claude-code —
    // model AND harness agree.
    const proposalProvenance = result.decompositionResult?.document.provenance;
    expect(proposalProvenance?.model).toBe("opus-4.8");
    expect(proposalProvenance?.harness).toBe("claude-code");
    expect(proposalProvenance?.effort).toBe("high");
    expect(proposalProvenance?.resolutionTrace?.source).toBe("council-table");
    expect(proposalProvenance?.resolutionTrace?.summary).toContain("opus-4.8");

    // The ordering pass was resolved to a Codex model (Terra medium) and EXECUTED on
    // the Codex harness — a DIFFERENT harness than the reviewer, under `both` (R39
    // cross-harness, live at the pipeline). No model=codex/harness=claude contradiction.
    const orderingProvenance = result.orderingResult?.document.provenance;
    expect(orderingProvenance?.model).toBe("gpt-5.6-terra");
    expect(orderingProvenance?.harness).toBe("codex");
    expect(orderingProvenance?.effort).toBe("medium");
    expect(orderingProvenance?.resolutionTrace).toBeDefined();
    expect(result.orderingResult?.usedFallback).toBe(false);
    // Different providers => the council placed the two phases on two harnesses.
    expect(proposalProvenance?.model).not.toBe(orderingProvenance?.model);
  });

  it("without a council context, the caller-supplied provenance model stands", async () => {
    const decomposition = decompose(edgedPatchset);
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({
        status: "emitted",
        body: deterministicProposalBody(decomposition),
      }),
    );
    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      provenance: {
        harness: "claude-code",
        harnessVersion: "2.1.220",
        adapterVersion: "0.1.0",
        model: "caller-supplied-model",
        modelReportedBy: "config",
        capability: {
          structuredOutput: {
            implementedByAdapter: true,
            advertisedByHarness: true,
            availableInSession: true,
          },
          perCallModelSelection: {
            implementedByAdapter: false,
            advertisedByHarness: false,
            availableInSession: false,
          },
        },
      },
    });
    expect(result.decompositionResult?.document.provenance.model).toBe("caller-supplied-model");
    expect(result.decompositionResult?.document.provenance.resolutionTrace).toBeUndefined();
  });
});

describe("buildReviewCanvases — the council executes the resolved harness live (acceptance 1)", () => {
  it("claude-only: every seat resolves to Claude and the Codex port is never called", async () => {
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const orderingBody: OrderingBody = {
      readingOrder: [...proposal.readingOrder],
      rationale: "baseline",
    };
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({ status: "emitted", body: orderingBody }),
    );
    const { port: codexPort, complete: codexComplete } = admittingCodexPort(() => orderingBody);

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
      codexPort,
      council: { availability: { installed: ["claude-code"] } },
    });

    // Both seats ran on the injected Claude turns; the Codex port was untouched.
    expect(runDecompositionTurn).toHaveBeenCalledTimes(1);
    expect(runOrderingTurn).toHaveBeenCalledTimes(1);
    expect(codexComplete).not.toHaveBeenCalled();
    expect(result.decompositionResult?.document.provenance.harness).toBe("claude-code");
    expect(result.orderingResult?.document.provenance.harness).toBe("claude-code");
    // Under claude-only, ordering resolves to a Claude model (Sonnet 5 low).
    expect(result.orderingResult?.document.provenance.model).toBe("sonnet-5");
  });

  it("codex-only: both the heavy proposal seat and the ordering seat run on the Codex port", async () => {
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const orderingBody: OrderingBody = {
      readingOrder: [...proposal.readingOrder],
      rationale: "baseline",
    };
    // A Claude turn for each seat, injected only to prove neither is used.
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({ status: "emitted", body: orderingBody }),
    );
    const { port: codexPort, complete: codexComplete } = admittingCodexPort((req) =>
      req.docType === "ordering" ? orderingBody : proposal,
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
      codexPort,
      council: { availability: { installed: ["codex"] } },
    });

    // Neither Claude turn ran; both review seats went to the Codex port. (The
    // roll-up narration seat #70 also resolves to Codex here; this test is about
    // the two REVIEW seats, so it excludes the narration calls.)
    expect(runDecompositionTurn).not.toHaveBeenCalled();
    expect(runOrderingTurn).not.toHaveBeenCalled();
    const reviewCalls = codexComplete.mock.calls.filter(
      (call) => (call[0] as CodexUtilityCompleteRequest).docType !== "rollup-narration",
    );
    expect(reviewCalls).toHaveLength(2);
    const docTypes = reviewCalls.map((call) => (call[0] as CodexUtilityCompleteRequest).docType);
    expect(new Set(docTypes)).toEqual(new Set(["decomposition.proposal", "ordering"]));

    // The heavy proposal seat resolved to Sol high; ordering to Luna medium — both Codex.
    const proposalProvenance = result.decompositionResult?.document.provenance;
    expect(proposalProvenance?.model).toBe("gpt-5.6-sol");
    expect(proposalProvenance?.harness).toBe("codex");
    const orderingProvenance = result.orderingResult?.document.provenance;
    expect(orderingProvenance?.model).toBe("gpt-5.6-luna");
    expect(orderingProvenance?.harness).toBe("codex");
  });
});

describe("buildReviewCanvases — provenance is honest across harnesses (acceptance 2)", () => {
  it("never pairs a Codex model with a Claude harness (regression guard)", async () => {
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const orderingBody: OrderingBody = {
      readingOrder: [...proposal.readingOrder],
      rationale: "baseline",
    };
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({ status: "emitted", body: orderingBody }),
    );
    const { port: codexPort } = admittingCodexPort((req) =>
      req.docType === "ordering" ? orderingBody : proposal,
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
      codexPort,
      council: { availability: { installed: ["claude-code", "codex"] } },
    });

    const provenances: (RspProvenance | undefined)[] = [
      result.decompositionResult?.document.provenance,
      result.orderingResult?.document.provenance,
    ];
    const harnessesSeen = new Set<string>();
    for (const provenance of provenances) {
      expect(provenance).toBeDefined();
      if (provenance === undefined) continue;
      const isCodexModel = CODEX_MODELS.has(provenance.model as CouncilModel);
      // model and harness must AGREE: a codex model implies the codex harness.
      expect(isCodexModel).toBe(provenance.harness === "codex");
      harnessesSeen.add(provenance.harness);
    }
    // Guard against a vacuous pass: under `both` this fixture MUST actually place
    // the two seats on two different harnesses (proposal→Claude, ordering→Codex).
    // Without this, a regression where every seat collapsed to Claude would leave
    // the loop asserting `false === false` twice and pass silently.
    expect(harnessesSeen).toEqual(new Set(["claude-code", "codex"]));
  });

  it("an incoherent harness override never runs a Codex model on the Claude turn", async () => {
    // A user (task) override pins a Codex model but the CLAUDE harness onto the
    // ordering seat — a self-contradictory pin the resolver permits. The pipeline
    // MUST derive the executing harness from the MODEL (Codex), so the seat runs on
    // the Codex port and stamps a Codex harness, never a Codex-model/Claude-turn
    // mispair. Red against a pipeline that trusts `resolution.harness`: that path
    // would call the Claude ordering turn and stamp harness=claude-code.
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const orderingBody: OrderingBody = {
      readingOrder: [...proposal.readingOrder],
      rationale: "baseline",
    };
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({ status: "emitted", body: orderingBody }),
    );
    const { port: codexPort, complete: codexComplete } = admittingCodexPort(() => orderingBody);

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
      codexPort,
      council: {
        availability: { installed: ["claude-code", "codex"] },
        overrides: {
          task: {
            "comprehension-ordering": { model: "gpt-5.6-terra", harness: "claude-code" },
          },
        },
      },
    });

    // The ordering seat ran on the Codex port (model's true harness), NOT the
    // injected Claude ordering turn, and its provenance stamps the Codex harness.
    // (The roll-up narration seat #70 also uses the port; assert the ordering call.)
    const orderingCalls = codexComplete.mock.calls.filter(
      (call) => (call[0] as CodexUtilityCompleteRequest).docType === "ordering",
    );
    expect(orderingCalls).toHaveLength(1);
    expect(runOrderingTurn).not.toHaveBeenCalled();
    const orderingProvenance = result.orderingResult?.document.provenance;
    expect(orderingProvenance?.model).toBe("gpt-5.6-terra");
    expect(orderingProvenance?.harness).toBe("codex");
  });
});

describe("buildReviewCanvases — one shared budget across a Claude seat and a Codex seat (acceptance 3)", () => {
  it("refuses the sixth turn across the two harnesses (proof it can go red)", async () => {
    // Budget of five; the pre-flight plan passes (small diff). The Claude proposal
    // seat always emits an invalid body (rejected → three attempts wanted) and the
    // Codex ordering seat always rejects (three attempts wanted): six turns total.
    // The single shared budget permits exactly five, refusing the sixth.
    const rejectDecomposition = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: {} }),
    );
    // Injected purely to prove ordering went to the Codex port, not this Claude turn.
    const rejectOrderingClaude = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: { readingOrder: [], rationale: "" } satisfies OrderingBody,
      }),
    );
    const { port: codexPort, complete: codexComplete } = rejectingCodexPort();

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn: rejectDecomposition,
      runOrderingTurn: rejectOrderingClaude,
      codexPort,
      council: { availability: { installed: ["claude-code", "codex"] } },
      routePlanOptions: { maxHarnessInvocations: 5 },
    });

    // Decomposition (Claude) burned three attempts; ordering (Codex port) got the
    // remaining two, then the sixth was refused BEFORE a third — one shared ceiling
    // across two harnesses.
    expect(rejectDecomposition).toHaveBeenCalledTimes(3);
    expect(rejectOrderingClaude).not.toHaveBeenCalled();
    expect(codexComplete).toHaveBeenCalledTimes(2);
    const combined = rejectDecomposition.mock.calls.length + codexComplete.mock.calls.length;
    expect(combined).toBe(5);

    // Both seats fell to the deterministic floor — the review still renders.
    expect(result.decompositionResult?.usedFallback).toBe(true);
    expect(result.orderingResult?.usedFallback).toBe(true);
    expect(result.orderingResult?.budgetRefused).toBe(true);
    // The floored ordering still stamps the honest resolved codex seat.
    expect(result.orderingResult?.document.provenance.harness).toBe("codex");
    expect(result.orderingResult?.document.provenance.model).toBe("gpt-5.6-terra");
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
  });
});

describe("buildReviewCanvases — roll-up narration threads through (issue #70)", () => {
  it("returns a narrated roll-up account when the narration seat runs within budget", async () => {
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    // A narration turn covering the offered nodes. With only a proposal admitted
    // (no decision.record docs), the decisions canvas has no cohorts, so the sole
    // offered node is the roll-up — this body covers it exactly.
    const runNarrationTurn = vi.fn(async () => ({
      status: "emitted" as const,
      body: {
        narrations: [
          {
            altitude: "rollup",
            anchor: "rollup",
            oneLine: "A small change to alpha and gamma.",
            paragraph: "The change touches two files; read alpha first, then gamma.",
          },
        ],
      },
    }));

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runNarrationTurn,
    });

    expect(runNarrationTurn).toHaveBeenCalledTimes(1);
    expect(result.narration.rollup.status).toBe("narrated");
    expect(result.narrationResult?.outcome).toBe("narrated");
  });

  it("leaves narration PENDING and never spends a turn when the budget refused (the money circuit)", async () => {
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: {} }),
    );
    const runNarrationTurn = vi.fn(async () => ({
      status: "emitted" as const,
      body: { narrations: [] },
    }));

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runNarrationTurn,
      // The Brita gate refuses before any spend — narration must NOT run either.
      routePlanOptions: { maxHarnessInvocations: 1 },
    });

    expect(result.budgetRefused).toBe(true);
    expect(runNarrationTurn).not.toHaveBeenCalled();
    expect(result.narration.rollup.status).toBe("pending");
    // Every canvas still renders from the floor — the ceiling stops spend, not the review.
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
  });

  it("draws narration from the SAME shared budget as the review seats", async () => {
    // The decomposition turn emits an INVALID body, so it retries and burns the
    // whole shared ceiling (3 attempts at maxRetries=2) before falling to the
    // floor. Narration — the last seat — is then refused at runtime and never
    // spends a turn. A SEPARATE budget would let narration run; that it does not
    // is the proof the seats share one ceiling. Narration falls to honest pending.
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: {} }),
    );
    const runNarrationTurn = vi.fn(async () => ({
      status: "emitted" as const,
      body: { narrations: [] },
    }));

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      runNarrationTurn,
      routePlanOptions: { maxHarnessInvocations: 3 },
    });

    // The route plan did NOT refuse (3 is within the diff's plan), so the
    // decomposition seat ran and exhausted the shared budget across its retries.
    expect(result.budgetRefused).toBe(false);
    expect(runDecompositionTurn).toHaveBeenCalledTimes(3);
    expect(runNarrationTurn).not.toHaveBeenCalled();
    expect(result.narration.rollup.status).toBe("pending");
  });
});
