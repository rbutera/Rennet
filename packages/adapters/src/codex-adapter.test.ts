import type { HarnessEvent, SessionOutcome } from "@rennet/core";
import { describe, expect, it } from "vitest";
import {
  buildCodexTurnArgs,
  CodexAdapter,
  type CodexTurnSpec,
  type CodexTurnTransport,
} from "./codex-adapter";

// ── A fake CodexTurnTransport over canned JSONL frame arrays (no process) ────
//
// The transport contract: yield the raw codex `--json` frames, then exactly ONE
// synthetic `{ rennet: "turn-result", ... }` terminal frame carrying exitCode and
// the `-o` last-message capture. The adapter owns normalization, seq, and the
// terminal outcome; these tests inject frames and assert the normalized stream.

type Frame = unknown | ((spec: CodexTurnSpec) => unknown);

function fakeTransport(frames: readonly Frame[]): {
  fn: CodexTurnTransport;
  invoked: () => boolean;
  spec: () => CodexTurnSpec | null;
} {
  let invoked = false;
  let captured: CodexTurnSpec | null = null;
  const fn: CodexTurnTransport = (spec) => {
    captured = spec;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        invoked = true;
        for (const frame of frames) {
          yield typeof frame === "function"
            ? (frame as (s: CodexTurnSpec) => unknown)(spec)
            : frame;
        }
      },
    };
  };
  return { fn, invoked: () => invoked, spec: () => captured };
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

const RESULT_OK = (lastMessage: string | null) => ({
  rennet: "turn-result",
  exitCode: 0,
  lastMessage,
});

describe("CodexAdapter", () => {
  it("normalizes a completed turn with structured output, usage, and increasing seq", async () => {
    const structured = { ok: true };
    const t = fakeTransport([
      { type: "thread.started", thread_id: "th_1" },
      { type: "turn.started" },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "wor" } },
      {
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: JSON.stringify(structured) },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 31_751,
          cached_input_tokens: 14_720,
          cache_write_input_tokens: 0,
          output_tokens: 2_367,
          reasoning_output_tokens: 701,
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
    // Every event carries a strictly increasing seq and its raw native frame.
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events[0]?.native).toEqual({ type: "thread.started", thread_id: "th_1" });
  });

  it("surfaces an unmodelled frame as passthrough with the raw native", async () => {
    const weird = { type: "mystery.frame", payload: 42 };
    const t = fakeTransport([{ type: "thread.started", thread_id: "th" }, weird, RESULT_OK(null)]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events } = await drain(session);
    const pass = events.find((e) => e.kind === "passthrough");
    expect(pass).toBeDefined();
    expect(pass?.native).toEqual(weird);
  });

  it("maps official started/completed command, MCP, and file-change shapes to honest lifecycles", async () => {
    const t = fakeTransport([
      { type: "thread.started", thread_id: "th" },
      {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "a.ts\n",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.started",
        item: {
          id: "item_2",
          type: "mcp_tool_call",
          server: "canvasops",
          tool: "canvas.read",
          arguments: { ref: "r1" },
          result: null,
          error: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_2",
          type: "mcp_tool_call",
          server: "canvasops",
          tool: "canvas.read",
          arguments: { ref: "r1" },
          result: { content: [{ type: "text", text: "ok" }], structured_content: { ok: true } },
          error: null,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_3",
          type: "file_change",
          changes: [{ path: "a.ts", kind: "update" }],
          status: "completed",
        },
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
      structured_content: { ok: true },
    });
  });

  it("retains item_type as a compatibility fallback", async () => {
    const t = fakeTransport([
      { type: "thread.started", thread_id: "th" },
      { type: "item.completed", item: { id: "legacy", item_type: "agent_message", text: "ok" } },
      RESULT_OK("ok"),
    ]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { events } = await drain(session);
    expect(events.some((event) => event.kind === "text.message")).toBe(true);
  });

  it("maps a nonzero exit to a failed outcome with class and origin", async () => {
    const t = fakeTransport([
      { type: "thread.started", thread_id: "th" },
      { type: "turn.failed", error: { message: "stream disconnected before completion" } },
      { rennet: "turn-result", exitCode: 1, lastMessage: null, stderr: "stream disconnected" },
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

  it("cancels the turn when the signal aborts (subprocess killed)", async () => {
    const t = fakeTransport([
      { type: "thread.started", thread_id: "th" },
      (spec: CodexTurnSpec) => ({
        rennet: "turn-result",
        exitCode: 0,
        lastMessage: null,
        aborted: spec.signal?.aborted ?? false,
      }),
    ]);
    const abort = new AbortController();
    const session = await adapter(t.fn).createSession({ cwd: "/repo", signal: abort.signal });
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
    const transport: CodexTurnTransport = (spec) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        yield { type: "thread.started", thread_id: "th" };
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
        yield { rennet: "turn-result", exitCode: 0, lastMessage: null, aborted: true };
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
    const session = await adapter(fakeTransport([RESULT_OK(null)]).fn).createSession({
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

describe("buildCodexTurnArgs", () => {
  it("assembles the capable-by-default agentic argv with no gating flag", () => {
    const args = buildCodexTurnArgs({
      cwd: "/repo",
      prompt: "review this",
      model: "gpt-5.6-sol",
      schemaPath: "/tmp/s.json",
      outPath: "/tmp/o.txt",
      mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } },
    });
    // JSONL streaming + the Rule Zero full-access posture.
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--ignore-user-config");
    // Real repo cwd — NEVER the utility port's git-repo-check skip.
    expect(args).toContain("-C");
    expect(args[args.indexOf("-C") + 1]).toBe("/repo");
    expect(args).not.toContain("--skip-git-repo-check");
    // No sandbox-mode / read-only / approval-REQUESTING flag anywhere. The only
    // "approval" token is the bypass posture itself (Rule Zero acting path).
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-s");
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("-a");
    expect(args).not.toContain("--full-auto");
    expect(args.filter((a) => /approval/i.test(a))).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    // Structured output + last-message capture.
    expect(args).toContain("--output-schema");
    expect(args).toContain("/tmp/s.json");
    expect(args).toContain("-o");
    expect(args).toContain("/tmp/o.txt");
    // MCP server URL override for canvasOps@2.
    expect(args).toContain("mcp_servers.canvasops.url=http://127.0.0.1:5000/mcp");
    // The prompt is positional and LAST.
    expect(args[args.length - 1]).toBe("review this");
  });

  it("omits schema/out/model flags when absent", () => {
    const args = buildCodexTurnArgs({ cwd: "/repo", prompt: "go" });
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain("-o");
    expect(args).not.toContain("-m");
    expect(args[args.length - 1]).toBe("go");
  });

  it("accounts cache writes as a distinct token bucket", async () => {
    const t = fakeTransport([
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          cache_write_input_tokens: 7,
          output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      },
      RESULT_OK(null),
    ]);
    const session = await adapter(t.fn).createSession({ cwd: "/repo" });
    await session.send({ prompt: "go" });
    const { outcome } = await drain(session);
    expect(outcome).toMatchObject({
      status: "completed",
      usage: { input: 40, cacheRead: 60, cacheWrite: 7, output: 5, total: 112 },
    });
  });
});
