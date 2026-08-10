import { createSeqCounter, type EnvelopeContext } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { extractResultUsage, normalizeClaudeFrame } from "./claude-adapter";

// Issue #186: the Claude adapter extracts the result frame's `usage` into
// `RspTokenUsage` and threads it onto the completed `SessionOutcome`, so the
// runner stamps real tokens into provenance instead of ZERO_TOKENS.

function context(): EnvelopeContext {
  return {
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    seq: createSeqCounter(),
    now: () => 0,
  };
}

describe("extractResultUsage (#186)", () => {
  it("maps the Claude usage block into RspTokenUsage, summing total", () => {
    const usage = extractResultUsage({
      usage: {
        input_tokens: 2,
        output_tokens: 4242,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 50624,
      },
    });
    expect(usage).toEqual({
      input: 2,
      output: 4242,
      cacheRead: 0,
      cacheWrite: 50624,
      reasoning: null,
      total: 54868,
    });
  });

  it("returns undefined for a frame with no usage (a genuine null, not a substituted zero)", () => {
    expect(extractResultUsage({ type: "result" })).toBeUndefined();
  });
});

describe("normalizeClaudeFrame — usage on the completed outcome (#186)", () => {
  it("threads the usage onto a completed session.ended outcome", () => {
    const events = normalizeClaudeFrame(
      {
        type: "result",
        subtype: "success",
        result: "done",
        structured_output: { findings: [] },
        usage: {
          input_tokens: 2,
          output_tokens: 5072,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 49550,
        },
      },
      context(),
    );
    const ended = events.find((e) => e.kind === "session.ended");
    expect(ended?.kind).toBe("session.ended");
    if (ended?.kind === "session.ended" && ended.outcome.status === "completed") {
      expect(ended.outcome.usage?.total).toBe(54624);
      expect(ended.outcome.structuredOutput).toEqual({ findings: [] });
    }
  });

  it("omits usage when the result frame carried none", () => {
    const events = normalizeClaudeFrame(
      { type: "result", subtype: "success", result: "done" },
      context(),
    );
    const ended = events.find((e) => e.kind === "session.ended");
    if (ended?.kind === "session.ended" && ended.outcome.status === "completed") {
      expect(ended.outcome.usage).toBeUndefined();
    }
  });
});
