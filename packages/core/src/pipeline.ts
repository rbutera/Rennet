/**
 * The live review pipeline (issue #54).
 *
 * This is the wire that turns a captured changeset into the five-angle canvas
 * set the reviewer reads. Every piece already exists and is tested in isolation;
 * this module introduces them to each other:
 *
 *   decompose (#7)  →  buildRoutePlan Brita gate (#8)  →  runDecompositionAngle
 *   (#8)  →  runOrderingPass (#9)  →  buildCanvas per angle (#10)
 *
 * Two properties are load-bearing:
 *   - The Brita budget filter is consulted BEFORE any model turn. An over-budget
 *     route plan refuses, and on a refusal no turn runs and the pipeline stands
 *     on the deterministic floor — so the <5-invocation ceiling is a real gate on
 *     the first metered-adjacent calls, never a sentence in a document (R10).
 *   - The pipeline is a pure function of its inputs plus the injected model turns.
 *     The turns are injected (`createHarnessRunTurn` supplies the real ones,
 *     mocks supply CI ones), so this module has no harness or SDK dependency and
 *     stays fully testable. With no turn, or a refusal, the deterministic floor
 *     still populates real canvases from the captured diff (substrate +
 *     deterministic sequence) — the agentic proposal only enriches them.
 */

import {
  DECOMPOSITION_PROPOSAL_CONTRACT,
  ORDERING_CONTRACT,
  type PromptContract,
} from "@rennet/instructions";
import type {
  Canvas,
  CanvasAngle,
  Decomposition,
  DecompositionProposalBody,
  Disposition,
  ElementDiffs,
  Patchset,
  RoutePlanResult,
  RspCapabilitySnapshot,
  RspModelReportedBy,
} from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import {
  buildOfferedManifest,
  type DecompositionTurnResult,
  type RunDecompositionAngleResult,
  runDecompositionAngle,
} from "./angle-generation";
import { type AdmittedDocument, buildCanvas, type CanvasEvent } from "./canvas";
import { type DecomposeOptions, decompose } from "./decomposition";
import { buildElementDiffs } from "./element-diffs";
import {
  type OrderingTurnResult,
  type RunOrderingPassResult,
  resolveLiveOrder,
  runOrderingPass,
} from "./ordering-pass";
import { buildRoutePlan, type RoutePlanOptions } from "./route-plan";

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface PipelineProvenanceSeed {
  readonly harness: string;
  readonly harnessVersion: string;
  readonly adapterVersion: string;
  readonly model: string;
  readonly modelReportedBy: RspModelReportedBy;
  readonly capability: RspCapabilitySnapshot;
}

const NO_CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: false,
    advertisedByHarness: false,
    availableInSession: false,
  },
  perCallModelSelection: {
    implementedByAdapter: false,
    advertisedByHarness: false,
    availableInSession: false,
  },
};

/**
 * The default provenance seed. Provenance is stamped on the RSP document but is
 * NOT read by the canvas projector (which consumes `docId`/`docType`/`body`), so
 * a placeholder seed is honest for placement; a caller with a live harness
 * descriptor can pass a richer one.
 */
const DEFAULT_PROVENANCE_SEED: PipelineProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "unknown",
  adapterVersion: "0.0.0",
  model: "unknown",
  modelReportedBy: "unknown",
  capability: NO_CAPABILITY,
};

