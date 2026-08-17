import type { HarnessEvent, SessionOutcome } from "@rennet/core";
import { describe, expect, it } from "vitest";
import {
  buildOmpTurnArgs,
  encodeOmpPromptFrame,
  OmpAdapter,
  type OmpTurnSpec,
  type OmpTurnTransport,
} from "./omp-adapter";

// ── A fake OmpTurnTransport over canned NDJSON frame arrays (no process) ─────
//
// The transport contract: yield the raw `omp --mode rpc` frames, then exactly ONE
// synthetic `{ rennet: "turn-result", ... }` terminal frame carrying exitCode, the
// captured final text. The adapter owns normalization,
// seq, and the terminal outcome; these tests inject frames and assert the normalized
// stream. Every shape here is a DOCUMENTED omp `.d.ts` shape — no turn has been run.

type Frame = unknown | ((spec: OmpTurnSpec) => unknown);

function fakeTransport(frames: readonly Frame[]): {
  fn: OmpTurnTransport;
  invoked: () => boolean;
  spec: () => OmpTurnSpec | null;
} {
  let invoked = false;
  let captured: OmpTurnSpec | null = null;
  const fn: OmpTurnTransport = (spec) => {
    captured = spec;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        invoked = true;
        for (const frame of frames) {
          yield typeof frame === "function" ? (frame as (s: OmpTurnSpec) => unknown)(spec) : frame;
        }
      },
    };
  };
  return { fn, invoked: () => invoked, spec: () => captured };
}

