/**
 * The live invocation budget (issue #69; the money circuit made HONEST, #260).
 *
 * A CONFIGURED finite ceiling is enforced at runtime: `tryConsume` grants one
 * invocation per call while the count is below the ceiling and refuses once it
 * is reached, counting retries across every runner from the ONE shared counter
 * (the live enforcement the pre-flight route-plan count never provided, bead
 * p0wwp). A refused turn falls to the runner's deterministic floor rather than
 * crashing, and `refused` latches so the pipeline can surface an out-of-budget
 * review as degraded — a review that ran out of budget must SAY so, never floor
 * silently into a review that looks complete (#260).
 *
 * The circuit no longer FAILS CLOSED on a missing or malformed ceiling. Per #260,
 * "no budget means no ceiling, not no spend": a non-finite (`NaN`/`Infinity`) or
 * negative `max` yields an UNLIMITED budget that always grants (`max: Infinity`),
 * and an absent budget (see `absentBudgetGrant`) runs the review ungated. The old
 * clamp-to-zero was itself the bug — it turned a missing budget into a review of
 * pure deterministic fallbacks that rendered like a real one. R10's <5-invocation
 * count survives as a latency/quality target in the pre-flight route plan (the
 * Brita filter), not as a silent runtime floor. A finite `max >= 0` is honored
 * exactly, including a configured `0` — a real "spend nothing" that refuses every
 * turn, visibly, through the same `refused` surface.
 */

import { type BudgetGrant, type InvocationBudget, R10_BUDGET_EXHAUSTED } from "@rennet/types";

export function createInvocationBudget(max: number): InvocationBudget {
  // A finite, non-negative `max` is a real ceiling (0 = spend nothing, honored).
  // Anything else — NaN, ±Infinity, a negative — is NOT a valid ceiling, so per
  // #260 it means "no ceiling" (unlimited: `consumed >= Infinity` never holds),
  // never the old fail-closed zero that silently produced a fake review.
  const ceiling = Number.isFinite(max) && max >= 0 ? Math.floor(max) : Number.POSITIVE_INFINITY;
  let consumed = 0;
  let refused = false;

  return {
    max: ceiling,
    get consumed(): number {
      return consumed;
    },
    get remaining(): number {
      return ceiling - consumed;
    },
    get refused(): boolean {
      return refused;
    },
    tryConsume(purpose: string): BudgetGrant {
      if (consumed >= ceiling) {
        // Only a finite ceiling is ever reached; an unlimited budget never lands
        // here. A genuine exhaustion latches `refused` so the review surfaces it.
        refused = true;
        return {
          granted: false,
          code: R10_BUDGET_EXHAUSTED,
          purpose,
          consumed,
          max: ceiling,
          reason: `invocation budget exhausted: ${consumed}/${ceiling} used, refusing "${purpose}" (R10)`,
        };
      }
      consumed += 1;
      return { granted: true, purpose, consumed, remaining: ceiling - consumed };
    },
  };
}

/**
 * The grant for an ABSENT invocation budget (#260, replaces the fail-closed
 * `budgetAbsentRefusal` from #95). A runner handed no budget runs UNGATED: an
 * absent budget is no ceiling, not no spend. Shape mirrors an unlimited grant
 * (`remaining: Infinity`) so a caller's `grant.granted` branch stays uniform.
 */
export function absentBudgetGrant(purpose: string): Extract<BudgetGrant, { granted: true }> {
  return { granted: true, purpose, consumed: 0, remaining: Number.POSITIVE_INFINITY };
}
