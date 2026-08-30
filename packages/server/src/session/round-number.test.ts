import { ROUND_NO_REGEN, type RoundRecord } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { roundNumberForDispatch } from "./round-number";

const completed = {
  outcome: "completed",
  boardGeneration: "gen:first",
  regeneration: "complete",
  dispatchId: "dispatch:first",
} as unknown as RoundRecord;
const pending = {
  outcome: "completed",
  boardGeneration: ROUND_NO_REGEN,
  regeneration: "pending",
  dispatchId: "dispatch:pending",
} as unknown as RoundRecord;

describe("roundNumberForDispatch", () => {
  it("keeps a report retry on its pending ledger ordinal", () => {
    expect(roundNumberForDispatch([completed, pending], "dispatch:pending")).toBe(2);
  });

  it("assigns a fresh dispatch after the current ledger tail", () => {
    expect(roundNumberForDispatch([completed, pending], "dispatch:new")).toBe(3);
  });
});
