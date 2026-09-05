import { describe, expect, it, vi } from "vitest";
import {
  createT3SeatTurn,
  outputSchemaFor,
  parseFinalMessageJson,
  type T3SeatSeam,
  type T3SeatThread,
  type T3SettledTurn,
} from "./t3-seat-turn";
import { createMetricsCollector } from "./turn-metrics";

// The seat leg maps a settled T3 turn onto the harness turn result the drafting ladder
// already consumes. Driven with a stub client so the mapping is the thing under test.
// packages/server/src/t3/client.test.ts proves the wire against the real bundle: connect,
// project, thread, and the settle wait on a provider that dies at the stream. No test
// drives a live model turn (that would spend the user's subscription).

const SCHEMA = { type: "object" } as const;
const START = { previousTurnId: null, requestedAt: "2026-09-03T10:00:00.000Z" };

const settled = (over: Partial<T3SettledTurn> = {}): T3SettledTurn => ({
  turnId: "turn-1",
  state: "completed",
  thread: { messages: [], session: null },
  ...over,
});

function stubs(outcomes: T3SettledTurn[], thread: Partial<T3SeatThread> = {}) {
  const startTurn = vi.fn(
    async (input: {
      threadId: string;
      text: string;
      outputSchema?: unknown;
      mcpServers?: unknown;
    }) => {
      void input;
      return START;
    },
  );
  let call = 0;
  const client = {
    startTurn,
    waitForTurnSettled: vi.fn(
      async (
        threadId: string,
        waitOptions?: { readonly signal?: AbortSignal; readonly after?: unknown },
      ) => {
        void threadId;
        void waitOptions;
        const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
        if (outcome === undefined) throw new Error("the test supplied no settled turn");
        return outcome;
      },
    ),
    interruptTurn: vi.fn(async (threadId: string) => void threadId),
  };
  const threadFor = vi.fn(async () => ({ threadId: "t-design", projectId: "p1", ...thread }));
  const onThread = vi.fn();
  const seam: T3SeatSeam = { client: async () => client, threadFor, onThread };
  return { seam, client, startTurn, threadFor, onThread };
}

const options = {
  seat: "design",
  provider: "claudeAgent" as const,
  model: "opus-4.8",
  effort: "high" as const,
  outputSchema: SCHEMA,
  label: "board.lens-draft",
};