export interface ReviewPipelineInput {
  readonly reviewId: string;
  readonly patchset: Patchset;
  readonly dispositions: Disposition[];
  /** L3 canvas-op events (session-scoped); empty for a fresh review. */
  readonly canvasEvents?: CanvasEvent[];
  readonly decomposeOptions?: DecomposeOptions;
  readonly routePlanOptions?: RoutePlanOptions;
  readonly provenance?: PipelineProvenanceSeed;
  /**
   * Drives the decomposition angle's model turn. Absent (or a budget refusal)
   * means the deterministic floor stands — no model runs.
   */
  readonly runDecompositionTurn?: (
    prompt: string,
    attempt: number,
  ) => Promise<DecompositionTurnResult>;
  readonly decompositionContract?: PromptContract;
  /** Drives the comprehension-ordering pass. Absent means the #8 baseline order stands. */
  readonly runOrderingTurn?: (prompt: string, attempt: number) => Promise<OrderingTurnResult>;
  readonly orderingContract?: PromptContract;
  /** Deterministic id hooks (tests); default to the random minters. */
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

export interface ReviewPipelineResult {
  readonly canvases: Record<CanvasAngle, Canvas>;
  /**
   * The real per-element diff map (issue #60), keyed by `elementKey`. Sliced
   * verbatim from the captured patch, delivered alongside the canvas set so the
   * zoom surface renders real code instead of the `demoDiff` fixture.
   */
  readonly elementDiffs: ElementDiffs;
  readonly decomposition: Decomposition;
  readonly routePlan: RoutePlanResult;
  /** True when the Brita budget refused and no model turn ran. */
  readonly budgetRefused: boolean;
  readonly decompositionResult?: RunDecompositionAngleResult;
  readonly orderingResult?: RunOrderingPassResult;
  /** The admitted documents placed onto the canvases (empty on the floor path). */
  readonly admittedDocs: AdmittedDocument[];
}

/**
 * Run the live pipeline for one captured patchset and return the five-angle
 * canvas set plus the intermediate results (for provenance / telemetry).
 */
export async function buildReviewCanvases(
  input: ReviewPipelineInput,
): Promise<ReviewPipelineResult> {
  const decomposition = decompose(input.patchset, input.decomposeOptions ?? {});
  const routePlan = buildRoutePlan(decomposition, input.routePlanOptions ?? {});
  const seed = input.provenance ?? DEFAULT_PROVENANCE_SEED;

  let admittedDocs: AdmittedDocument[] = [];
  let decompositionResult: RunDecompositionAngleResult | undefined;
  let orderingResult: RunOrderingPassResult | undefined;

  // The Brita gate: run a model turn ONLY when a turn is injected AND the budget
  // permits it. A refusal skips the whole model phase — no spend, floor stands.
  const budgetRefused = routePlan.refused;
  if (input.runDecompositionTurn && !budgetRefused) {
    const manifest = buildOfferedManifest(decomposition);
    decompositionResult = await runDecompositionAngle({
      decomposition,
      contract: input.decompositionContract ?? DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: seed,
      runTurn: input.runDecompositionTurn,
      ...(input.mintDocId ? { mintDocId: input.mintDocId } : {}),
      ...(input.newRunId ? { newRunId: input.newRunId } : {}),
    });

    const proposalDoc = decompositionResult.document;
    // The angle always mints a docId (RspEnvelope types it optional); a missing
    // one would collapse canvas element identity, so fail loud rather than place
    // an empty-keyed document.
    if (proposalDoc.docId === undefined) {
      throw new Error("the decomposition proposal document is missing its minted docId");
    }
    const proposalBody = proposalDoc.body as DecompositionProposalBody;
    let readingOrder = proposalBody.readingOrder;

    // Ordering → canvas: the comprehension pass refines the reading order the
    // sequence canvas presents. It covers exactly the proposal's chunk set (the
    // validator guarantees it), so applying its live order to the placed proposal
    // is safe. Absent or fallen-back, the #8 baseline order stands.
    if (input.runOrderingTurn) {
      orderingResult = await runOrderingPass({
        proposal: proposalBody,
        patchsetId: decomposition.patchsetId,
        contract: input.orderingContract ?? ORDERING_CONTRACT,
        provenance: seed,
        runTurn: input.runOrderingTurn,
        ...(input.mintDocId ? { mintDocId: input.mintDocId } : {}),
        ...(input.newRunId ? { newRunId: input.newRunId } : {}),
      });
      readingOrder = resolveLiveOrder(orderingResult).readingOrder;
    }

    admittedDocs = [
      {
        docId: proposalDoc.docId,
        docType: proposalDoc.docType,
        body: { ...proposalBody, readingOrder },
      },
    ];
  }

  const canvasEvents = input.canvasEvents ?? [];
  const entries = CANVAS_ANGLES.map((angle): [CanvasAngle, Canvas] => [
    angle,
    buildCanvas({
      reviewId: input.reviewId,
      patchsetId: decomposition.patchsetId,
      angle,
      admittedDocs,
      decomposition,
      dispositions: input.dispositions,
      canvasEvents,
    }),
  ]);
  const canvases = Object.fromEntries(entries) as Record<CanvasAngle, Canvas>;
  const elementDiffs = buildElementDiffs(canvases, decomposition, input.patchset, admittedDocs);

  return {
    canvases,
    elementDiffs,
    decomposition,
    routePlan,
    budgetRefused,
    ...(decompositionResult ? { decompositionResult } : {}),
    ...(orderingResult ? { orderingResult } : {}),
    admittedDocs,
  };
}
