import type { SessionModel } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { HarnessError, SessionOutcome } from "../harness";
import { advanceCursor, dropCursor, isResumeVanished, planResume } from "./resume";
import { mintSession } from "./state";

const err = (klass: HarnessError["class"]): SessionOutcome => ({
  status: "failed",
  error: {
    class: klass,
    origin: "harness",
    message: klass,
    retryable: false,
    retryableSource: "inferred",
    nativeCode: null,
  },
});

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

describe("dropCursor", () => {
  it("clears the harness cursor but leaves the rest of the session intact", () => {
    const session: SessionModel = {
      ...base(),
      reviewId: "r1",
      harnessCursor: { harnessSessionId: "h1", lastAssistantMessageAnchor: "a1", turnCount: 5 },
    };
    const dropped = dropCursor(session);
    expect(dropped.harnessCursor).toBeUndefined();
    expect(dropped.reviewId).toBe("r1");
    expect(dropped.id).toBe(session.id);
  });
});

describe("isResumeVanished", () => {
  // Keyed on the harness's native SUBTYPE (preserved as nativeCode), not the broad
  // invalid-request class (B09 F4). The real adapter mapping is exercised in the
  // adapters test through normalizeClaudeFrame.
  const coded = (nativeCode: string, klass: HarnessError["class"] = "invalid-request") =>
    ({
      status: "failed" as const,
      error: {
        class: klass,
        origin: "harness" as const,
        message: nativeCode,
        retryable: false,
        retryableSource: "inferred" as const,
        nativeCode,
      },
    }) satisfies SessionOutcome;

  it("is true for an error_during_execution failure on a resumed turn (the transcript is gone)", () => {
    expect(isResumeVanished(true, coded("error_during_execution"))).toBe(true);
  });

  it("is false when resume was not attempted (a fresh turn cannot vanish)", () => {
    expect(isResumeVanished(false, coded("error_during_execution"))).toBe(false);
  });

  it("is false for model_not_found — same class, different code — so a bad model is not a vanish", () => {
    expect(isResumeVanished(true, coded("model_not_found"))).toBe(false);
  });

  it("is false for transient and auth failures (they would fail fresh too — not vanished)", () => {
    expect(isResumeVanished(true, err("rate-limit"))).toBe(false);
    expect(isResumeVanished(true, err("overloaded"))).toBe(false);
    expect(isResumeVanished(true, err("auth"))).toBe(false);
  });

  it("is false for a completed turn", () => {
    expect(isResumeVanished(true, { status: "completed", finalText: "ok" })).toBe(false);
  });
});
