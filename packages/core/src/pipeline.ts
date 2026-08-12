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
  REVIEW_HYPOTHESIS_CONTRACT,
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
  HypothesisRepoContext,
  HypothesisStructure,
  OfferedManifest,
  OwnershipRule,
  Patchset,
  ResolutionTrace,
  ReviewHypothesis,
  ReviewIntent,
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
import { computeBlastRadius, type FanInIndex } from "./blast-radius";
import { type AdmittedDocument, buildCanvas, type CanvasEvent } from "./canvas";
import { createCodexRunTurn } from "./codex-run-turn";
import type { CodexUtilityPort } from "./codex-utility-port";
import { type DecomposeOptions, decompose } from "./decomposition";
import { buildElementDiffs } from "./element-diffs";
import { guardSeatTurn, type HarnessTurnResult } from "./harness-run-turn";
import {
  type HypothesisTurnResult,
  type RunHypothesisResult,
  runHypothesisPass,
} from "./hypothesis-generation";
import { createInvocationBudget, normalizeMaxInvocations } from "./invocation-budget";
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
  /**
   * CODEOWNERS rules for the blast-radius CODEOWNERS-overlap signal (issue #35).
   * Optional: absent ⇒ the overlap signal simply does not fire (the other three
   * signals still compute from the changeset). A caller threads this from the
   * project snapshot's ownership when available.
   */
  readonly ownership?: readonly OwnershipRule[];
  /**
   * The fan-in index for the blast-radius fan-in signal (#200 → #35 follow-on). Present
   * ⇒ fan-in is ASSESSED (per-file dependent counts); absent ⇒ it stays a NOT-ASSESSED
   * chip, never a silent zero. The composition supplies it only when the reference index
   * is populated, so absence is honest. A caller threads it from the project snapshot.
   */
  readonly fanIn?: FanInIndex;
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
  /**
   * The decision-extraction runner's output (issue #137): admitted
   * `decision.record` documents to place on the decisions canvas. The projector
   * groups them by anchored chunk; each decision carries its evidence chips +
   * reconstructed why for the lens. Supplied independently of the model phase, so
   * decisions are admitted on BOTH the live and the deterministic-floor paths.
   * The LIVE runner that reasons over {spec, PR body, diff} is deferred (it
   * depends on #136's intent capture); a fixture stands behind this boundary now.
   */
  readonly decisionDocs?: readonly AdmittedDocument[];
  /**
   * Drives the hypothesis-first pre-read pass (#178). Absent (or a budget refusal)
   * means no hypothesis is produced and the result carries none — every lens then
   * runs exactly as it does today. When present, the pass runs FIRST (before the
   * decomposition angle reads a hunk) over the change's intent + structure +
   * repo context, and its committed hypothesis rides the result for the lens
   * runners to disconfirm against and for the human's reading frame. It draws from
   * the SAME shared budget, so its turn counts toward the <5 ceiling.
   */
  readonly runHypothesisTurn?: (prompt: string, attempt: number) => Promise<HypothesisTurnResult>;
  readonly hypothesisContract?: PromptContract;
  /** The change's stated intent, fed to the hypothesis pass (PR title/body, spec). */
  readonly intent?: ReviewIntent;
  /** A compact ProjectSnapshot projection fed to the hypothesis pass; absent → degrades honestly. */
  readonly repoContext?: HypothesisRepoContext;
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
  /**
   * True when the model budget refused — pre-flight (the Brita route plan judged
   * the diff shape over budget before any spend) OR at runtime (the shared
   * ceiling was exhausted mid-review by retries). Either way the model phase did
   * not complete, so the surface must present the review as degraded, never as a
   * completed AI review (#260).
   */
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
  /**
   * The committed hypothesis (#178), delivered ALONGSIDE the canvas set (never
   * embedded on a `Canvas`, so the projection stays byte-identical for replay).
   * Present only when the hypothesis pass ran AND produced an admitted hypothesis;
   * absent when no pass ran, the budget refused, or the pass failed. The lens
   * runners consume it as disconfirmation criteria and the surface renders it as
   * the human's reading frame.
   */
  readonly hypothesis?: ReviewHypothesis;
  /** The hypothesis pass result (for provenance / telemetry); absent when it did not run. */
  readonly hypothesisResult?: RunHypothesisResult;
}

/**
 * Run the live pipeline for one captured patchset and return the five-angle
 * canvas set plus the intermediate results (for provenance / telemetry).
 */
