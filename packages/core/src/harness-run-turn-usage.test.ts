import { describe, expect, it } from "vitest";
import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
} from "./harness";
import { createHarnessRunTurn } from "./harness-run-turn";

// Issue #186: real token usage on a completed `SessionOutcome` must be threaded
// through `createHarnessRunTurn` as `tokens`, so the runner that mints the RSP
// document stamps REAL counts into provenance instead of ZERO_TOKENS.

function ended(outcome: SessionOutcome): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "session.ended",
    outcome,
  };
}

function fakePort(events: HarnessEvent[]): HarnessPort {
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
    health: (): Promise<HarnessHealth> => Promise.resolve({ state: "ready", version: "2.1.0" }),
    createSession: (): Promise<HarnessSession> =>
      Promise.resolve({
        id: "s1",
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            for (const event of events) yield event;
          },
        },
        send: () => Promise.resolve("t1"),
        interrupt: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
  };
}

describe("createHarnessRunTurn — usage threading (#186)", () => {
  it("returns the completed outcome's usage as tokens", async () => {
    const usage = {
      input: 2,
      output: 100,
      cacheRead: 0,
      cacheWrite: 5000,
      reasoning: null,
      total: 5102,
    };
    const runTurn = createHarnessRunTurn(
      fakePort([
        ended({ status: "completed", finalText: "", structuredOutput: { ok: true }, usage }),
      ]),
      {
        docType: "finding",
        cwd: "/repo",
      },
    );
    const result = await runTurn("prompt", 0);
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") expect(result.tokens).toEqual(usage);
  });

  it("returns no tokens when the completed outcome carried no usage (never a substituted zero)", async () => {
    const runTurn = createHarnessRunTurn(
      fakePort([ended({ status: "completed", finalText: "", structuredOutput: { ok: true } })]),
      {
        docType: "finding",
        cwd: "/repo",
      },
    );
    const result = await runTurn("prompt", 0);
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") expect(result.tokens).toBeUndefined();
  });
});
