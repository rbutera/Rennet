import { describe, expect, it } from "vitest";
import { contextMeter } from "./context-meter";

describe("contextMeter: ask-don't-estimate (B09 cluster 3, task 3.2)", () => {
  it("reports the harness-provided occupancy and window, and derives fraction remaining", () => {
    const meter = contextMeter({ usedTokens: 30_000, windowTokens: 200_000 });
    expect(meter).toEqual({
      usedTokens: 30_000,
      windowTokens: 200_000,
      fractionRemaining: 0.85,
    });
  });

  it("is ABSENT (undefined) when the harness reported no occupancy — not zero, not estimated", () => {
    // RED-proof for the honest-absence rule: if the meter substituted a zero here,
    // the reader would see "0 tokens / unknown window" — a fabricated figure the
    // harness never gave. Absence is the honest state.
    expect(contextMeter({})).toBeUndefined();
    expect(contextMeter({ windowTokens: 200_000 })).toBeUndefined();
  });

  it("omits fractionRemaining when only occupancy is known — never a % the harness did not give", () => {
    const meter = contextMeter({ usedTokens: 42 });
    expect(meter).toEqual({ usedTokens: 42 });
    expect(meter?.fractionRemaining).toBeUndefined();
    expect(meter?.windowTokens).toBeUndefined();
  });

  it("clamps a stale occupancy above capacity to 0 free rather than reporting negative", () => {
    const meter = contextMeter({ usedTokens: 250_000, windowTokens: 200_000 });
    expect(meter?.fractionRemaining).toBe(0);
  });
});
