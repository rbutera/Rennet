import { describe, expect, it } from "vitest";
import {
  createMetricsCollector,
  extractClaudeUsage,
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

  it("reports no dollar figure when a turn carried no usage, and null for no turns", () => {
    expect(summarizeUsage([metric({}), metric({ usage: null })]).reportedUsd).toBeNull();
    expect(summarizeUsage([]).reportedUsd).toBeNull();
    expect(summarizeUsage([]).turns).toBe(0);
  });
});
