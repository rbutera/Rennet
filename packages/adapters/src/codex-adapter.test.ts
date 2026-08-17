import type { HarnessEvent, SessionOutcome } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { CodexAdapter, type CodexTurnSpec, type CodexTurnTransport } from "./codex-adapter";
import type { CodexTurnResultFrame } from "./codex-app-server";

// ── A fake CodexTurnTransport over canned app-server frames (no process) ──────
//
// The transport contract: yield the raw `codex app-server` notification objects
// (`{ method, params }`), then exactly ONE synthetic `{ rennet: "turn-result", … }`
// terminal frame carrying the final status/message/usage. The adapter owns
// normalization, seq, and the terminal outcome.

type Frame = unknown | ((spec: CodexTurnSpec) => unknown);

function fakeTransport(frames: readonly Frame[]): {
  fn: CodexTurnTransport;
  invoked: () => boolean;
} {
  let invoked = false;
  const fn: CodexTurnTransport = (spec) => ({
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      invoked = true;
      for (const frame of frames) {
        yield typeof frame === "function" ? (frame as (s: CodexTurnSpec) => unknown)(spec) : frame;
      }
    },
  });
  return { fn, invoked: () => invoked };
}

function adapter(fn: CodexTurnTransport): CodexAdapter {
  return new CodexAdapter({ binaryPath: "/x/codex", transport: fn, version: "0.146.0" });
}

async function drain(session: {
  events: AsyncIterable<HarnessEvent>;
}): Promise<{ events: HarnessEvent[]; outcome: SessionOutcome | null }> {
  const events: HarnessEvent[] = [];
  let outcome: SessionOutcome | null = null;
  for await (const event of session.events) {
    events.push(event);
    if (event.kind === "session.ended") outcome = event.outcome;
  }
  return { events, outcome };
}

const STARTED = { method: "turn/started", params: { threadId: "th", turn: { id: "turn_1" } } };
const completed = (
  status: CodexTurnResultFrame["status"],
  extra: Partial<CodexTurnResultFrame> = {},
): CodexTurnResultFrame => ({
  rennet: "turn-result",
  status,
  finalMessage: null,
  ...extra,
});