function adapter(fn: OmpTurnTransport): OmpAdapter {
  return new OmpAdapter({
    binaryPath: "/x/omp",
    transport: fn,
    version: "17.1.3",
  });
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

const READY = { type: "ready", protocolVersion: 1 };
const RESULT_OK = (finalText: string | null) => ({
  rennet: "turn-result",
  exitCode: 0,
  finalText,
});

describe("OmpAdapter", () => {
  it("normalizes a completed turn with final text, deltas, and increasing seq", async () => {
    const structured = { ok: true };
    const t = fakeTransport([
      READY,
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "wor",
          contentIndex: 0,
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify(structured) }],
        },
      },
      RESULT_OK(JSON.stringify(structured)),
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
      expect(outcome.finalText).toBe(JSON.stringify(structured));
      expect(outcome.structuredOutput).toBeUndefined();
      expect(outcome.usage).toBeUndefined();
    }
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events[0]?.native).toEqual(READY);
  });

  it("does not claim structured output for invalid-but-JSON text that omp never schema-validated", async () => {
    const raw = '{"ok":"wrong type"}';
    const t = fakeTransport([READY, RESULT_OK(raw)]);
    const session = await adapter(t.fn).createSession({
      cwd: "/repo",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    await session.send({ prompt: "go" });
    const { outcome } = await drain(session);
    expect(outcome).toMatchObject({ status: "completed", finalText: raw });
    if (outcome?.status === "completed") expect(outcome.structuredOutput).toBeUndefined();
  });

  it("emits session.started only once when both ready and agent_start arrive", async () => {
    const t = fakeTransport([READY, { type: "agent_start" }, RESULT_OK("done")]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events } = await drain(session);
    expect(events.filter((e) => e.kind === "session.started")).toHaveLength(1);
    // The second session-ish frame surfaces as passthrough, never a dropped frame.
    expect(events.some((e) => e.kind === "passthrough" && e.nativeKind === "agent_start")).toBe(
      true,
    );
  });

  it("surfaces an unmodelled frame as passthrough with the raw native", async () => {
    const weird = { type: "mystery_frame", payload: 42 };
    const t = fakeTransport([READY, weird, RESULT_OK(null)]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events } = await drain(session);
    const pass = events.find((e) => e.kind === "passthrough");
    expect(pass).toBeDefined();
    expect(pass?.native).toEqual(weird);
  });

  it("maps tool execution frames to a started/output lifecycle with ToolKind", async () => {
    const t = fakeTransport([
      READY,
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: "a.ts\n",
      },
      {
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "mcp__canvasops__canvas.read",
        args: { ref: "r1" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: "mcp__canvasops__canvas.read",
        result: { ok: true },
      },
      RESULT_OK(null),
    ]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events } = await drain(session);
    const kinds = events
      .filter(
        (e): e is Extract<HarnessEvent, { kind: "tool.started" }> => e.kind === "tool.started",
      )
      .map((e) => e.call.kind);
    expect(kinds).toEqual(["exec", "mcp"]);
    const outputs = events.filter(
      (e): e is Extract<HarnessEvent, { kind: "tool.output" }> => e.kind === "tool.output",
    );
    expect(outputs.map((e) => [e.callId, e.ok])).toEqual([
      ["c1", true],
      ["c2", true],
    ]);
    expect(outputs[0]?.text).toBe("a.ts\n");
    expect(outputs[1]?.output).toEqual({ ok: true });
  });

  it("maps a nonzero exit to a failed outcome with class and origin", async () => {
    const t = fakeTransport([
      READY,
      { type: "error", message: "stream disconnected before completion" },
      {
        rennet: "turn-result",
        exitCode: 1,
        finalText: null,
        stderr: "boom",
      },
    ]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status === "failed") {
      expect(outcome.error.class).toBeTruthy();
      expect(["harness", "provider", "transport", "adapter"]).toContain(outcome.error.origin);
    }
  });

  it("maps any rejected RPC response to a failed outcome and preserves the response as native evidence", async () => {
    const rejected = {
      id: "prompt-1",
      type: "response",
      command: "prompt",
      success: false,
      error: "prompt rejected",
      code: "INVALID_PROMPT",
    };
    const t = fakeTransport([READY, rejected, RESULT_OK(null)]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events, outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    expect(events.some((event) => event.kind === "error" && event.native === rejected)).toBe(true);
  });

  it("closes with a protocol failure when the stream ends without a terminal frame", async () => {
    const t = fakeTransport([READY, { type: "message_update", assistantMessageEvent: {} }]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { outcome } = await drain(session);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status === "failed") expect(outcome.error.class).toBe("protocol");
  });

  it("cancels the turn when the signal aborts", async () => {
    const t = fakeTransport([
      READY,
      (spec: OmpTurnSpec) => ({
        rennet: "turn-result",
        exitCode: 0,
        finalText: null,
        aborted: spec.signal?.aborted ?? false,
      }),
    ]);
    const abort = new AbortController();
    const session = await adapter(t.fn).createSession({
      cwd: "/repo",
      signal: abort.signal,
    });
    await session.send({ prompt: "go" });
    abort.abort();
    const { outcome } = await drain(session);
    expect(outcome?.status).toBe("cancelled");
  });

  it("does not invoke the transport before a turn is sent", async () => {
    const t = fakeTransport([RESULT_OK(null)]);
    await adapter(t.fn).createSession({ cwd: "/repo" });
    expect(t.invoked()).toBe(false);
  });

  it("awaits transport termination from interrupt and close", async () => {
    let terminated = false;
    const transport: OmpTurnTransport = (spec) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        yield READY;
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
        yield {
          rennet: "turn-result",
          exitCode: 0,
          finalText: null,
          aborted: true,
        };
      },
    });
    const session = await adapter(transport).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const draining = drain(session);
    await Promise.resolve();
    await session.interrupt();
    expect(terminated).toBe(true);
    await expect(draining).resolves.toMatchObject({
      outcome: { status: "cancelled" },
    });
    await session.close();
  });

  it("settles a failed outcome and close when the injected transport throws synchronously", async () => {
    const transport: OmpTurnTransport = () => {
      throw new Error("sync construction failed");
    };
    const session = await adapter(transport).createSession({ cwd: "/repo" });
    const draining = drain(session);
    await expect(session.send({ prompt: "go" })).rejects.toThrow("sync construction failed");
    await expect(draining).resolves.toMatchObject({
      outcome: { status: "failed" },
    });
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("settles a failed outcome and close when the injected transport fails asynchronously", async () => {
    const transport: OmpTurnTransport = () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        yield READY;
        throw new Error("async spawn failed");
      },
    });
    const session = await adapter(transport).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const draining = drain(session);
    await expect(draining).resolves.toMatchObject({
      outcome: { status: "failed" },
    });
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("makes the same captured events handle single-use", async () => {
    const session = await adapter(fakeTransport([RESULT_OK(null)]).fn).createSession({
      cwd: "/repo",
    });
    const captured = session.events;
    await session.send({ prompt: "go" });
    for await (const _event of captured) void _event;
    await expect(async () => {
      for await (const _event of captured) void _event;
    }).rejects.toThrow("omp session events may only be subscribed to once");
  });

  it("builds an evidence-derived descriptor: no evidence → every layer false, range honest-absent", () => {
    const a = adapter(fakeTransport([]).fn);
    for (const cap of Object.values(a.descriptor.capabilities)) {
      expect(cap.implementedByAdapter).toBe(false);
      expect(cap.advertisedByHarness).toBe(false);
      expect(cap.availableInSession).toBe(false);
    }
    expect(a.descriptor.id).toBe("omp");
    // No omp entry in harness-tested-range.json yet → no fabricated tested range.
    expect(a.descriptor.testedRange).toBeUndefined();
  });

  it("reports an explicit untested health state while no real-run range exists", async () => {
    await expect(adapter(fakeTransport([]).fn).health()).resolves.toEqual({
      state: "degraded",
      version: "17.1.3",
      reason: "untested",
    });
  });

  it("constructing the adapter and reading the descriptor invokes no transport", () => {
    const t = fakeTransport([RESULT_OK(null)]);
    const a = adapter(t.fn);
    void a.descriptor;
    expect(t.invoked()).toBe(false);
  });
});

