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
  ROLLUP_NARRATION_CONTRACT,
} from "@rennet/instructions";
import type {
  Canvas,
  CanvasAngle,
  CouncilJobId,
  CouncilResolveContext,
  Decomposition,
  DecompositionProposalBody,
  Disposition,
  ElementDiffs,
  OfferedManifest,
  Patchset,
  ResolutionTrace,
  ReviewNarration,
  RoutePlanResult,
  RspCapabilitySnapshot,
  RspDocType,
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
import { createCodexRunTurn } from "./codex-run-turn";
import type { CodexUtilityPort } from "./codex-utility-port";
import { type DecomposeOptions, decompose } from "./decomposition";
import { buildElementDiffs } from "./element-diffs";
import { guardSeatTurn, type HarnessTurnResult } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";
import { providerHarness, resolveAssignment } from "./model-council";
import {
  buildChunkManifest,
  type OrderingTurnResult,
  type RunOrderingPassResult,
  resolveLiveOrder,
  runOrderingPass,
} from "./ordering-pass";
import {
  buildReviewNarration,
  offeredNarrationNodes,
  type RunRollupNarrationResult,
  runRollupNarration,
} from "./rollup-narration";
import {
  buildRoutePlan,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  type RoutePlanOptions,
} from "./route-plan";

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface PipelineProvenanceSeed {
  readonly harness: string;
  readonly harnessVersion: string;
  readonly adapterVersion: string;
  readonly model: string;
  readonly modelReportedBy: RspModelReportedBy;
  readonly capability: RspCapabilitySnapshot;
  /** The Model Council effort for this seat, when the council resolved it (#69). */
  readonly effort?: string;
  /** The Model Council resolution trace, when the council resolved this seat (#69). */
  readonly resolutionTrace?: ResolutionTrace;
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
   * The Model Council context (installed harnesses + user overrides). When
   * present, the pipeline resolves the model for the `decomposition-proposal`
   * and `comprehension-ordering` seats and stamps `{ model, effort,
   * resolutionTrace }` into each phase's provenance — so every model invocation
   * records which mind ran it and why. Absent, the caller-supplied provenance
   * model stands (prior behaviour).
   */
  readonly council?: CouncilResolveContext;
  /**
   * The Codex seat executor (#66). When a seat resolves to a Codex model (R39,
   * cross-harness), the pipeline routes that seat's turn through this port
   * instead of the injected Claude turn — so the council's Codex routing is
   * EXECUTED, not merely stamped. The runner still owns the shared budget and
   * retry loop (the port runs one attempt per turn). Absent, a Codex-resolved
   * seat has no executor and stands on the deterministic floor (the composition
   * root provides the port iff `codex` is in `council.availability.installed`).
   */
  readonly codexPort?: CodexUtilityPort;
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
  /**
   * Drives the roll-up narration pass (#70). Absent (or a Codex resolution with no
   * port, or a budget refusal) means every node's narration is the honest
   * `pending` state — never a fabricated account. Narration draws from the SAME
   * shared budget, so its turns count toward the <5 ceiling.
   */
  readonly runNarrationTurn?: (prompt: string, attempt: number) => Promise<HarnessTurnResult>;
  readonly narrationContract?: PromptContract;
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
  /**
   * The roll-up narration placed onto the canvases (issue #70), delivered
   * ALONGSIDE the canvas set (never embedded on a `Canvas`, so the projection
   * stays byte-identical for replay). Every node above a chunk resolves to a
   * narrated account or an honest pending/failed state — never a silent blank.
   */
  readonly narration: ReviewNarration;
  /** The narration run result (for provenance / telemetry); absent when it did not run. */
  readonly narrationResult?: RunRollupNarrationResult;
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

  // ONE shared live invocation budget for the whole model phase (issue #69, bead
  // p0wwp). Seeded from the same ceiling the pre-flight route plan uses, threaded
  // through BOTH runners, consumed once per actual turn — so the proposal's
  // retries AND the ordering pass draw from a single ceiling and a turn over it
  // is refused at runtime, not merely counted once in a static pre-flight plan.
  const maxInvocations =
    input.routePlanOptions?.maxHarnessInvocations ?? DEFAULT_MAX_HARNESS_INVOCATIONS;
  const budget = createInvocationBudget(maxInvocations);
  const manifest = buildOfferedManifest(decomposition);

  type RunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;
  interface ResolvedSeat {
    readonly seed: PipelineProvenanceSeed;
    readonly runTurn: RunTurn | undefined;
  }

  /**
   * Resolve one model-facing seat: the Model Council's assignment (or none), the
   * provenance seed with the resolved model AND harness (so `harness` follows the
   * model — no `model=codex`/`harness=claude` contradiction), and the executor
   * for the resolved harness — the injected Claude turn for a `claude-code` seat,
   * a port-backed turn for a `codex` seat. A Codex seat with no port has no
   * executor and stands on the deterministic floor (never a dishonest Claude run).
   */
  const resolveSeat = (
    jobId: CouncilJobId,
    docType: RspDocType,
    seatManifest: OfferedManifest,
    claudeTurn: RunTurn | undefined,
  ): ResolvedSeat => {
    if (input.council === undefined) return { seed, runTurn: claudeTurn };
    const resolution = resolveAssignment(jobId, input.council);
    if (resolution.kind !== "model") return { seed, runTurn: claudeTurn };
    // The EXECUTING harness follows the resolved MODEL, structurally: a council
    // model maps to exactly one provider → harness, so model and harness cannot
    // diverge at execution or in provenance. This double-switches the honesty
    // circuit (Rule 75): even if an incoherent override pinned `harness=claude`
    // onto a Codex model (`resolution.harness` can be overridden independently of
    // the model in the resolver), the pipeline still runs that model on ITS harness
    // and stamps THAT harness — never a Codex model on the Claude turn, never a
    // `model=codex`/`harness=claude` provenance lie.
    const execHarness = providerHarness(resolution.model);
    const seatSeed: PipelineProvenanceSeed = {
      ...seed,
      harness: execHarness,
      model: resolution.model,
      modelReportedBy: "config",
      effort: resolution.effort,
      resolutionTrace: resolution.trace,
    };
    if (execHarness === "codex") {
      const runTurn =
        input.codexPort === undefined
          ? undefined
          : createCodexRunTurn(input.codexPort, {
              docType,
              patchset: { id: decomposition.patchsetId },
              manifest: seatManifest,
              model: resolution.model,
              effort: resolution.effort,
            });
      return { seed: seatSeed, runTurn };
    }
    return { seed: seatSeed, runTurn: claudeTurn };
  };

  let admittedDocs: AdmittedDocument[] = [];
  let decompositionResult: RunDecompositionAngleResult | undefined;
  let orderingResult: RunOrderingPassResult | undefined;

  const decompositionSeat = resolveSeat(
    "decomposition-proposal",
    "decomposition.proposal",
    manifest,
    input.runDecompositionTurn,
  );

  // The Brita gate: run the model phase ONLY when the decomposition seat has an
  // executor for its resolved harness (Claude turn OR Codex port) AND the budget
  // permits it. A refusal skips the whole model phase — no spend, floor stands.
  const budgetRefused = routePlan.refused;
  if (decompositionSeat.runTurn && !budgetRefused) {
    decompositionResult = await runDecompositionAngle({
      decomposition,
      contract: input.decompositionContract ?? DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: decompositionSeat.seed,
      // A thrown/rejected turn (e.g. a session/transport construction exception,
      // #96) is caught and degraded to a turn-failure, so a construction throw
      // falls to the deterministic floor instead of crashing the whole run.
      runTurn: guardSeatTurn(decompositionSeat.runTurn),
      budget,
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
    // is safe. The ordering seat resolves independently — under `both` it lands on
    // the Codex port while the proposal stayed on Claude (R39, live). Absent or
    // fallen-back, the #8 baseline order stands.
    const orderingManifest = buildChunkManifest(proposalBody);
    const orderingSeat = resolveSeat(
      "comprehension-ordering",
      "ordering",
      orderingManifest,
      input.runOrderingTurn,
    );
    if (orderingSeat.runTurn) {
      orderingResult = await runOrderingPass({
        proposal: proposalBody,
        patchsetId: decomposition.patchsetId,
        contract: input.orderingContract ?? ORDERING_CONTRACT,
        provenance: orderingSeat.seed,
        // A thrown ordering turn degrades to the #8 baseline order (#96).
        runTurn: guardSeatTurn(orderingSeat.runTurn),
        budget,
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

  // Roll-up narration (#70): the zoom ladder's own voice, produced AFTER the
  // canvases exist (it accounts for their nodes). It is a council-routed light-tier
  // seat drawing from the SAME shared budget — so its turns count toward the <5
  // ceiling, and a budget refusal (route plan OR the shared counter exhausted by
  // the decomposition/ordering phase) leaves every node's narration `pending`,
  // never a fabricated account. The offered node set is always ≥1 (the rollup).
  const narrationNodes = offeredNarrationNodes(canvases);
  const narrationManifest = buildOfferedManifest(decomposition);
  const narrationSeat = resolveSeat(
    "rollup-narration",
    "rollup-narration",
    narrationManifest,
    input.runNarrationTurn,
  );
  let narrationResult: RunRollupNarrationResult | undefined;
  if (narrationSeat.runTurn && !budgetRefused) {
    narrationResult = await runRollupNarration({
      nodes: narrationNodes,
      decomposition,
      patchsetId: decomposition.patchsetId,
      contract: input.narrationContract ?? ROLLUP_NARRATION_CONTRACT,
      provenance: narrationSeat.seed,
      // A thrown narration turn degrades every node to the honest pending/failed
      // floor instead of crashing the run (#96).
      runTurn: guardSeatTurn(narrationSeat.runTurn),
      budget,
      ...(input.mintDocId ? { mintDocId: input.mintDocId } : {}),
      ...(input.newRunId ? { newRunId: input.newRunId } : {}),
    });
  }
  const narration = buildReviewNarration(narrationNodes, narrationResult);

  return {
    canvases,
    elementDiffs,
    decomposition,
    routePlan,
    budgetRefused,
    ...(decompositionResult ? { decompositionResult } : {}),
    ...(orderingResult ? { orderingResult } : {}),
    admittedDocs,
    narration,
    ...(narrationResult ? { narrationResult } : {}),
  };
}