export async function buildReviewCanvases(
  input: ReviewPipelineInput,
): Promise<ReviewPipelineResult> {
  const decomposition = decompose(input.patchset, input.decomposeOptions ?? {});
  // Normalize the ceiling ONCE, at the point the raw config is read, and hand the
  // SAME value to the pre-flight route plan AND the runtime budget below — so no
  // consumer ever sees an un-normalized ceiling (#269). A malformed value
  // (NaN/±Infinity/negative) is a caller defect → the default; a literal 0 is
  // preserved. Before this, `buildRoutePlan` read the RAW `maxHarnessInvocations`
  // one hop before the budget's fallback applied, so a negative/`-Infinity` ceiling
  // refused pre-flight and rendered a COMPLETED review with zero model turns — the
  // exact fake review the circuit exists to prevent.
  const maxInvocations = normalizeMaxInvocations(
    input.routePlanOptions?.maxHarnessInvocations ?? DEFAULT_MAX_HARNESS_INVOCATIONS,
  );
  const routePlan = buildRoutePlan(decomposition, {
    ...(input.routePlanOptions ?? {}),
    maxHarnessInvocations: maxInvocations,
  });
  const seed = input.provenance ?? DEFAULT_PROVENANCE_SEED;

  // ONE shared live invocation budget for the whole model phase (issue #69, bead
  // p0wwp). Seeded from the SAME normalized ceiling the pre-flight route plan uses,
  // threaded through BOTH runners, consumed once per actual turn — so the proposal's
  // retries AND the ordering pass draw from a single ceiling and a turn over it
  // is refused at runtime, not merely counted once in a static pre-flight plan.
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

  // ① The hypothesis-first pre-read pass (#178). It runs FIRST — before the
  // decomposition angle reads a hunk — over the change's intent + STRUCTURE (the
  // deterministic decomposition's chunk titles + the changed-file list, never the
  // hunk bodies) + repo context, so its risks are a genuine prior rather than a
  // diff summary. It draws from the SAME shared budget as every other stage, so a
  // refusal (route plan OR the counter exhausted) leaves the review with no
  // hypothesis and every lens runs unchanged — never a fabricated one.
  let hypothesisResult: RunHypothesisResult | undefined;
  let hypothesis: ReviewHypothesis | undefined;
  if (input.runHypothesisTurn && !budgetRefused) {
    const structure: HypothesisStructure = {
      changedFiles: input.patchset.files.map((file) => file.path),
      chunkTitles: decomposition.chunks.map((chunk) => chunk.title),
    };
    hypothesisResult = await runHypothesisPass({
      patchsetId: decomposition.patchsetId,
      manifest,
      structure,
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.repoContext ? { repoContext: input.repoContext } : {}),
      contract: input.hypothesisContract ?? REVIEW_HYPOTHESIS_CONTRACT,
      provenance: seed,
      // A thrown hypothesis turn degrades to the honest failed state (no hypothesis)
      // rather than crashing the whole run (#96).
      runTurn: guardSeatTurn(input.runHypothesisTurn),
      budget,
      ...(input.mintDocId ? { mintDocId: input.mintDocId } : {}),
      ...(input.newRunId ? { newRunId: input.newRunId } : {}),
    });
    if (hypothesisResult.status === "ok") hypothesis = hypothesisResult.hypothesis;
  }

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

  // Admit the decision-extraction runner's `decision.record` docs (issue #137)
  // alongside the decomposition/ordering output, on BOTH paths (the model phase
  // above may not have run). The projector routes them to the decisions canvas
  // and groups them by anchored chunk; no other angle admits them.
  if (input.decisionDocs && input.decisionDocs.length > 0) {
    admittedDocs = [...admittedDocs, ...input.decisionDocs];
  }

  const canvasEvents = input.canvasEvents ?? [];
  // The deterministic blast-radius overlay (issue #35): computed once from the
  // changeset + CODEOWNERS and painted identically onto every angle's canvas. It
  // is DATA the overlay renders amber — never an ordering input (the ordering pass
  // has no blast-radius parameter) and never a gate.
  const blastRadius = computeBlastRadius({
    files: input.patchset.files,
    ownership: input.ownership ?? [],
    ...(input.fanIn ? { fanIn: input.fanIn } : {}),
  });
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
      blastRadius,
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
    // Pre-flight refusal (the route plan gated it before any spend) OR a runtime
    // exhaustion of the shared ceiling by retries (#260). Either means no complete
    // model phase ran, so the surface degrades the review rather than faking done.
    budgetRefused: budgetRefused || budget.refused,
    ...(decompositionResult ? { decompositionResult } : {}),
    ...(orderingResult ? { orderingResult } : {}),
    admittedDocs,
    narration,
    ...(narrationResult ? { narrationResult } : {}),
    ...(hypothesis ? { hypothesis } : {}),
    ...(hypothesisResult ? { hypothesisResult } : {}),
  };
}