describe("buildOmpTurnArgs", () => {
  it("assembles the capable-by-default RPC argv with no approval-requesting or read-only flag", () => {
    const args = buildOmpTurnArgs({
      cwd: "/repo",
      model: "opus",
      extensionPath: "/tmp/rennet-omp-turn",
    });
    // The RPC transport (the pi-compatible surface; NOT acp).
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("rpc");
    // The Rule Zero acting path: full capability, no approval prompts.
    expect(args).toContain("--auto-approve");
    // Ephemeral, fresh per turn.
    expect(args).toContain("--no-session");
    // Real repo cwd.
    expect(args).toContain("--cwd");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/repo");
    // Model + scratch extension containing omp's supported mcp.json source.
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).toContain("--extension");
    expect(args).toContain("/tmp/rennet-omp-turn");
    expect(args).not.toContain("--config");
    // Denylist: no approval-requesting / write-gating / read-only / session-resume / acp.
    for (const banned of [
      "--approval-mode",
      "always-ask",
      "--plan-yolo",
      "--plan",
      "--no-tools",
      "acp",
      "-r",
      "--resume",
      "-c",
      "--continue",
    ]) {
      expect(args).not.toContain(banned);
    }
    // The ONLY approval-shaped token is the capable-by-default posture itself.
    expect(args.filter((a) => /approv/i.test(a))).toEqual(["--auto-approve"]);
  });

  it("omits model/extension flags when absent", () => {
    const args = buildOmpTurnArgs({ cwd: "/repo" });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--extension");
    expect(args).toEqual(["--mode", "rpc", "--auto-approve", "--no-session", "--cwd", "/repo"]);
  });

  it("encodes the prompt as a stdin RPC command, never a positional arg", () => {
    const args = buildOmpTurnArgs({ cwd: "/repo" });
    expect(args).not.toContain("hello");
    expect(encodeOmpPromptFrame("hello")).toBe('{"type":"prompt","message":"hello"}\n');
  });
});
