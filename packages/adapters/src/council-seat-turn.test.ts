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
      // Attribution only, never sent to the model: the seat label the log, the token
      // collector and a repair turn's caller identify this session by.
      label: "council.seat",
      outputSchema: { type: "object" },
      model: expect.any(String),
      effort: expect.any(String),
      ephemeral: true,
    });
    expect(state.closed).toBe(true);
  });

  // Review finding 1: T3 is a board seat's only backend. A daemon that composed a sidecar
  // and could not bring it up says so; the seat must NOT quietly become an ephemeral one.
  it("fails a board job with the sidecar's reason instead of taking the ephemeral leg", () => {
    const state: FakeState = { closed: false };
    const seat = councilSeatTurn(
      "lens-draft",
      { type: "object" },
      {
        claudePort: fakePort([], state),
        repoRoot: "/repo",
        t3Unavailable: "sidecar exited (code 1, signal null)",
      },
      { availability: { installed: ["claude-code" as const] } },
    );
    expect("failure" in seat ? seat.failure : null).toBe(
      "T3 sidecar unavailable: sidecar exited (code 1, signal null)",
    );
    // No session was ever opened — resolution failed before any harness was touched.
    expect(state.spec).toBeUndefined();
  });

  it("leaves a NON-board job on the ephemeral leg when the sidecar is unavailable", async () => {
    // The utility turns (scout, repo map, delta digest) never ran on a thread, so a
    // sidecar failure is not their failure. Positive control for the test above: same
    // deps, same `t3Unavailable`, and this one still resolves and runs.
    const state: FakeState = { closed: false };
    const seat = councilSeatTurn(
      "project-scout",
      { type: "object" },
      {
        claudePort: fakePort(
          [endedEvent({ status: "completed", finalText: "{}", structuredOutput: {} })],
          state,
        ),
        repoRoot: "/repo",
        t3Unavailable: "sidecar exited (code 1, signal null)",
      },
      { availability: { installed: ["claude-code" as const] } },
    );
    expect("failure" in seat ? seat.failure : null).toBeNull();
    if ("failure" in seat) return;
    expect((await seat.runTurn("scout", 1)).status).toBe("emitted");
    expect(state.spec?.cwd).toBe("/repo");
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
});

// ── The inline-context measurement rides the turn metric, on both ephemeral legs ──

/** Today's expensive shape: an inventory interpolated as one JSON literal. ~14 KB. */
const INLINE_LAYER = `Draft the board.\n${JSON.stringify({
  hunks: Array.from({ length: 100 }, (_, index) => ({
    path: `src/module-${index}.ts`,
    excerpt: "export const value = 1; ".repeat(5),
  })),
})}`;
/** The converted shape: the same turn, pointed at what it may read. */
const PATH_REFERENCE =
  "Draft the board. The context is in `.rennet/context/s1/README.md`; run `git diff main...HEAD` yourself.";

describe("inline context is measured where the prompt is sent", () => {
  it("the Claude leg (session.send) stamps a 10 KB layer on its metric, and nothing for a path reference", async () => {
    const collector = createMetricsCollector();
    const state: FakeState = { closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "{}", structuredOutput: {} })],
      state,
    );
    const seat = councilSeatTurn(
      "project-scout",
      { type: "object" },
      { claudePort: port, repoRoot: "/repo", collector },
      { availability: { installed: ["claude-code" as const] } },
    );
    if ("failure" in seat) throw new Error(seat.failure);
    await seat.runTurn(INLINE_LAYER, 0);
    await seat.runTurn(PATH_REFERENCE, 1);
    expect(collector.metrics[0]?.inlineContextBytes).toBeGreaterThan(10_000);
    expect(collector.metrics[1]).not.toHaveProperty("inlineContextBytes");
  });

  it("the Codex leg (the executor) stamps the same measurement", async () => {
    const collector = createMetricsCollector();
    const executor: CodexExecutor = () => Promise.resolve({ output: { elements: [] } });
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
    await runTurn(INLINE_LAYER, 0);
    await runTurn(PATH_REFERENCE, 1);
    expect(collector.metrics[0]?.inlineContextBytes).toBeGreaterThan(10_000);
    expect(collector.metrics[1]).not.toHaveProperty("inlineContextBytes");
  });
});
