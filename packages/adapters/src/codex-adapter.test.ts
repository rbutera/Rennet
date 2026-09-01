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

  it("rejects an over-cap raw response before parsing it (#727)", async () => {
    const structured = { note: "é".repeat(20) };
    const raw = JSON.stringify(structured);
    const bytes = new TextEncoder().encode(raw).length;
    expect(bytes).toBeGreaterThan(raw.length);

    const atCap = await adapter(
      fakeTransport([STARTED, completed("completed", { finalMessage: raw })]).fn,
    ).createSession({
      cwd: "/repo",
      outputSchema: { type: "object" },
      outputByteCap: bytes,
    });
    await atCap.send({ prompt: "go" });
    const passed = await drain(atCap);
    expect(passed.outcome?.status).toBe("completed");
    expect(
      passed.outcome?.status === "completed" ? passed.outcome.structuredOutput : undefined,
    ).toEqual(structured);

    const overCap = await adapter(
      fakeTransport([STARTED, completed("completed", { finalMessage: raw })]).fn,
    ).createSession({
      cwd: "/repo",
      outputSchema: { type: "object" },
      outputByteCap: bytes - 1,
    });
    await overCap.send({ prompt: "go" });
    const rejected = await drain(overCap);
    expect(rejected.outcome?.status).toBe("failed");
    expect(rejected.outcome?.status === "failed" ? rejected.outcome.error.message : "").toContain(
      "output cap",
    );
    // The raw message is never parsed, so no decoded value exists to surface.
    expect(JSON.stringify(rejected.events)).not.toContain('"structuredOutput"');
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

  it("interrupt() called from INSIDE the for-await body resolves (no consumer-drainage deadlock)", async () => {
    // The transport stays open until aborted, then finishes. The consumer awaits
    // interrupt() from inside its own loop body — parking the iterator at a yield.
    // With the independent pump, completion tracks the transport finishing, not
    // consumer drainage, so this must NOT deadlock.
    const transport: CodexTurnTransport = (spec) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        yield STARTED;
        if (!spec.signal?.aborted) {
          await new Promise<void>((resolve) =>
            spec.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        yield completed("cancelled");
      },
    });
    const session = await adapter(transport).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });

    const withinTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("deadlock: interrupt() never resolved")), ms),
        ),
      ]);

    let interruptResolved = false;
    const events: HarnessEvent[] = [];
    await withinTimeout(
      (async () => {
        for await (const event of session.events) {
          events.push(event);
          if (event.kind === "session.started") {
            await session.interrupt(); // from inside the loop — must not deadlock
            interruptResolved = true;
          }
        }
      })(),
      1_000,
    );
    expect(interruptResolved).toBe(true);
    expect(events.some((e) => e.kind === "session.ended")).toBe(true);
  });

  it("close() without a send resolves (no pre-send deadlock) and ends the events stream", async () => {
    // Subscribe to events but never send a turn, then close(). The port contract says
    // close() is always available; the pre-send state must settle, not hang.
    const session = await adapter(fakeTransport([]).fn).createSession({ cwd: "/repo" });
    const stream = session.events;
    const withinTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("deadlock: close() never resolved")), ms),
        ),
      ]);
    await withinTimeout(session.close(), 1_000);
    const events: HarnessEvent[] = [];
    await withinTimeout(
      (async () => {
        for await (const event of stream) events.push(event);
      })(),
      1_000,
    );
    // No turn ran, so there is no outcome to emit — the stream just ends cleanly.
    expect(events).toEqual([]);
  });

  it("emits EXACTLY ONE session.ended even if the transport throws during teardown after its terminal", async () => {
    const transport: CodexTurnTransport = () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        yield STARTED;
        yield completed("completed", { finalMessage: "ok" });
        throw new Error("teardown boom"); // thrown AFTER the terminal frame
      },
    });
    const session = await adapter(transport).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events, outcome } = await drain(session);
    expect(events.filter((e) => e.kind === "session.ended")).toHaveLength(1);
    expect(outcome?.status).toBe("completed");
    // The post-terminal teardown throw is surfaced as non-terminal evidence.
    expect(
      events.some((e) => e.kind === "passthrough" && e.nativeKind === "transport-teardown-error"),
    ).toBe(true);
  });

  it("fails the turn (naming the ceiling) when the stream floods past the buffer ceiling", async () => {
    const flood = 50;
    const transport: CodexTurnTransport = () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        for (let i = 0; i < flood; i += 1) yield { method: "model/verification", params: { n: i } };
        // NEVER a terminal — a hung, forever-streaming command.
      },
    });
    const codex = new CodexAdapter({
      binaryPath: "/x/codex",
      transport,
      version: "0.146.0",
      bufferCeiling: { maxEvents: 5, maxBytes: 64 * 1024 * 1024 },
    });
    const session = await codex.createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    // Let the pump flood past the ceiling BEFORE the consumer drains.
    await new Promise((resolve) => setImmediate(resolve));
    const { events, outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status === "failed") expect(outcome.error.message).toMatch(/buffer ceiling/);
    // EXACT retained sequence: the 5 accepted passthroughs (n 0..4, in order, no
    // duplicates), then exactly one terminal — the 6th frame was replaced by it.
    const ns = events
      .filter((e) => e.kind === "passthrough")
      .map((e) => (e as { native?: { params?: { n?: number } } }).native?.params?.n ?? -1);
    expect(ns).toEqual([0, 1, 2, 3, 4]);
    const endeds = events.filter((e) => e.kind === "session.ended");
    expect(endeds).toHaveLength(1);
    expect(events[events.length - 1]?.kind).toBe("session.ended");
  });

  it("keeps the failed-at-ceiling terminal LAST when a multi-event frame straddles the ceiling", async () => {
    const transport: CodexTurnTransport = () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        yield { method: "model/verification", params: { n: 0 } };
        yield { method: "model/verification", params: { n: 1 } };
        // A fileChange item/completed normalizes to TWO events (tool.started +
        // tool.output). The first crosses the ceiling and triggers settlement;
        // the second must NOT land after the terminal.
        yield {
          method: "item/completed",
          params: {
            item: { id: "fc_1", type: "fileChange", status: "completed", changes: [] },
          },
        };
      },
    });
    const codex = new CodexAdapter({
      binaryPath: "/x/codex",
      transport,
      version: "0.146.0",
      bufferCeiling: { maxEvents: 2, maxBytes: 64 * 1024 * 1024 },
    });
    const session = await codex.createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    await new Promise((resolve) => setImmediate(resolve));
    const { events, outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    const endeds = events.filter((e) => e.kind === "session.ended");
    expect(endeds).toHaveLength(1);
    expect(events[events.length - 1]?.kind).toBe("session.ended");
    // The straddling batch's trailing event never lands after settlement.
    expect(events.some((e) => e.kind === "tool.output")).toBe(false);
  });

  it("rejects send() after a pre-send close() settles the session", async () => {
    const transport = fakeTransport([completed("completed")]); // never runs — closed pre-send
    const session = await adapter(transport.fn).createSession({ cwd: "/repo" });
    const consumed = (async () => {
      const seen: unknown[] = [];
      for await (const event of session.events) seen.push(event);
      return seen;
    })();
    await session.close();
    await expect(
      Promise.race([
        consumed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
      ]),
    ).resolves.toEqual([]);
    await expect(async () => session.send({ prompt: "too late" })).rejects.toThrow(/closed/);
    expect(transport.invoked()).toBe(false);
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
