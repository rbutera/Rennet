/**
 * The live invocation budget (issue #69, fixes bead p0wwp).
 *
 * R10's <5-invocation ceiling is the money circuit, and money is vital: it must
 * be enforced at runtime, not asserted once in a CI test. `buildRoutePlan` (the
 * Brita filter) computes a PRE-FLIGHT plan and refuses an over-budget diff SHAPE
 * before any spend — but its static count never sees the retries inside a runner
 * or the ordering phase, so a proposal that fails twice then an ordering pass
 * that fails twice can issue six model turns while the plan counted three.
 *
 * This budget closes that gap. It is ONE stateful counter, created per review
 * and threaded through every runner, consumed once per ACTUAL model turn. The
 * first attempt and every retry across decomposition AND ordering draw from the
 * same ceiling, so the total number of turns cannot exceed it regardless of
 * retries. A refusal is fail-closed and typed (`R10_BUDGET_EXHAUSTED`): a runner
 * that is refused falls to its deterministic floor rather than crash, so a
 * review still renders real canvases — the ceiling stops spend, never the review.
 */

import { type BudgetGrant, type InvocationBudget, R10_BUDGET_EXHAUSTED } from "@rennet/types";

/**
 * Create a shared invocation budget with the given ceiling. `tryConsume` grants
 * one invocation and increments the count while the count is below `max`, and
 * refuses once the ceiling is reached — a refusal never increments the count.
 * `consumed` and `remaining` reflect the live count.
 *
 * A `max` below zero is clamped to zero (a non-positive ceiling refuses every
 * invocation, which is the honest reading of "no budget"). `max` is floored to
 * an integer so a fractional ceiling cannot smuggle a partial invocation. A
 * non-finite `max` (`NaN`/`Infinity`) FAILS CLOSED to zero: money is a vital
 * circuit (R10, Rule 75), and `consumed >= NaN`/`consumed >= Infinity` is always
 * false, so an unvalidated non-finite ceiling would grant unlimited turns — the
 * exact wrong-side failure a vital gate must never take. "No valid budget" reads
 * as "no spend": every turn is refused and the runner falls to the floor.
 */
export function createInvocationBudget(max: number): InvocationBudget {
  const ceiling = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  let consumed = 0;

  return {
    max: ceiling,
    get consumed(): number {
      return consumed;
    },
    get remaining(): number {
      return ceiling - consumed;
    },
    tryConsume(purpose: string): BudgetGrant {
      if (consumed >= ceiling) {
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