describe("CodexAdapter", () => {
  it("normalizes a completed turn with structured output, usage, and increasing seq", async () => {
    const structured = { ok: true };
    const usage = {
      total: {
        inputTokens: 31_751,
        cachedInputTokens: 14_720,
        outputTokens: 2_367,
        reasoningOutputTokens: 701,
        totalTokens: 34_118,
      },
    };
    const t = fakeTransport([
      STARTED,
      { method: "item/agentMessage/delta", params: { delta: '{"ok":' } },
      {
        method: "item/completed",
        params: { item: { id: "item_1", type: "agentMessage", text: JSON.stringify(structured) } },
      },
      { method: "thread/tokenUsage/updated", params: { tokenUsage: usage } },
      completed("completed", { finalMessage: JSON.stringify(structured) }),
    ]);
    const session = await adapter(t.fn).createSession({
      cwd: "/repo",
      outputSchema: { type: "object" },
    });
    await session.send({ prompt: "go" });
    const { events, outcome } = await drain(session);

    expect(events[0]?.kind).toBe("session.started");
    expect(events.some((e) => e.kind === "text.delta")).toBe(true);
    expect(events.some((e) => e.kind === "text.message")).toBe(true);
    expect(outcome?.status).toBe("completed");
    if (outcome?.status === "completed") {
      expect(outcome.structuredOutput).toEqual(structured);
      expect(outcome.usage).toEqual({
        input: 17_031,
        output: 2_367,
        cacheRead: 14_720,
        cacheWrite: 0,
        reasoning: 701,
        total: 34_118,
      });
    }
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events[0]?.native).toEqual(STARTED);
  });

  it("surfaces an unmodelled frame as passthrough with the raw native", async () => {
    const weird = { method: "model/rerouted", params: { to: "gpt-x" } };
    const t = fakeTransport([STARTED, weird, completed("completed")]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events } = await drain(session);
    const pass = events.find((e) => e.kind === "passthrough");
    expect(pass).toBeDefined();
    expect(pass?.native).toEqual(weird);
  });

  it("maps app-server started/completed command, MCP, and file-change items to lifecycles", async () => {
    const t = fakeTransport([
      STARTED,
      {
        method: "item/started",
        params: {
          item: {
            id: "item_1",
            type: "commandExecution",
            command: "ls",
            aggregatedOutput: "",
            status: "inProgress",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          item: {
            id: "item_1",
            type: "commandExecution",
            command: "ls",
            aggregatedOutput: "a.ts\n",
            exitCode: 0,
            status: "completed",
          },
        },
      },
      {
        method: "item/started",
        params: {
          item: {
            id: "item_2",
            type: "mcpToolCall",
            server: "canvasops",
            tool: "canvas.read",
            arguments: { ref: "r1" },
            status: "inProgress",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          item: {
            id: "item_2",
            type: "mcpToolCall",
            server: "canvasops",
            tool: "canvas.read",
            arguments: { ref: "r1" },
            result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } },
            error: null,
            status: "completed",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          item: {
            id: "item_3",
            type: "fileChange",
            changes: [{ path: "a.ts", kind: "update" }],
            status: "completed",
          },
        },
      },
      completed("completed"),
    ]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events } = await drain(session);
    const kinds = events
      .filter(
        (e): e is Extract<HarnessEvent, { kind: "tool.started" }> => e.kind === "tool.started",
      )
      .map((e) => e.call.kind);
    expect(kinds).toEqual(["exec", "mcp", "write"]);
    const outputs = events.filter(
      (e): e is Extract<HarnessEvent, { kind: "tool.output" }> => e.kind === "tool.output",
    );
    expect(outputs.map((event) => [event.callId, event.ok])).toEqual([
      ["item_1", true],
      ["item_2", true],
      ["item_3", true],
    ]);
    expect(outputs[0]?.text).toBe("a.ts\n");
    expect(outputs[1]?.output).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
    });
  });

  it("maps a turn failure to a failed outcome with class and origin, message verbatim", async () => {
    const message = "stream disconnected before completion";
    const t = fakeTransport([
      STARTED,
      completed("failed", {
        error: { source: "turn", message, codexErrorInfo: "serverOverloaded" },
      }),
    ]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status === "failed") {
      expect(outcome.error.message).toBe(message);
      expect(outcome.error.class).toBe("overloaded");
      expect(outcome.error.origin).toBe("provider");
    }
  });

  it("preserves an auth-expiry turn error message verbatim to the outcome", async () => {
    const message = "Your ChatGPT auth token has expired. Run codex login.";
    const t = fakeTransport([
      STARTED,
      completed("failed", { error: { source: "turn", message, codexErrorInfo: "unauthorized" } }),
    ]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status !== "failed") throw new Error("expected a failed outcome");
    expect(outcome.error.message).toBe(message);
    expect(outcome.error.class).toBe("auth");
  });

  it("cancels the turn when the signal aborts", async () => {
    const t = fakeTransport([
      STARTED,
      (spec: CodexTurnSpec) =>
        completed(spec.signal?.aborted ? "cancelled" : "completed", { finalMessage: null }),
    ]);
    const abort = new AbortController();
    const session = await adapter(t.fn).createSession({ cwd: "/repo", signal: abort.signal });
    await session.send({ prompt: "go" });
    abort.abort();
    const { outcome } = await drain(session);
    expect(outcome?.status).toBe("cancelled");
  });

  it("closes with a protocol failure when the stream ends without a terminal frame", async () => {
    const t = fakeTransport([STARTED]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status === "failed") expect(outcome.error.class).toBe("protocol");
  });

  it("does not invoke the transport before a turn is sent", async () => {
    const t = fakeTransport([completed("completed")]);
    await adapter(t.fn).createSession({ cwd: "/repo" });
    expect(t.invoked()).toBe(false);
  });

  it("awaits transport termination from interrupt and close", async () => {
    let terminated = false;
    const transport: CodexTurnTransport = (spec) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        yield STARTED;
        if (!spec.signal?.aborted) {
          await new Promise<void>((resolve) =>
            spec.signal?.addEventListener(
              "abort",
              () =>
                setTimeout(() => {
                  terminated = true;
                  resolve();
                }, 20),
              { once: true },
            ),
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 20));
          terminated = true;
        }
        yield completed("cancelled");
      },
    });
    const session = await adapter(transport).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const draining = drain(session);
    await Promise.resolve();
    await session.interrupt();
    expect(terminated).toBe(true);
    await expect(draining).resolves.toMatchObject({ outcome: { status: "cancelled" } });
    await session.close();
  });

  it("throws a plain error on a second events subscription", async () => {
    const session = await adapter(fakeTransport([completed("completed")]).fn).createSession({
      cwd: "/repo",
    });
    const first = session.events;
    expect(first).toBeDefined();
    expect(() => session.events).toThrow("Codex session events may only be subscribed to once");
  });

  it("builds an evidence-derived descriptor: no evidence → every layer false", () => {
    const a = adapter(fakeTransport([]).fn);
    for (const cap of Object.values(a.descriptor.capabilities)) {
      expect(cap.implementedByAdapter).toBe(false);
      expect(cap.advertisedByHarness).toBe(false);
      expect(cap.availableInSession).toBe(false);
    }
    expect(a.descriptor.id).toBe("codex");
  });
});
