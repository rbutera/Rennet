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
 * The circuit no longer FAILS CLOSED on a malformed ceiling — but it does not
 * swing to the opposite extreme either. Per #260, "no budget means no ceiling, not
 * no spend"; but a malformed CEILING is a caller defect, not an instruction to
 * remove all limits. So a non-finite (`NaN`/`Infinity`) or negative `max` falls
 * back to the DEFAULT ceiling (`DEFAULT_MAX_HARNESS_INVOCATIONS`), the normal
 * configured behaviour every correctly-wired caller already gets: the review runs
 * and the model is used, but a wiring bug upstream cannot spend Rai's money without
 * limit. The old clamp-to-zero (which silently produced a review of pure
 * deterministic fallbacks) is dead in both directions — never a fake review, never
 * unbounded. An absent budget OBJECT at a runner (see `absentBudgetGrant`) still
 * runs the review ungated. R10's <5 survives as a latency/quality target in the
 * pre-flight route plan (the Brita filter), not as a silent runtime floor. A finite
 * `max >= 0` is honored exactly, including a configured `0` — a deliberate "spend
 * nothing" that refuses every turn, visibly, through `refused`. A malformed value
 * is NOT a `0`; the distinction (defect vs instruction) is the whole point.
 */

import { type BudgetGrant, type InvocationBudget, R10_BUDGET_EXHAUSTED } from "@rennet/types";
import { DEFAULT_MAX_HARNESS_INVOCATIONS } from "./route-plan";

export function createInvocationBudget(max: number): InvocationBudget {
  // A finite, non-negative `max` is a real ceiling (0 = spend nothing, honored).
  // Anything else — NaN, ±Infinity, a negative — is a caller DEFECT, not an
  // instruction to lift all limits, so it falls back to the DEFAULT ceiling (#260):
  // the review still runs and the model is used, but a wiring bug upstream cannot
  // spend without limit. Never the old fail-closed zero, never unbounded.
  const ceiling =
    Number.isFinite(max) && max >= 0 ? Math.floor(max) : DEFAULT_MAX_HARNESS_INVOCATIONS;
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
        // The ceiling is always finite (a malformed max fell back to the default),
        // so a genuine exhaustion latches `refused` — the pipeline reads it to
        // surface an out-of-budget review as degraded rather than complete.
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
