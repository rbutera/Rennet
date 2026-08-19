import { describe, expect, it } from "vitest";
import { type DeltaAccountLike, deltaCounts } from "./delta-counts";

describe("deltaCounts (#382 M2, task 6.3)", () => {
  it("counts asks by status and beyond-asks", () => {
    const account: DeltaAccountLike = {
      asks: [
        { status: "addressed" },
        { status: "addressed" },
        { status: "partially-addressed" },
        { status: "untouched" },
      ],
      beyondAsks: ["a", "b"],
    };
    expect(deltaCounts(account)).toEqual({ addressed: 2, partially: 1, untouched: 1, beyond: 2 });
  });

  it("prefers hunk-grain beyond count when present", () => {
    const account: DeltaAccountLike = { asks: [], beyondAsks: ["a"], beyondAskHunks: [{}, {}, {}] };
    expect(deltaCounts(account).beyond).toBe(3);
  });

  it("an absent account is an honest all-zero, never a fabricated number", () => {
    expect(deltaCounts(undefined)).toEqual({ addressed: 0, partially: 0, untouched: 0, beyond: 0 });
  });
});
