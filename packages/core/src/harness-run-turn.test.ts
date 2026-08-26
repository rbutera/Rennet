import { renderLayer } from "@rennet/instructions";
import type { ContextSendRecord } from "@rennet/protocol";
import { bodyJsonSchema, sha256Hex } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
  SessionSpec,
  TurnInput,
} from "./harness";
import {
  createHarnessRunTurn,
  guardSeatTurn,
  type HarnessTurnResult,
  recordSeatSend,
} from "./harness-run-turn";

// ── A scripted fake harness over the HarnessPort interface (no adapters, no SDK) ──

function endedEvent(outcome: SessionOutcome): HarnessEvent {
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

function errorEvent(): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "error",
    error: {
      class: "upstream",
      origin: "provider",
      message: "boom",
      retryable: true,
      retryableSource: "inferred",
      nativeCode: "server_error",
    },
  };
}

interface FakeState {
  spec?: SessionSpec;
  sent: TurnInput[];
  closed: boolean;
}

function fakePort(events: HarnessEvent[], state: FakeState): HarnessPort {
  const descriptor = { id: "claude-code" } as unknown as HarnessDescriptor;
  return {
    descriptor,
    health(): Promise<HarnessHealth> {
      return Promise.resolve({ state: "ready", version: "2.1.0" });
    },
    createSession(spec: SessionSpec): Promise<HarnessSession> {
      state.spec = spec;
      const session: HarnessSession = {
        id: "s1",
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            for (const event of events) yield event;
          },
        },
        send(input: TurnInput): Promise<string> {
          state.sent.push(input);
          return Promise.resolve("t1");
        },
        interrupt(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          state.closed = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
}

describe("createHarnessRunTurn", () => {
  it("emits the structured output of a completed session as the body", async () => {
    const body = { chunks: [], edges: [], readingOrder: [], residue: [] };
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "done", structuredOutput: body })],
      state,
    );
    const runTurn = createHarnessRunTurn(port, {
      docType: "decomposition.proposal",
      cwd: "/repo",
    });

    const result = await runTurn("prompt", 0);

    expect(result.status).toBe("emitted");
    if (result.status === "emitted") expect(result.body).toEqual(body);
    // The turn actually ran and the session was torn down.
    expect(state.sent).toEqual([{ prompt: "prompt" }]);
    expect(state.closed).toBe(true);
  });

  it("creates a read-only session constrained to the docType output schema", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "", structuredOutput: {} })],
      state,
    );
    const runTurn = createHarnessRunTurn(port, {
      docType: "ordering",
      cwd: "/somewhere",
      model: "sonnet",
    });

    await runTurn("prompt", 0);

    expect(state.spec?.cwd).toBe("/somewhere");
    expect(state.spec?.model).toBe("sonnet");
    expect(state.spec?.outputSchema).toEqual(bodyJsonSchema("ordering"));
  });

  it("fails the turn when a completed session carries no structured output", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort([endedEvent({ status: "completed", finalText: "prose only" })], state);
    const runTurn = createHarnessRunTurn(port, {
      docType: "decomposition.proposal",
      cwd: "/repo",
    });

    const result = await runTurn("prompt", 0);

    expect(result.status).toBe("failed");
    expect(state.closed).toBe(true);
  });

  it("fails the turn on a failed outcome", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        endedEvent({
          status: "failed",
          error: {
            class: "auth",
            origin: "provider",
            message: "unauthorized",
            retryable: false,
            retryableSource: "inferred",
            nativeCode: "authentication_failed",
          },
        }),
      ],
      state,
    );
    const runTurn = createHarnessRunTurn(port, {
      docType: "decomposition.proposal",
      cwd: "/repo",
    });

    const result = await runTurn("prompt", 0);

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toContain("unauthorized");
  });

  it("fails the turn on an error frame before any session.ended", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort([errorEvent()], state);
    const runTurn = createHarnessRunTurn(port, {
      docType: "decomposition.proposal",
      cwd: "/repo",
    });

    const result = await runTurn("prompt", 0);

    expect(result.status).toBe("failed");
    expect(state.closed).toBe(true);
  });
});

describe("guardSeatTurn", () => {
  it("maps a THROWN (rejected) turn to a returned turn-failure (#96)", async () => {
    const throwing = async (): Promise<HarnessTurnResult> => {
      throw new Error("session/transport construction failed");
    };
    const guarded = guardSeatTurn(throwing);

    // The rejection does not escape — it becomes an honest turn-failure the seat
    // runners already handle by falling to their floor.
    const result = await guarded("prompt", 0);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toContain("session/transport construction failed");
    }
  });

  it("maps a non-Error throw and passes an emitted turn through unchanged", async () => {
    const body = { chunks: [] };
    const passthrough = async (_prompt: string, attempt: number): Promise<HarnessTurnResult> =>
      attempt === 0 ? Promise.reject("bare string boom") : { status: "emitted", body };
    const guarded = guardSeatTurn(passthrough);

    // Per-call: a throw on attempt 0 becomes a failure, and a later attempt still
    // runs and passes its emitted body straight through (the retry loop survives).
    const first = await guarded("p", 0);
    const second = await guarded("p", 1);

    expect(first.status).toBe("failed");
    if (first.status === "failed") expect(first.message).toContain("bare string boom");
    expect(second.status).toBe("emitted");
    if (second.status === "emitted") expect(second.body).toEqual(body);
  });

  it("does not re-throw when the thrown value is uncoercible to a string (#96)", async () => {
    // A null-prototype object makes String(value) itself throw. The guard's own
    // error-rendering must never re-throw and reopen the crash path it exists to
    // close — the turn must still map to an honest returned failure.
    const throwingUncoercible = async (): Promise<HarnessTurnResult> => {
      throw Object.create(null);
    };
    const guarded = guardSeatTurn(throwingUncoercible);

    const result = await guarded("prompt", 0);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toContain("an uncoercible non-Error value");
    }
  });
});

