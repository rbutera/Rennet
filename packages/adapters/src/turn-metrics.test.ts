import type {
  CodexExecRequest,
  CodexExecResult,
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
} from "@rennet/core";
import type { GenerationUsage } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  createInstrumentedRunTurn,
  createMetricsCollector,
  extractClaudeUsage,
  inlineContextMetric,
  instrumentCodexExecutor,
  mergeGenerationUsage,
  summarizeUsage,
  type TurnMetric,
} from "./turn-metrics";

describe("extractClaudeUsage", () => {
  it("parses the usage block off a Claude result frame and sums total", () => {
    const native = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 50,
      },
    };
    const usage = extractClaudeUsage(native);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(1200);
    expect(usage?.outputTokens).toBe(340);
    expect(usage?.cacheReadTokens).toBe(800);
    expect(usage?.cacheCreationTokens).toBe(50);
    // total = input + output + cache read + cache creation
    expect(usage?.totalTokens).toBe(2390);
    expect(usage?.reportedUsd).toBe(0.0123);
  });

  it("defaults absent counts to 0 and reportedUsd to null", () => {
    const usage = extractClaudeUsage({ type: "result", usage: { input_tokens: 5 } });
    expect(usage).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 5,
      reportedUsd: null,
    });
  });

  it("returns null for a frame with no usage object (a turn that produced no result)", () => {
    expect(extractClaudeUsage({ type: "result" })).toBeNull();
    expect(extractClaudeUsage(null)).toBeNull();
    expect(extractClaudeUsage("not-an-object")).toBeNull();
  });
});

describe("createMetricsCollector", () => {
  it("accumulates recorded metrics in order", () => {
    const collector = createMetricsCollector();
    const a: TurnMetric = {
      label: "finding",
      docType: "finding",
      attempt: 0,
      model: "claude-x",
      apiKeySource: "oauth",
      status: "emitted",
      latencyMs: 100,
      usage: null,
    };
    collector.record(a);
    collector.record({ ...a, attempt: 1 });
    expect(collector.metrics).toHaveLength(2);
    expect(collector.metrics[0]?.attempt).toBe(0);
    expect(collector.metrics[1]?.attempt).toBe(1);
  });
});

describe("summarizeUsage (#737)", () => {
  const metric = (over: Partial<TurnMetric>): TurnMetric => ({
    label: "board.lens-draft",
    docType: "review.hypothesis",
    attempt: 0,
    model: "claude-x",
    apiKeySource: "user",
    status: "emitted",
    latencyMs: 10,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 5,
      totalTokens: 155,
      reportedUsd: 0.01,
    },
    ...over,
  });

  it("sums every turn, retries and failures included, and prices only an all-metered run", () => {
    const usage = summarizeUsage([metric({}), metric({ attempt: 1, status: "failed" })]);
    expect(usage).toEqual({
      turns: 2,
      unmeasuredTurns: 0,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 60,
      cacheCreationTokens: 10,
      totalTokens: 310,
      reportedUsd: 0.02,
    });
  });

  it("reports no dollar figure when any turn ran on a subscription credential", () => {
    // Positive control above: the same two turns priced to 0.02 when both were metered.
    const usage = summarizeUsage([metric({}), metric({ apiKeySource: "none" })]);
    expect(usage.totalTokens).toBe(310);
    expect(usage.reportedUsd).toBeNull();
  });

  it("reports no dollar figure when a metered turn carried tokens but no price", () => {
    const usage = summarizeUsage([
      metric({}),
      metric({ usage: { ...(metric({}).usage as object), reportedUsd: null } as never }),
    ]);
    expect(usage.totalTokens).toBe(310);
    expect(usage.reportedUsd).toBeNull();
  });

  it("reports no dollar figure when a turn carried no usage, and null for no turns", () => {
    const oneUnmeasured = summarizeUsage([metric({}), metric({ usage: null })]);
    expect(oneUnmeasured.reportedUsd).toBeNull();
    expect(oneUnmeasured.unmeasuredTurns).toBe(1);
    expect(oneUnmeasured.turns).toBe(2);
    expect(oneUnmeasured.totalTokens).toBe(155);
    expect(summarizeUsage([]).reportedUsd).toBeNull();
    expect(summarizeUsage([]).turns).toBe(0);
  });
});

