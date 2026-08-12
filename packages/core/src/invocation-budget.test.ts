import { R10_BUDGET_EXHAUSTED } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { absentBudgetGrant, createInvocationBudget } from "./invocation-budget";

describe("createInvocationBudget — the live R10 ceiling", () => {
  it("grants up to the ceiling then refuses, tracking consumed/remaining/refused", () => {
    const budget = createInvocationBudget(3);
    expect(budget.max).toBe(3);
    expect(budget.consumed).toBe(0);
    expect(budget.remaining).toBe(3);
    expect(budget.refused).toBe(false);

    const first = budget.tryConsume("proposal");
    expect(first.granted).toBe(true);
    if (first.granted) {
      expect(first.consumed).toBe(1);
      expect(first.remaining).toBe(2);
    }
    expect(budget.consumed).toBe(1);
    expect(budget.remaining).toBe(2);

    budget.tryConsume("retry-1");
    budget.tryConsume("retry-2");
    expect(budget.consumed).toBe(3);
    expect(budget.remaining).toBe(0);
    // A genuine finite ceiling was fully spent but never exceeded — no refusal yet.
    expect(budget.refused).toBe(false);
  });

  it("refuses the (max+1)th with a typed R10 refusal, latches `refused`, keeps the count", () => {
    const budget = createInvocationBudget(2);
    budget.tryConsume("a");
    budget.tryConsume("b");
    const refused = budget.tryConsume("c");

    expect(refused.granted).toBe(false);
    if (!refused.granted) {
      expect(refused.code).toBe(R10_BUDGET_EXHAUSTED);
      expect(refused.purpose).toBe("c");
      expect(refused.consumed).toBe(2);
      expect(refused.max).toBe(2);
      expect(refused.reason).toContain("2/2");
    }
    // A genuine over-ceiling refusal latches so the review can surface it (#260).
    expect(budget.refused).toBe(true);
    // A refusal is not a consumption: the count is unchanged and a later grant is
    // still impossible.
    expect(budget.consumed).toBe(2);
    expect(budget.tryConsume("d").granted).toBe(false);
  });

  it("honours a configured zero ceiling (spend nothing) — refuses visibly, never silently", () => {
    // A literal 0 is a real "spend nothing" limit, distinct from an ABSENT budget:
    // it refuses every turn AND latches `refused` so the review is surfaced as
    // degraded, not floored into a fake completed review (#260 acceptance 2).
    const zero = createInvocationBudget(0);
    expect(zero.max).toBe(0);
    expect(zero.tryConsume("x").granted).toBe(false);
    expect(zero.refused).toBe(true);
  });

  it("a fractional ceiling floors to an integer (no partial invocation smuggled)", () => {
    const fractional = createInvocationBudget(1.9);
    expect(fractional.max).toBe(1);
    expect(fractional.tryConsume("x").granted).toBe(true);
    expect(fractional.tryConsume("y").granted).toBe(false);
  });

  it("a NON-FINITE or NEGATIVE ceiling means NO CEILING — unlimited, never fail-closed (#260)", () => {
    // #260 deletes the old clamp-to-zero. A missing/malformed ceiling is "no
    // ceiling, not no spend": it grants every turn (`max: Infinity`) and never
    // latches `refused`. The old behaviour (fail closed to zero, refuse all)
    // produced a silent review of pure deterministic fallbacks — the bug.
    for (const noCeiling of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -4]) {
      const budget = createInvocationBudget(noCeiling);
      expect(budget.max, `ceiling ${noCeiling} is unlimited`).toBe(Number.POSITIVE_INFINITY);
      let grants = 0;
      for (let i = 0; i < 10; i += 1) {
        if (budget.tryConsume(`turn-${i}`).granted) grants += 1;
      }
      expect(grants, `no-ceiling ${noCeiling} must grant every turn`).toBe(10);
      expect(budget.refused, `no-ceiling ${noCeiling} never refuses`).toBe(false);
    }
  });
});

describe("absentBudgetGrant — an ABSENT budget runs UNGATED (#260, replaces the fail-closed #95 refusal)", () => {
  it("mints an unlimited GRANT so a runner handed no budget spends normally", () => {
    // #260 inverts the #95 fail-closed default: no budget means no ceiling, not no
    // spend. This test reds directly if the helper regresses to a refusal — a
    // runner would then floor into a fake review exactly as the issue describes.
    const grant = absentBudgetGrant("narration:attempt-0");
    expect(grant.granted).toBe(true);
    expect(grant.purpose).toBe("narration:attempt-0");
    expect(grant.consumed).toBe(0);
    expect(grant.remaining).toBe(Number.POSITIVE_INFINITY);
  });
});
