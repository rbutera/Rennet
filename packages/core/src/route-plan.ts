/**
 * The route-plan budget gate for initial decomposition (issue #8).
 *
 * The plan is built BEFORE any model runs, and an over-budget plan is REFUSED
 * rather than executed (R10: the budget is a mechanical gate, not a guideline).
 * The initial-decomposition plan is exactly: one heavy skeleton call (first
 * paint), one heavy proposal call, and light rationale calls batched at no more
 * than `rationaleBatchSize` chunks each — never process-per-hunk. So a 3,000-line
 * PR costs `ceil(substantiveChunks / batch)` light calls, not one per hunk.
 *
 * The unit test that asserts the plan for the largest fixture never exceeds
 * `maxHarnessInvocations` is the Brita filter: without it, the budget is a
 * sentence in a document that drifts.
 */

import type { Decomposition, PlannedInvocation, RoutePlanResult } from "@rennet/protocol";

/** The <5-invocation ceiling for initial decomposition (R10). Five passes, six refuses. */
export const DEFAULT_MAX_HARNESS_INVOCATIONS = 5;

/** Rationale is a light, batched task; ten chunks per call keeps the count bounded. */
export const DEFAULT_RATIONALE_BATCH_SIZE = 10;

export interface RoutePlanOptions {
  readonly maxHarnessInvocations?: number;
  readonly rationaleBatchSize?: number;
}

/**
 * Build the initial-decomposition plan. Every planned entry is a harness
 * invocation (a heavy or light MODEL call); deterministic steps are not counted.
 * Returns a refusal (computed before any model runs) when the count exceeds the
 * budget.
 */
export function buildRoutePlan(
  decomposition: Decomposition,
  options: RoutePlanOptions = {},
): RoutePlanResult {
  const maxHarnessInvocations = options.maxHarnessInvocations ?? DEFAULT_MAX_HARNESS_INVOCATIONS;
  const batchSize = Math.max(1, options.rationaleBatchSize ?? DEFAULT_RATIONALE_BATCH_SIZE);

  const substantiveChunkIds = decomposition.chunks
    .filter((chunk) => chunk.kind === "substantive")
    .map((chunk) => chunk.chunkId);

  const invocations: PlannedInvocation[] = [
    { purpose: "skeleton", tier: "heavy", label: "decomposition skeleton (first paint)" },
    { purpose: "proposal", tier: "heavy", label: "decomposition proposal (full graph)" },
  ];

  for (let start = 0; start < substantiveChunkIds.length; start += batchSize) {
    const chunkBatch = substantiveChunkIds.slice(start, start + batchSize);
    invocations.push({
      purpose: "rationale",
      tier: "light",
      label: `chunk rationale (batch of ${chunkBatch.length})`,
      chunkBatch,
    });
  }

  const harnessInvocationCount = invocations.length;
  if (harnessInvocationCount > maxHarnessInvocations) {
    return {
      refused: true,
      harnessInvocationCount,
      maxHarnessInvocations,
      reason: `initial decomposition needs ${harnessInvocationCount} harness invocations, over the budget of ${maxHarnessInvocations}`,
    };
  }

  return { refused: false, invocations, harnessInvocationCount, maxHarnessInvocations };
}
