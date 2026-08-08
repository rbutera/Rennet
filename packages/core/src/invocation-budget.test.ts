import { R10_BUDGET_EXHAUSTED } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { budgetAbsentRefusal, createInvocationBudget } from "./invocation-budget";

describe("createInvocationBudget — the live R10 ceiling", () => {
  it("grants up to the ceiling then refuses, tracking consumed/remaining", () => {
    const budget = createInvocationBudget(3);
    expect(budget.max).toBe(3);
    expect(budget.consumed).toBe(0);
    expect(budget.remaining).toBe(3);

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
  });

  it("refuses the (max+1)th with a typed R10 refusal that does not change the count", () => {
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
    // A refusal is not a consumption: the count is unchanged and a later grant is
    // still impossible.
    expect(budget.consumed).toBe(2);
    expect(budget.tryConsume("d").granted).toBe(false);
  });

  it("a non-positive or fractional ceiling refuses every invocation / floors", () => {
    const zero = createInvocationBudget(0);
    expect(zero.tryConsume("x").granted).toBe(false);

    const negative = createInvocationBudget(-4);
    expect(negative.max).toBe(0);
    expect(negative.tryConsume("x").granted).toBe(false);

    const fractional = createInvocationBudget(1.9);
    expect(fractional.max).toBe(1);
    expect(fractional.tryConsume("x").granted).toBe(true);
    expect(fractional.tryConsume("y").granted).toBe(false);
  });

  it("a non-finite ceiling fails CLOSED (money vital circuit): NaN/Infinity refuse every invocation", () => {
    // Rule 75 (railway): a single fault must never make a vital circuit more
    // permissive. `Math.max(0, Math.floor(NaN))` is NaN and `Math.floor(Infinity)`
    // is Infinity, and `consumed >= NaN`/`consumed >= Infinity` is always false —
    // so an unvalidated non-finite ceiling would grant UNLIMITED turns. The honest
    // reading of "no valid budget" is "no spend": fail closed to zero.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const budget = createInvocationBudget(bad);
      expect(budget.max).toBe(0);
      let grants = 0;
      for (let i = 0; i < 10; i += 1) {
        if (budget.tryConsume(`turn-${i}`).granted) grants += 1;
      }
      expect(grants, `non-finite ceiling ${bad} must refuse every turn`).toBe(0);
    }
  });
});

describe("budgetAbsentRefusal — the fail-closed grant for an ABSENT budget (#95)", () => {
  it("mints a typed R10 refusal that is byte-identical (bar reason) to a zero-ceiling refusal", () => {
    // The money-critical shape lock (#95): an absent budget must refuse exactly
    // like an exhausted/zero one so downstream `budget-refused` handling stays
    // uniform. This test reds directly if `granted`, `code`, `purpose`, `consumed`
    // or `max` regress — the seat tests only catch it indirectly.
    const refusal = budgetAbsentRefusal("narration:attempt-0");
    const zeroCeiling = createInvocationBudget(0).tryConsume("narration:attempt-0");

    expect(refusal.granted).toBe(false);
    expect(zeroCeiling.granted).toBe(false);
    expect(refusal.code).toBe(R10_BUDGET_EXHAUSTED);
    expect(refusal.purpose).toBe("narration:attempt-0");
    expect(refusal.consumed).toBe(0);
    expect(refusal.max).toBe(0);
    if (!zeroCeiling.granted) {
      // Structural parity with a genuine zero-ceiling exhaustion (reason aside).
      expect(refusal.code).toBe(zeroCeiling.code);
      expect(refusal.consumed).toBe(zeroCeiling.consumed);
      expect(refusal.max).toBe(zeroCeiling.max);
    }
    // The reason names the absent-budget cause, not a fabricated exhaustion count.
    expect(refusal.reason).toContain("no invocation budget");
  });
});
