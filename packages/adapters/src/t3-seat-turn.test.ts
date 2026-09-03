import { describe, expect, it, vi } from "vitest";
import {
  createT3SeatTurn,
  outputSchemaFor,
  parseFinalMessageJson,
  type T3SeatSeam,
  type T3SettledTurn,
} from "./t3-seat-turn";
import { createMetricsCollector } from "./turn-metrics";

// The seat leg maps a settled T3 turn onto the harness turn result the drafting ladder
// already consumes. Driven with a stub client so the mapping is the thing under test; the
// wire is proven by packages/server/src/t3/client.test.ts against the real bundle.

const SCHEMA = { type: "object" } as const;

const settled = (over: Partial<T3SettledTurn> = {}): T3SettledTurn => ({
  turnId: "turn-1",
  state: "completed",
  thread: { messages: [], session: null },
  ...over,
});

function stubs(outcomes: T3SettledTurn[]) {
  const startTurn = vi.fn(
    async (input: { threadId: string; text: string; outputSchema?: unknown }) => void input,
  );
  let call = 0;
  const client = {
    startTurn,
    waitForTurnSettled: vi.fn(async () => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
      if (outcome === undefined) throw new Error("the test supplied no settled turn");
      return outcome;
    }),
  };
  const threadFor = vi.fn(async () => ({ threadId: "t-design", projectId: "p1" }));
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
    const { seam, startTurn, threadFor } = stubs([settled({ structuredOutput: { a: 1 } })]);
    const runTurn = createT3SeatTurn(seam, options);

    expect(await runTurn("BASE PROMPT", 0)).toEqual({
      status: "emitted",
      body: { a: 1 },
      observed: { model: "opus-4.8", apiKeySource: null },
    });
    await runTurn("REPAIR POINTERS", 1);

    // One thread; two turns on it, in order, each carrying the contract as a schema and
    // never as prompt text.
    expect(threadFor).toHaveBeenCalledTimes(2);
    // Order matters, not membership: the base prompt is turn one and the repair is turn
    // two, on one thread id. A set of `toContain` checks would pass on the wrong order.
    expect(startTurn.mock.calls.map((call) => call[0])).toEqual([
      { threadId: "t-design", text: "BASE PROMPT", outputSchema: SCHEMA },
      { threadId: "t-design", text: "REPAIR POINTERS", outputSchema: SCHEMA },
    ]);
    // The contract travels ONCE, as the schema. Never restated in the text (AGENTS.md).
    for (const [call] of startTurn.mock.calls) {
      expect(call?.text).not.toContain("object");
    }
  });

  it("tells the seam its thread as soon as it exists, before the turn starts", async () => {
    const { seam, onThread, startTurn } = stubs([settled({ structuredOutput: {} })]);
    const order: string[] = [];
    onThread.mockImplementation(() => order.push("thread"));
    startTurn.mockImplementation(async () => {
      order.push("turn");
    });
    await createT3SeatTurn(seam, options)("P", 0);
    expect(order).toEqual(["thread", "turn"]);
    expect(onThread).toHaveBeenCalledWith("design", { threadId: "t-design", projectId: "p1" });
  });

  it("records ONE metric per turn, and a repair's usage is its own, not the session's total", async () => {
    const collector = createMetricsCollector();
    const { seam } = stubs([
      settled({
        structuredOutput: {},
        usage: { input_tokens: 50_000, output_tokens: 1_000 },
        totalCostUsd: 1,
      }),
      // Claude's SDK reports usage CUMULATIVELY over a streaming session's turns.
      settled({
        structuredOutput: {},
        usage: { input_tokens: 51_000, output_tokens: 1_400 },
        totalCostUsd: 1.1,
      }),
    ]);
    const runTurn = createT3SeatTurn(seam, { ...options, collector });
    await runTurn("BASE", 0);
    await runTurn("REPAIR", 1);

    expect(collector.metrics).toHaveLength(2);
    expect(collector.metrics[0]?.usage).toMatchObject({ inputTokens: 50_000, outputTokens: 1_000 });
    // The delta, not 51_000 — billing the base prompt twice would be spend nobody spent.
    expect(collector.metrics[1]?.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 400 });
    expect(collector.metrics[1]?.attempt).toBe(1);
    expect(collector.metrics.map((m) => m.label)).toEqual(["board.lens-draft", "board.lens-draft"]);
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

  it("reports a failed turn with T3's own reason, and records the metric anyway", async () => {
    const collector = createMetricsCollector();
    const { seam } = stubs([settled({ state: "error", errorMessage: "provider exited" })]);
    expect(await createT3SeatTurn(seam, { ...options, collector })("P", 0)).toEqual({
      status: "failed",
      message: "provider exited",
    });
    expect(collector.metrics[0]?.status).toBe("failed");
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
