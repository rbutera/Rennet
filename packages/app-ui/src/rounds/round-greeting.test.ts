import { describe, expect, it } from "vitest";
import { usageNote } from "./round-greeting";

// The one line that says what a generation cost (#737). Tokens always; a price only
// when the server could honestly sum one.
describe("usageNote", () => {
  const base = {
    turns: 7,
    inputTokens: 10_000,
    outputTokens: 2_345,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 12_345,
    reportedUsd: null,
  };

  it("names compact tokens and the seat-turn count, with no price on a subscription run", () => {
    const note = usageNote(base);
    expect(note).toBe("Spent 12.3K tokens across 7 seat turns");
    expect(note).not.toContain("$");
  });

  it("appends the provider's summed price only when the server reported one", () => {
    expect(usageNote({ ...base, reportedUsd: 0.4187 })).toBe(
      "Spent 12.3K tokens across 7 seat turns · $0.419",
    );
    expect(usageNote({ ...base, reportedUsd: 12.5 })).toContain("$12.50");
  });

  it("singularises one turn", () => {
    expect(usageNote({ ...base, turns: 1, totalTokens: 900 })).toBe(
      "Spent 900 tokens across 1 seat turn",
    );
  });
});