describe("createT3SeatTurn", () => {
  it("runs every attempt on the SAME thread, attaching the schema once per turn", async () => {
    const { seam, client, startTurn, threadFor } = stubs([settled({ structuredOutput: { a: 1 } })]);
    const runTurn = createT3SeatTurn(seam, options);

    expect(await runTurn("BASE PROMPT", 0)).toEqual({
      status: "emitted",
      body: { a: 1 },
      observed: { model: "opus-4.8", apiKeySource: null },
    });
    await runTurn("REPAIR POINTERS", 1);

    // One thread; two turns on it, in order, each carrying the contract as a schema and
    // never as prompt text. The council's effort reaches the thread's model selection.
    expect(threadFor).toHaveBeenCalledTimes(2);
    expect(threadFor).toHaveBeenCalledWith({
      seat: "design",
      provider: "claudeAgent",
      model: "opus-4.8",
      effort: "high",
    });
    // Order matters, not membership: the base prompt is turn one and the repair is turn
    // two, on one thread id. A set of `toContain` checks would pass on the wrong order.
    expect(startTurn.mock.calls.map((call) => call[0])).toEqual([
      { threadId: "t-design", text: "BASE PROMPT", outputSchema: SCHEMA },
      { threadId: "t-design", text: "REPAIR POINTERS", outputSchema: SCHEMA },
    ]);
    // Each wait is scoped to ITS start, or the repair would read the drafting turn's
    // settlement off the thread and answer with the old board.
    expect(client.waitForTurnSettled.mock.calls.map((call) => call[1])).toEqual([
      { after: START },
      { after: START },
    ]);
  });

  it("tells the seam its thread as soon as it exists, before the turn starts", async () => {
    const { seam, onThread, startTurn } = stubs([settled({ structuredOutput: {} })]);
    const order: string[] = [];
    onThread.mockImplementation(() => order.push("thread"));
    startTurn.mockImplementation(async () => {
      order.push("turn");
      return START;
    });
    await createT3SeatTurn(seam, options)("P", 0);
    expect(order).toEqual(["thread", "turn"]);
    expect(onThread).toHaveBeenCalledWith(
      "design",
      { threadId: "t-design", projectId: "p1" },
      "claudeAgent",
    );
  });

  it("records ONE metric per turn, and a repair's usage is its own even on a recreated runner", async () => {
    const collector = createMetricsCollector();
    const drafting = { input_tokens: 50_000, output_tokens: 1_000 };
    const { seam } = stubs([
      settled({ structuredOutput: {}, usage: drafting, totalCostUsd: 1, durationMs: 8_000 }),
      // Claude's SDK reports usage CUMULATIVELY over a streaming session's turns, and the
      // settlement carries the previous turn's figure off the thread itself.
      settled({
        structuredOutput: {},
        usage: { input_tokens: 51_000, output_tokens: 1_400 },
        totalCostUsd: 1.5,
        durationMs: 2_500,
        previousUsage: { usage: drafting, totalCostUsd: 1 },
      }),
    ]);
    await createT3SeatTurn(seam, { ...options, collector })("BASE", 0);
    // A whole-board restart re-resolves the seat: a NEW runner for the same thread. It
    // must subtract the drafting turn all the same, or the repair bills it a second time.
    await createT3SeatTurn(seam, { ...options, collector })("REPAIR", 1);

    expect(collector.metrics).toHaveLength(2);
    expect(collector.metrics[0]?.usage).toMatchObject({ inputTokens: 50_000, outputTokens: 1_000 });
    // The delta, not 51_000 — billing the base prompt twice would be spend nobody spent.
    expect(collector.metrics[1]?.usage).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 400,
      reportedUsd: 0.5,
    });
    expect(collector.metrics[1]?.attempt).toBe(1);
    // The provider's own duration for the turn, not the wrapper's wall clock.
    expect(collector.metrics.map((m) => m.latencyMs)).toEqual([8_000, 2_500]);
    expect(collector.metrics.map((m) => m.label)).toEqual(["board.lens-draft", "board.lens-draft"]);
  });

  it("records each turn's OWN board tool-call count beside its tokens and its duration", async () => {
    // `lens-board-tools` D11, task 4.3. The board's counter is monotonic over the lane's
    // life, so a turn's own figure is what it moved by; recording the raw counter would
    // bill the drafting turn's calls to the repair as well.
    const collector = createMetricsCollector();
    const { seam, client } = stubs([settled({ structuredOutput: {}, durationMs: 100 })]);
    let calls = 0;
    // The seat's calls land WHILE its turn runs, so the stub moves the board's counter as
    // the turn settles: seven on the drafting turn, two more on the repair.
    const perTurn = [7, 2];
    client.waitForTurnSettled.mockImplementation(async () => {
      calls += perTurn.shift() ?? 0;
      return settled({ structuredOutput: {}, durationMs: 100 });
    });
    const turn = createT3SeatTurn(seam, { ...options, collector, toolCalls: () => calls });
    await turn("BASE", 0);
    await turn("REPAIR", 1);

    expect(calls, "the board saw nine calls in all").toBe(9);
    expect(collector.metrics.map((metric) => metric.toolCalls)).toEqual([7, 2]);
    // Beside, not instead of: the other two figures still reach the same record.
    expect(collector.metrics[0]?.latencyMs).toBe(100);
    expect(collector.metrics[0]?.label).toBe("board.lens-draft");
  });

  it("records ZERO for a seat that had a board and called it not once", async () => {
    // A real and interesting measurement — it is what a turn that ended without writing
    // looks like — and distinct from a seat that had no board at all.
    const collector = createMetricsCollector();
    const { seam } = stubs([settled({ structuredOutput: {} })]);
    await createT3SeatTurn(seam, { ...options, collector, toolCalls: () => 0 })("P", 0);
    expect(collector.metrics[0]?.toolCalls).toBe(0);
  });

  it("carries NO count when the seat has no board lane at all", async () => {
    // THE CONTROL FOR 4.3: drop the reader on this seat path and the count leaves the
    // record entirely. A `0` here would say the seat wrote nothing when the truth is that
    // nothing was measured.
    const collector = createMetricsCollector();
    const { seam } = stubs([settled({ structuredOutput: {} })]);
    await createT3SeatTurn(seam, { ...options, collector })("P", 0);
    expect(collector.metrics[0]?.toolCalls).toBeUndefined();
    expect("toolCalls" in (collector.metrics[0] ?? {})).toBe(false);
  });

  it("takes the whole figure when the session counter restarted below the previous turn", async () => {
    // T3 restarting the Claude session between draft and repair begins a new cumulative
    // counter; subtracting the old watermark would clamp the repair to zero spend.
    const collector = createMetricsCollector();
    const { seam } = stubs([
      settled({
        structuredOutput: {},
        usage: { input_tokens: 3_000, output_tokens: 200 },
        previousUsage: { usage: { input_tokens: 50_000, output_tokens: 1_000 } },
      }),
    ]);
    await createT3SeatTurn(seam, { ...options, collector })("REPAIR", 1);
    expect(collector.metrics[0]?.usage).toMatchObject({ inputTokens: 3_000, outputTokens: 200 });
  });

  it("falls back to the wrapper's wall clock when the settlement carries no duration", async () => {
    const collector = createMetricsCollector();
    const { seam } = stubs([settled({ structuredOutput: {} })]);
    let clock = 1_000;
    await createT3SeatTurn(seam, { ...options, collector }, () => (clock += 250))("P", 0);
    expect(collector.metrics[0]?.latencyMs).toBeGreaterThan(0);
    expect(collector.metrics[0]?.latencyMs).toBeLessThan(2_000);
  });

  it("fails a Claude turn that settled without structured output, and says so", async () => {
    const { seam } = stubs([settled({ thread: { messages: [], session: null } })]);
    expect(await createT3SeatTurn(seam, options)("P", 0)).toEqual({
      status: "failed",
      message: "the seat turn settled without structured output",
    });
  });

  it("reads a Codex seat's board out of its final message, since T3 does not surface one", async () => {
    const { seam } = stubs([
      settled({
        thread: {
          messages: [
            { role: "user", text: "draft" },
            { role: "assistant", text: 'Here it is:\n```json\n{"elements":[]}\n```' },
          ],
          session: null,
        },
      }),
    ]);
    const result = await createT3SeatTurn(seam, {
      ...options,
      provider: "codex",
      model: "gpt-5.6-sol",
    })("P", 0);
    expect(result).toEqual({
      status: "emitted",
      body: { elements: [] },
      observed: { model: "gpt-5.6-sol", apiKeySource: null },
    });
  });

  it("records a Codex turn's tokens off T3's context-window snapshot, since its settlement carries none", async () => {
    const collector = createMetricsCollector();
    const { seam } = stubs([
      settled({
        structuredOutput: { elements: [] },
        // T3's snapshot: `inputTokens` includes the cached share, as Codex reports it.
        tokenUsage: {
          usedTokens: 1_200,
          inputTokens: 1_000,
          cachedInputTokens: 300,
          outputTokens: 200,
        },
      }),
    ]);
    await createT3SeatTurn(seam, { ...options, collector, provider: "codex" })("P", 0);
    expect(collector.metrics[0]?.usage).toEqual({
      inputTokens: 700,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 0,
      totalTokens: 1_200,
      reportedUsd: null,
    });
  });

  it("reports a failed turn with T3's own reason, and records the metric anyway", async () => {
    const collector = createMetricsCollector();
    const { seam } = stubs([settled({ state: "error", errorMessage: "provider exited" })]);
    expect(await createT3SeatTurn(seam, { ...options, collector })("P", 0)).toEqual({
      status: "failed",
      message: "provider exited",
    });
    expect(collector.metrics[0]?.status).toBe("failed");
  });

  it("does not start a turn on a signal that is already aborted", async () => {
    const { seam, startTurn } = stubs([settled({ structuredOutput: {} })]);
    const controller = new AbortController();
    controller.abort();
    expect(await createT3SeatTurn(seam, { ...options, signal: controller.signal })("P", 0)).toEqual(
      { status: "failed", message: "the seat turn was interrupted" },
    );
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("interrupts the sidecar turn on abort and records what the interrupted turn spent", async () => {
    // Cancelling the wait alone leaves the model running and spending on the sidecar. The
    // abort must reach T3 as an interrupt, and the settlement that interrupt produces
    // carries the usage the turn had already billed, so it is recorded rather than
    // booked as zero.
    const collector = createMetricsCollector();
    const { seam, client } = stubs([]);
    const controller = new AbortController();
    let settle: ((turn: T3SettledTurn) => void) | undefined;
    client.waitForTurnSettled.mockImplementation(
      () =>
        new Promise<T3SettledTurn>((resolve) => {
          settle = resolve;
        }),
    );
    client.interruptTurn.mockImplementation(async (threadId: string) => {
      settle?.(settled({ turnId: threadId, state: "interrupted", usage: { input_tokens: 7_000 } }));
    });
    const pending = createT3SeatTurn(seam, { ...options, collector, signal: controller.signal })(
      "P",
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await pending).toEqual({ status: "failed", message: "the seat turn was interrupted" });
    expect(client.interruptTurn).toHaveBeenCalledWith("t-design");
    expect(collector.metrics[0]?.usage).toMatchObject({ inputTokens: 7_000 });
  });

  it("gives up on a sidecar that never settles the interrupted turn", async () => {
    vi.useFakeTimers();
    try {
      const { seam, client } = stubs([]);
      const controller = new AbortController();
      client.waitForTurnSettled.mockImplementation(
        (_threadId: string, waitOptions?: { signal?: AbortSignal }) =>
          new Promise<T3SettledTurn>((_, reject) => {
            waitOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pending = createT3SeatTurn(seam, { ...options, signal: controller.signal })("P", 0);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toEqual({ status: "failed", message: "the seat turn was interrupted" });
      expect(client.interruptTurn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades a thrown sidecar call to an honest turn failure, never a throw", async () => {
    const seam: T3SeatSeam = {
      client: async () => {
        throw new Error("sidecar is down");
      },
      threadFor: async () => ({ threadId: "t", projectId: "p" }),
    };
    expect(await createT3SeatTurn(seam, options)("P", 0)).toEqual({
      status: "failed",
      message: "sidecar is down",
    });
  });
});

describe("createT3SeatTurn reports provider settlement (the milestone the ephemeral legs emit)", () => {
  // The round-report's diagnostic stream reads `provider-settled`. When the board seats
  // moved onto threads it was the one milestone with no producer on this leg, so a slow
  // sidecar turn and a slow host looked identical from outside.
  const settlements = async (outcomes: T3SettledTurn[] | Error) => {
    const seen: { outcome: string; elapsedMs: number }[] = [];
    const seam = Array.isArray(outcomes)
      ? stubs(outcomes).seam
      : ({
          client: async () => {
            throw outcomes;
          },
          threadFor: async () => ({ threadId: "t-design", projectId: "p1" }),
        } as unknown as T3SeatSeam);
    const runTurn = createT3SeatTurn(seam, {
      ...options,
      onProviderSettled: ({ outcome, elapsedMs }) => seen.push({ outcome, elapsedMs }),
    });
    await runTurn("BASE PROMPT", 0);
    return seen;
  };

  it("reports `completed` exactly once for a settled turn", async () => {
    const seen = await settlements([settled({ structuredOutput: { a: 1 } })]);
    expect(seen.map(({ outcome }) => outcome)).toEqual(["completed"]);
    expect(seen[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("reports `failed` for a turn the sidecar settled as an error", async () => {
    const seen = await settlements([settled({ state: "error", errorMessage: "provider died" })]);
    expect(seen.map(({ outcome }) => outcome)).toEqual(["failed"]);
  });

  it("reports `cancelled` for an interrupted turn", async () => {
    const seen = await settlements([settled({ state: "interrupted" })]);
    expect(seen.map(({ outcome }) => outcome)).toEqual(["cancelled"]);
  });

  it("reports `threw` when the seam itself blows up, and still only once", async () => {
    const seen = await settlements(new Error("the sidecar is gone"));
    expect(seen.map(({ outcome }) => outcome)).toEqual(["threw"]);
  });
});

describe("parseFinalMessageJson", () => {
  it("reads a fenced block, a bare object, and refuses prose", () => {
    expect(parseFinalMessageJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseFinalMessageJson('Here: {"a":1}')).toEqual({ a: 1 });
    expect(parseFinalMessageJson("[1,2]")).toEqual([1, 2]);
    expect(parseFinalMessageJson("I could not do it.")).toBeUndefined();
    expect(parseFinalMessageJson("{not json")).toBeUndefined();
  });
});

describe("the schema each provider actually accepts (drive 1.6, 2026-09-03)", () => {
  // Zod projects a `$schema` draft the Claude CLI's validator rejects, and a typeless
  // `additionalProperties: {}` plus absent-from-`required` optionals that Codex's strict
  // structured outputs 400 on. T3 forwards whatever it is handed, so the seat leg shapes it.
  const zodShaped = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string" } },
    required: ["a"],
    additionalProperties: {},
  };

  it("strips the draft for Claude and leaves the shape alone", () => {
    const shaped = outputSchemaFor("claudeAgent", zodShaped) as Record<string, unknown>;
    expect(shaped).not.toHaveProperty("$schema");
    expect(shaped.additionalProperties).toEqual({});
    expect(shaped.required).toEqual(["a"]);
  });

  it("makes the schema strict for Codex: no typeless additionalProperties, every property required", () => {
    const shaped = outputSchemaFor("codex", zodShaped) as Record<string, unknown>;
    expect(shaped.additionalProperties).toBe(false);
    expect(shaped.required).toEqual(["a", "b"]);
  });

  it("hands the provider-shaped schema to startTurn, and strips the nulls a strict Codex turn emits", async () => {
    const { seam, startTurn } = stubs([settled({ structuredOutput: { a: 1, b: null } })]);
    const runTurn = createT3SeatTurn(seam, {
      ...options,
      provider: "codex",
      outputSchema: zodShaped,
    });
    const result = await runTurn("BASE PROMPT", 0);
    const sent = startTurn.mock.calls[0]?.[0]?.outputSchema as Record<string, unknown>;
    expect(sent.additionalProperties).toBe(false);
    expect(sent).not.toHaveProperty("$schema");
    // The optional field Codex was forced to emit as null is absent again for the parser.
    expect(result).toMatchObject({ status: "emitted", body: { a: 1 } });
    expect((result as { body: Record<string, unknown> }).body).not.toHaveProperty("b");
  });
});

// ── The inline-context measurement rides the turn metric, at the send ─────────

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

describe("createT3SeatTurn — inline context is measured where the prompt is sent", () => {
  it("stamps a 10 KB JSON layer on the metric beside its tokens, and nothing for a path reference", async () => {
    const collector = createMetricsCollector();
    const { seam, startTurn } = stubs([
      settled({ structuredOutput: {}, usage: { input_tokens: 4_000, output_tokens: 100 } }),
      settled({ structuredOutput: {}, usage: { input_tokens: 4_500, output_tokens: 150 } }),
    ]);
    const runTurn = createT3SeatTurn(seam, { ...options, collector });
    await runTurn(INLINE_LAYER, 0);
    await runTurn(PATH_REFERENCE, 1);

    // The measurement is of the text `startTurn` actually sent, not of some earlier layer.
    expect(startTurn.mock.calls[0]?.[0].text).toBe(INLINE_LAYER);
    expect(collector.metrics[0]?.inlineContextBytes).toBeGreaterThan(10_000);
    expect(collector.metrics[0]?.usage).toMatchObject({ inputTokens: 4_000 });
    expect(collector.metrics[1]).not.toHaveProperty("inlineContextBytes");
  });
});

// ── The seat's board address (`lens-board-tools` 2.6) ────────────────────────

describe("a seat turn carries its own board server, by name and by variable", () => {
  const boardServer = {
    name: "rennet_board",
    url: "http://127.0.0.1:51234/board/QUFBQUFB",
    bearerTokenEnvVar: "RENNET_BOARD_BEARER",
  };

  it("names the seat's server on every turn of the thread, identically", async () => {
    const { seam, startTurn } = stubs([settled({ structuredOutput: {} })], { boardServer });
    const runTurn = createT3SeatTurn(seam, options);
    await runTurn("BASE PROMPT", 0);
    await runTurn("REPAIR POINTERS", 1);

    const sent = startTurn.mock.calls.map((call) => call[0].mcpServers);
    // Both providers fix the session's MCP configuration when the child is created, so a
    // repair naming a different set would be refused by the adapter as a mismatch.
    expect(sent).toEqual([
      { rennet_board: { url: boardServer.url, bearerTokenEnvVar: "RENNET_BOARD_BEARER" } },
      { rennet_board: { url: boardServer.url, bearerTokenEnvVar: "RENNET_BOARD_BEARER" } },
    ]);
  });

  it("carries the variable NAME and never a credential", async () => {
    const { seam, startTurn } = stubs([settled({ structuredOutput: {} })], { boardServer });
    await createT3SeatTurn(seam, options)("P", 0);
    // Everything the turn sends, as one string. The bearer's VALUE lives in the sidecar's
    // environment; what travels here is the name of the variable holding it, because this
    // command is written to the sidecar's event store and Claude's SDK puts its whole MCP
    // option on the child's argument list.
    const sent = JSON.stringify(startTurn.mock.calls[0]?.[0]);
    expect(sent).toContain("RENNET_BOARD_BEARER");
    expect(sent).not.toContain('bearerToken"');
    expect(sent).not.toContain("Bearer ");
  });

  it("a seat whose lane has no board names no server at all", async () => {
    const { seam, startTurn } = stubs([settled({ structuredOutput: {} })]);
    await createT3SeatTurn(seam, options)("P", 0);
    // Not an empty map: an empty `mcpServers` is a set the session would be opened
    // against, and a later turn that DID carry the board would then be a mismatch.
    expect(startTurn.mock.calls[0]?.[0]).not.toHaveProperty("mcpServers");
  });
});