describe("mergeGenerationUsage (#741 review)", () => {
  const usage = (over: Partial<GenerationUsage> = {}): GenerationUsage => ({
    turns: 2,
    unmeasuredTurns: 0,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 5,
    cacheCreationTokens: 1,
    totalTokens: 116,
    reportedUsd: 0.5,
    ...over,
  });

  it("adds a repeat attempt to the prior total and keeps a price only when both priced", () => {
    expect(
      mergeGenerationUsage(usage(), usage({ turns: 1, totalTokens: 50, inputTokens: 40 })),
    ).toEqual(
      usage({
        turns: 3,
        totalTokens: 166,
        inputTokens: 140,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheCreationTokens: 2,
        reportedUsd: 1,
      }),
    );
    expect(mergeGenerationUsage(usage({ reportedUsd: null }), usage())?.reportedUsd).toBeNull();
    expect(mergeGenerationUsage(usage(), usage({ reportedUsd: null }))?.reportedUsd).toBeNull();
  });

  it("passes a lone side through and yields nothing for two absences", () => {
    expect(mergeGenerationUsage(undefined, usage())).toEqual(usage());
    expect(mergeGenerationUsage(usage(), undefined)).toEqual(usage());
    expect(mergeGenerationUsage(undefined, undefined)).toBeUndefined();
  });
});

// ── A turn that THROWS still spent its prompt ─────────────────────────────────
//
// `session.send` and the event iterator are both after the prompt is handed over, so a
// throw from either is money spent with no frame to read. The tap recorded nothing for
// them: no tokens (there are none to read) and, worse, no `inlineContextBytes` — the one
// figure that IS knowable, because it is measured from the prompt itself.

/** A prompt carrying an obvious inline payload, so the recorded measurement is non-trivial. */
const PAYLOAD_PROMPT = `Draft.\n${JSON.stringify({
  rows: Array.from({ length: 200 }, (_, i) => ({ i, p: `src/${i}.ts` })),
})}`;

function throwingPort(where: "send" | "events", closed: { value: boolean }): HarnessPort {
  const boom = new Error("the transport died mid-turn");
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
    health: (): Promise<HarnessHealth> => Promise.resolve({ state: "ready", version: "2.1.0" }),
    createSession: (): Promise<HarnessSession> =>
      Promise.resolve({
        id: "s1",
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            if (where === "events") throw boom;
            // The "send" case never gets here: `send` rejects before the stream is drained.
            yield* [] as HarnessEvent[];
          },
        },
        send: (): Promise<string> =>
          where === "send" ? Promise.reject(boom) : Promise.resolve("t1"),
        interrupt: (): Promise<void> => Promise.resolve(),
        close: (): Promise<void> => {
          closed.value = true;
          return Promise.resolve();
        },
      }),
  };
}

describe("createInstrumentedRunTurn — a thrown turn is still a recorded turn", () => {
  it.each(["send", "events"] as const)(
    "records one failed metric when %s throws",
    async (where) => {
      const collector = createMetricsCollector();
      const closed = { value: false };
      const runTurn = createInstrumentedRunTurn(
        throwingPort(where, closed),
        { docType: "finding", cwd: "/repo" },
        collector,
        "flagged",
      );

      // The throw still propagates — this is a tap, not a handler; `guardSeatTurn` upstream
      // owns the degradation, and swallowing here would change what the seat sees.
      await expect(runTurn(PAYLOAD_PROMPT, 2)).rejects.toThrow("the transport died mid-turn");

      expect(collector.metrics).toHaveLength(1);
      expect(collector.metrics[0]).toMatchObject({
        label: "flagged",
        attempt: 2,
        status: "failed",
        error: "the transport died mid-turn",
        usage: null,
      });
      // The load-bearing half: the prompt's own measurement, which no frame was needed for.
      expect(collector.metrics[0]?.inlineContextBytes).toBeGreaterThan(5_000);
      expect(closed.value).toBe(true);
    },
  );

  it("control: the same turn completing records one EMITTED metric, so the record is not a constant", async () => {
    const collector = createMetricsCollector();
    const ended: HarnessEvent = {
      seq: 1,
      harness: "claude-code",
      sessionId: "s1",
      turnId: "t1",
      receivedAt: 0,
      native: { usage: { input_tokens: 9 } },
      kind: "session.ended",
      outcome: { status: "completed", finalText: "done", structuredOutput: { ok: true } },
    } as HarnessEvent;
    const port: HarnessPort = {
      descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
      health: (): Promise<HarnessHealth> => Promise.resolve({ state: "ready", version: "2.1.0" }),
      createSession: (): Promise<HarnessSession> =>
        Promise.resolve({
          id: "s1",
          harness: "claude-code",
          events: {
            async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
              yield ended;
            },
          },
          send: (): Promise<string> => Promise.resolve("t1"),
          interrupt: (): Promise<void> => Promise.resolve(),
          close: (): Promise<void> => Promise.resolve(),
        }),
    };
    const runTurn = createInstrumentedRunTurn(
      port,
      { docType: "finding", cwd: "/repo" },
      collector,
      "flagged",
    );
    await expect(runTurn(PAYLOAD_PROMPT, 0)).resolves.toMatchObject({ status: "emitted" });
    expect(collector.metrics).toHaveLength(1);
    expect(collector.metrics[0]?.status).toBe("emitted");
  });
});

