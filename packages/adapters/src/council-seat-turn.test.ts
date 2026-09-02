import type {
  CodexExecutor,
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
  SessionSpec,
} from "@rennet/core";
import { describe, expect, it } from "vitest";
import { councilSeatTurn, createCodexSwarmTurn } from "./council-seat-turn";
import { createMetricsCollector } from "./turn-metrics";

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

describe("createCodexSwarmTurn records usage (#737)", () => {
  it("records one metric per turn with Codex tokens and no dollar figure", async () => {
    const collector = createMetricsCollector();
    const executor: CodexExecutor = () =>
      Promise.resolve({
        output: { elements: [] },
        model: "gpt-5.6-terra",
        tokens: { input: 40, output: 8, cacheRead: 2, cacheWrite: 0, reasoning: null, total: 50 },
      });
    const runTurn = createCodexSwarmTurn(
      executor,
      "gpt-5.6-terra",
      "medium",
      {},
      {
        cwd: "/repo",
        collector,
        label: "board.lens-draft-flagged",
      },
    );
    const result = await runTurn("prompt", 1);
    expect(result.status).toBe("emitted");
    expect(collector.metrics).toEqual([
      expect.objectContaining({
        label: "board.lens-draft-flagged",
        attempt: 1,
        model: "gpt-5.6-terra",
        apiKeySource: null,
        status: "emitted",
        usage: {
          inputTokens: 40,
          outputTokens: 8,
          cacheReadTokens: 2,
          cacheCreationTokens: 0,
          totalTokens: 50,
          reportedUsd: null,
        },
      }),
    ]);
  });

  it("records a failed metric with null usage when the executor throws", async () => {
    const collector = createMetricsCollector();
    const executor: CodexExecutor = () => Promise.reject(new Error("codex died"));
    const runTurn = createCodexSwarmTurn(
      executor,
      "gpt-5.6-terra",
      "medium",
      {},
      {
        cwd: "/repo",
        collector,
      },
    );
    const result = await runTurn("prompt", 0);
    expect(result.status).toBe("failed");
    expect(collector.metrics).toEqual([
      expect.objectContaining({ status: "failed", usage: null, error: "codex died" }),
    ]);
  });

  it("records nothing without a collector (positive control for the tap)", async () => {
    const collector = createMetricsCollector();
    const executor: CodexExecutor = () => Promise.resolve({ output: {} });
    await createCodexSwarmTurn(executor, "m", "medium", {}, { cwd: "/repo" })("p", 0);
    expect(collector.metrics).toHaveLength(0);
  });
});
