import { R10_BUDGET_EXHAUSTED } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createInvocationBudget } from "./invocation-budget";

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
});