// ── The Codex utility ports ──────────────────────────────────────────────────
//
// Those ports drive `codex exec` directly: no session, so none of the instrumentation
// above sees them, and their sends carried neither their tokens nor their inlined bytes
// anywhere. Wrapping the EXECUTOR is the one place that covers every port, because a port
// cannot opt out of its own executor.

describe("instrumentCodexExecutor", () => {
  const request: CodexExecRequest = {
    model: "gpt-x",
    effort: "low",
    prompt: PAYLOAD_PROMPT,
    label: "delta-digest",
  };

  it("records the tokens and the inlined bytes of an emitted utility turn", async () => {
    const collector = createMetricsCollector();
    const executor = (): Promise<CodexExecResult> =>
      Promise.resolve({
        output: { digest: "it did the thing" },
        model: "gpt-x-2026-09",
        tokens: {
          input: 1_000,
          output: 200,
          cacheRead: 30,
          cacheWrite: 5,
          reasoning: null,
          total: 1_235,
        },
      });

    const result = await instrumentCodexExecutor(executor, collector, "codex-utility")(request);

    expect(result.output).toEqual({ digest: "it did the thing" });
    expect(collector.metrics).toHaveLength(1);
    expect(collector.metrics[0]).toMatchObject({
      // The per-call label wins over the executor's, so one shared executor still says
      // WHICH seat spent the tokens.
      label: "delta-digest",
      status: "emitted",
      model: "gpt-x-2026-09",
      // A subscription seat: no credential source, so `summarizeUsage` never prices it.
      apiKeySource: null,
    });
    expect(collector.metrics[0]?.usage).toMatchObject({ totalTokens: 1_235, reportedUsd: null });
    expect(collector.metrics[0]?.inlineContextBytes).toBeGreaterThan(5_000);
  });

  it("records a failed metric for a thrown exec and rethrows for the port's own catch", async () => {
    const collector = createMetricsCollector();
    const executor = (): Promise<CodexExecResult> => Promise.reject(new Error("codex exited 1"));
    const wrapped = instrumentCodexExecutor(executor, collector, "codex-utility");

    await expect(wrapped(request)).rejects.toThrow("codex exited 1");
    expect(collector.metrics).toHaveLength(1);
    expect(collector.metrics[0]).toMatchObject({
      label: "delta-digest",
      status: "failed",
      error: "codex exited 1",
      usage: null,
    });
    expect(collector.metrics[0]?.inlineContextBytes).toBeGreaterThan(5_000);
  });
});

describe("inlineContextMetric", () => {
  it("is the metric-shaped reading of the core measurement: a field when over the limit, nothing otherwise", () => {
    const layer = JSON.stringify({
      rows: Array.from({ length: 200 }, (_, i) => ({ i, p: `src/${i}.ts` })),
    });
    expect(inlineContextMetric(`Draft.\n${layer}`)).toEqual({
      inlineContextBytes: new TextEncoder().encode(layer).length,
    });
    expect(inlineContextMetric("Draft. Read `.rennet/context/s1/README.md` first.")).toEqual({});
  });
});
