import type { SessionModel } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { advanceCursor, planResume } from "./resume";
import { mintSession } from "./state";

const base = (): SessionModel => mintSession("proj", { id: () => "s1", now: () => 1 });

describe("planResume", () => {
  it("is undefined for a session with no cursor (a first turn starts fresh)", () => {
    expect(planResume(base())).toBeUndefined();
  });

  it("carries the cursor's harness session id", () => {
    const session: SessionModel = {
      ...base(),
      harnessCursor: { harnessSessionId: "h9", lastAssistantMessageAnchor: "a9", turnCount: 3 },
    };
    expect(planResume(session)).toEqual({ harnessSessionId: "h9" });
  });
});

describe("advanceCursor", () => {
  it("mints a first cursor at turnCount 1 from a complete resume point", () => {
    const next = advanceCursor(base(), {
      harnessSessionId: "h1",
      lastAssistantMessageAnchor: "a1",
    });
    expect(next.harnessCursor).toEqual({
      harnessSessionId: "h1",
      lastAssistantMessageAnchor: "a1",
      turnCount: 1,
    });
  });

  it("increments turnCount from the prior cursor", () => {
    const session: SessionModel = {
      ...base(),
      harnessCursor: { harnessSessionId: "h1", lastAssistantMessageAnchor: "a1", turnCount: 2 },
    };
    const next = advanceCursor(session, {
      harnessSessionId: "h2",
      lastAssistantMessageAnchor: "a2",
    });
    expect(next.harnessCursor?.turnCount).toBe(3);
    expect(next.harnessCursor?.harnessSessionId).toBe("h2");
  });

  it("does not advance when the harness reported no session id (never fabricated)", () => {
    const session = base();
    expect(advanceCursor(session, { lastAssistantMessageAnchor: "a1" })).toBe(session);
  });

  it("does not advance on a session id without an anchor (the frozen cursor needs both)", () => {
    const session = base();
    expect(advanceCursor(session, { harnessSessionId: "h1" })).toBe(session);
  });
});
