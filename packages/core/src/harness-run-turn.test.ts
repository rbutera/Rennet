import { bodyJsonSchema } from "@rennet/protocol";
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
import { createHarnessRunTurn } from "./harness-run-turn";

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

    expect(state.spec?.readOnly).toBe(true);
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
