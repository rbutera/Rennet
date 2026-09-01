import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
  SessionSpec,
} from "@rennet/core";
import { describe, expect, it } from "vitest";
import { councilSeatTurn } from "./council-seat-turn";

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

interface FakeState {
  spec?: SessionSpec;
  closed: boolean;
}

function fakePort(events: HarnessEvent[], state: FakeState): HarnessPort {
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
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
        send: (): Promise<string> => Promise.resolve("t1"),
        interrupt: () => Promise.resolve(),
        close(): Promise<void> {
          state.closed = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
}

describe("councilSeatTurn — the Claude branch", () => {
  it("hands a board-pipeline Claude seat a spec with no settings narrowing", async () => {
    const state: FakeState = { closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "{}", structuredOutput: {} })],
      state,
    );
    const seat = councilSeatTurn(
      "lens-draft",
      { type: "object" },
      { claudePort: port, repoRoot: "/repo" },
      { availability: { installed: ["claude-code" as const] } },
    );
    expect("failure" in seat ? seat.failure : null).toBeNull();
    if ("failure" in seat) return;

    const result = await seat.runTurn("draft", 1);
    expect(result.status).toBe("emitted");
    // The tokenmaxx outage (2026-09-01): exactly these board jobs once carried a
    // settings-narrowing key (`ambientConfig: "isolated"`) that made the spawned
    // CLI skip ~/.claude/settings.json — and the ANTHROPIC_BASE_URL auth routing
    // in its env block — so every lens seat hit the API on a dead credential.
    // EXACT equality, not toMatchObject: any reintroduced narrowing key on this
    // spec reddens the test no matter what the key is named.
    expect(state.spec).toEqual({
      cwd: "/repo",
      outputSchema: { type: "object" },
      model: expect.any(String),
      effort: expect.any(String),
      ephemeral: true,
    });
    expect(state.closed).toBe(true);
  });
});