describe("recordSeatSend", () => {
  it("proves an expected context containing a payload delimiter from the exact sent block", async () => {
    const records: ContextSendRecord[] = [];
    const expectedContext = [
      "repo instructions describe this literal boundary:",
      "",
      "<<<rennet:layer payload>>>",
      "but this is still context body text",
    ].join("\n");
    const prompt = [
      renderLayer("base", "base"),
      renderLayer("context", expectedContext),
      renderLayer("payload", "real payload"),
    ].join("\n\n");
    const recorded = recordSeatSend(
      async () => ({ status: "emitted", body: {} }),
      { seat: "finding", harness: "claude-code" },
      (record) => records.push(record),
      expectedContext,
    );

    await recorded(prompt, 0);

    expect(records[0]).toMatchObject({
      contextIncluded: true,
      contextDigest: sha256Hex(expectedContext),
    });
  });

  it("does not claim an expected context when its rendered layer was budget-dropped", async () => {
    const records: ContextSendRecord[] = [];
    const expectedContext = "assembled but dropped by the prompt budget";
    const prompt = [renderLayer("base", "base"), renderLayer("payload", "payload")].join("\n\n");
    const recorded = recordSeatSend(
      async () => ({ status: "emitted", body: {} }),
      { seat: "ordering", harness: "codex" },
      (record) => records.push(record),
      expectedContext,
    );

    await recorded(prompt, 0);

    expect(records[0]).toMatchObject({ contextIncluded: false });
    expect(records[0]?.contextDigest).toBeUndefined();
  });

  it("records exact sent prompt bytes and parses context inclusion back from those bytes", async () => {
    const records: ContextSendRecord[] = [];
    const prompt = [
      "<<<rennet:layer base>>>",
      "base",
      "",
      "<<<rennet:layer context>>>",
      "context with café bytes",
      "",
      "<<<rennet:layer payload>>>",
      "payload",
    ].join("\n");
    const inner = async (): Promise<HarnessTurnResult> => ({ status: "emitted", body: {} });
    const recorded = recordSeatSend(inner, { seat: "finding", harness: "claude-code" }, (record) =>
      records.push(record),
    );

    await recorded(prompt, 0);

    expect(records).toEqual([
      {
        seat: "finding",
        harness: "claude-code",
        channel: "prompt",
        attempt: 0,
        promptBytes: new TextEncoder().encode(prompt).length,
        promptDigest: sha256Hex(prompt),
        contextIncluded: true,
        contextDigest: sha256Hex("context with café bytes"),
        sentAt: expect.any(String),
      },
    ]);
  });

  it("records contextIncluded false from a sent prompt with no context block", async () => {
    const records: ContextSendRecord[] = [];
    const prompt = "<<<rennet:layer base>>>\nbase\n\n<<<rennet:layer payload>>>\npayload";
    const recorded = recordSeatSend(
      async () => ({ status: "emitted", body: {} }),
      { seat: "ordering", harness: "codex" },
      (record) => records.push(record),
    );

    await recorded(prompt, 0);

    expect(records[0]).toMatchObject({ contextIncluded: false });
    expect(records[0]?.contextDigest).toBeUndefined();
  });

  it("records every attempt with that attempt's exact sent bytes", async () => {
    const records: ContextSendRecord[] = [];
    const recorded = recordSeatSend(
      async () => ({ status: "emitted", body: {} }),
      { seat: "decomposition", harness: "claude-code" },
      (record) => records.push(record),
    );

    await recorded("first prompt", 0);
    await recorded("second prompt", 1);

    expect(records.map((record) => [record.attempt, record.promptDigest])).toEqual([
      [0, sha256Hex("first prompt")],
      [1, sha256Hex("second prompt")],
    ]);
  });

  it("records before a throwing turn and composes inside guardSeatTurn", async () => {
    const records: ContextSendRecord[] = [];
    const throwing = async (): Promise<HarnessTurnResult> => {
      throw new Error("transport failed after handoff");
    };
    const guarded = guardSeatTurn(
      recordSeatSend(throwing, { seat: "narration", harness: "codex" }, (record) =>
        records.push(record),
      ),
    );

    const result = await guarded("sent before throw", 2);

    expect(result.status).toBe("failed");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ attempt: 2, promptDigest: sha256Hex("sent before throw") });
  });
});
