/**
 * The deterministic review-pipeline floor (issue #54, reduced for the Board rebuild — B2).
 *
 * The model-backed generation passes (decomposition / finding / decision /
 * hypothesis / ordering / roll-up-narration angles) and the canvas projection were
 * deleted in the canvas-deletion cutover (#489): the Board (B-series) replaces the
 * canvas-projection review surface. What remains is the DETERMINISTIC spine the
 * live context / symbol backend still stands on — decompose the captured patchset
 * and run the Brita route-plan budget gate. No model turns, no canvas projection:
 * `canvases` and `elementDiffs` are empty (nothing live reads a built Canvas after
 * this change), and the deterministic producers (`blast-radius`, `element-diffs`,
 * `openspec-change`, `finding-reconcile`, `noise-generation`) survive as standalone
 * units for the B-series to re-wire onto the Board surface.
 */

import type {
  Decomposition,
  Disposition,
  ElementDiffs,
  InvocationBudget,
  Patchset,
  RoutePlanResult,
} from "@rennet/protocol";
import { type DecomposeOptions, decompose } from "./decomposition";
import type { AdmittedDocument } from "./element-diffs";
import { normalizeMaxInvocations } from "./invocation-budget";
import { buildRoutePlan, type RoutePlanOptions } from "./route-plan";

export interface ReviewPipelineInput {
  readonly reviewId: string;
  readonly patchset: Patchset;
  readonly dispositions: Disposition[];
  readonly decomposeOptions?: DecomposeOptions;
  readonly routePlanOptions?: RoutePlanOptions;
  /** The one review-turn budget supplied by the composition; no pipeline-local default. */
  readonly budget: InvocationBudget;
}

export interface ReviewPipelineResult {
  /**
   * The canvas set. EMPTY during the Board rebuild — the canvas projection AND the
   * protocol `Canvas`/`CanvasAngle` state model were deleted (#489, B2) and nothing
   * live reads a built canvas; the field is retained (empty) so the result shape is
   * stable for the B-series rewire.
   */
  readonly canvases: Record<string, never>;
  /** The per-element diff map. Empty with no canvases; the slicer survives standalone. */
  readonly elementDiffs: ElementDiffs;
  readonly decomposition: Decomposition;
  readonly routePlan: RoutePlanResult;
  /** The one shared per-review invocation meter, reused by follow-on model tools. */
  readonly invocationBudget: InvocationBudget;
  /**
   * True when the model budget refused — pre-flight (the Brita route plan judged
   * the diff shape over budget) OR at runtime. On the deterministic floor no model
   * runs, but the verdict is still reported honestly for the surface.
   */
  readonly budgetRefused: boolean;
  /** The admitted documents. Empty on the deterministic floor (no model phase). */
  readonly admittedDocs: AdmittedDocument[];
}

/**
 * Run the deterministic floor for one captured patchset: decompose it and run the
 * Brita route-plan budget gate. Returns an empty canvas set (the projection is
 * gone) plus the captured decomposition and route plan the live backend reads.
 */
export async function buildReviewCanvases(
  input: ReviewPipelineInput,
): Promise<ReviewPipelineResult> {
  const decomposition = decompose(input.patchset, input.decomposeOptions ?? {});
  // The composition-created session budget is canonical. The legacy route-plan
  // knob may tighten its ceiling but can never raise it.
  const legacyCeiling = input.routePlanOptions?.maxHarnessInvocations;
  const maxInvocations =
    legacyCeiling === undefined
      ? input.budget.max
      : Math.min(input.budget.max, normalizeMaxInvocations(legacyCeiling));
  const routePlan = buildRoutePlan(decomposition, {
    ...(input.routePlanOptions ?? {}),
    maxHarnessInvocations: maxInvocations,
  });

  return {
    canvases: {},
    elementDiffs: {},
    decomposition,
    routePlan,
    invocationBudget: input.budget,
    budgetRefused: routePlan.refused || input.budget.refused,
    admittedDocs: [],
  };
}
