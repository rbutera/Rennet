import { describe, expect, it } from "vitest";
import { canSendAskReply, composeAskReply } from "./ask-reply";

describe("composeAskReply (#382 M2, task 2.1 / decision 2)", () => {
  it("composes chip + direction into one reply (decision plus redirection)", () => {
    expect(
      composeAskReply({ chipLabel: "Narrow the lock", direction: "but keep the metric note" }),
    ).toBe("Narrow the lock\nbut keep the metric note");
  });

  it("a chip alone answers", () => {
    expect(composeAskReply({ chipLabel: "Async queue" })).toBe("Async queue");
  });

  it("text alone answers", () => {
    expect(composeAskReply({ direction: "show me the trade-offs first" })).toBe(
      "show me the trade-offs first",
    );
  });

  it("trims direction and drops a whitespace-only one", () => {
    expect(composeAskReply({ chipLabel: "Narrow the lock", direction: "   " })).toBe(
      "Narrow the lock",
    );
  });

  it("neither part is not sendable", () => {
    expect(composeAskReply({})).toBe("");
    expect(canSendAskReply({})).toBe(false);
    expect(canSendAskReply({ direction: " " })).toBe(false);
    expect(canSendAskReply({ chipLabel: "Async queue" })).toBe(true);
  });
});
