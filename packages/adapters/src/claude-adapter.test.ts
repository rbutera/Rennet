import {
  createSeqCounter,
  type EnvelopeContext,
  type HarnessEvent,
  isResumeVanished,
  type SessionOutcome,
} from "@rennet/core";
import { describe, expect, it } from "vitest";
import {
  ClaudeAdapter,
  type ClaudeQueryArgs,
  type ClaudeQueryOptions,
  classifyToolKind,
  mapClaudeError,
  normalizeClaudeFrame,
} from "./claude-adapter";

function context(): EnvelopeContext {
  return {
    harness: "claude-code",
    sessionId: "session-1",
    turnId: "turn-1",
    seq: createSeqCounter(),
    now: () => 1000,
  };
}

function initFrame(apiKeySource: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: "abc",
    model: "claude-sonnet",
    cwd: "/repo",
    tools: ["Read", "Grep"],
    apiKeySource,
  };
}

describe("normalizeClaudeFrame: oauth assertion", () => {
  it("produces a metered-key warning when a metered key takes over", () => {
    const events = normalizeClaudeFrame(initFrame("user"), context());
    const started = events.find((event) => event.kind === "session.started");
    const warning = events.find((event) => event.kind === "auth.metered-key-warning");
    expect(started).toBeDefined();
    expect(started?.kind === "session.started" && started.apiKeySource).toBe("user");
    expect(warning).toBeDefined();
    expect(warning?.kind === "auth.metered-key-warning" && warning.apiKeySource).toBe("user");
  });

  it("produces NO warning on subscription oauth", () => {
    const events = normalizeClaudeFrame(initFrame("oauth"), context());
    expect(events.some((event) => event.kind === "session.started")).toBe(true);
    expect(events.some((event) => event.kind === "auth.metered-key-warning")).toBe(false);
    const started = events[0];
    expect(started?.kind === "session.started" && started.apiKeySource).toBe("oauth");
  });

  it("treats the live 'none' source as safe: recognized, no warning", () => {
    // The installed CLI reports apiKeySource="none" for a subscription session
    // (verified live 2026-08-06). It is not metered, so it must not warn.
    const events = normalizeClaudeFrame(initFrame("none"), context());
    const started = events.find((event) => event.kind === "session.started");
    expect(started?.kind === "session.started" && started.apiKeySource).toBe("none");
    expect(events.some((event) => event.kind === "auth.metered-key-warning")).toBe(false);
  });

  it("carries a null apiKeySource without warning when the source is unknown", () => {
    const frame = { type: "system", subtype: "init", model: "m", cwd: "/r", tools: [] };
    const events = normalizeClaudeFrame(frame, context());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === "session.started" && events[0].apiKeySource).toBeNull();
  });
});

describe("normalizeClaudeFrame: denials and errors", () => {
  it("renders a denied write as tool.denied, never as error", () => {
    const frame = {
      type: "system",
      subtype: "permission_denied",
      tool_use_id: "t1",
      tool_name: "Write",
      reason: "read-only review posture",
    };
    const events = normalizeClaudeFrame(frame, context());
    expect(events).toHaveLength(1);
    const denial = events[0];
    expect(denial?.kind).toBe("tool.denied");
    expect(denial?.kind === "tool.denied" && denial.toolName).toBe("Write");
    expect(denial?.kind === "tool.denied" && denial.by).toBe("policy");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("maps a result error to the taxonomy with an origin and ends failed", () => {
    const frame = {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      result: "budget exceeded",
    };
    const events = normalizeClaudeFrame(frame, context());
    const error = events.find((event) => event.kind === "error");
    const ended = events.find((event) => event.kind === "session.ended");
    expect(error?.kind === "error" && error.error.class).toBe("quota-exhausted");
    expect(error?.kind === "error" && error.error.origin).toBe("provider");
    expect(error?.kind === "error" && error.error.retryableSource).toBe("inferred");
    expect(ended?.kind === "session.ended" && ended.outcome.status).toBe("failed");
  });
});

describe("normalizeClaudeFrame: compaction (B09 cluster 3)", () => {
  it("maps the SDK compact_boundary frame to a compact_boundary event with the harness's own figures", () => {
    const frame = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 42_000 },
      uuid: "u1",
      session_id: "abc",
    };
    const events = normalizeClaudeFrame(frame, context());
    expect(events).toHaveLength(1);
    const boundary = events[0];
    expect(boundary?.kind).toBe("compact_boundary");
    expect(boundary?.kind === "compact_boundary" && boundary.trigger).toBe("auto");
    expect(boundary?.kind === "compact_boundary" && boundary.preTokens).toBe(180_000);
    expect(boundary?.kind === "compact_boundary" && boundary.postTokens).toBe(42_000);
    // The raw frame is carried verbatim, nothing lost.
    expect(boundary?.native).toEqual(frame);
  });

  it("omits token figures the harness did not report — never a substituted zero", () => {
    const frame = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
    };
    const events = normalizeClaudeFrame(frame, context());
    const boundary = events[0];
    expect(boundary?.kind === "compact_boundary" && boundary.trigger).toBe("manual");
    expect(boundary?.kind === "compact_boundary" && boundary.preTokens).toBeUndefined();
    expect(boundary?.kind === "compact_boundary" && boundary.postTokens).toBeUndefined();
  });

  it("defaults an unstated trigger to auto — an unsolicited compaction is auto by nature", () => {
    const frame = { type: "system", subtype: "compact_boundary", compact_metadata: {} };
    const events = normalizeClaudeFrame(frame, context());
    expect(events[0]?.kind === "compact_boundary" && events[0].trigger).toBe("auto");
  });
});

describe("normalizeClaudeFrame: passthrough and content", () => {
  it("surfaces an unmodelled frame as passthrough with its native payload", () => {
    const frame = { type: "some_future_frame", detail: 7 };
    const events = normalizeClaudeFrame(frame, context());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === "passthrough" && events[0].nativeKind).toBe("some_future_frame");
    expect(events[0]?.native).toEqual(frame);
  });

  it("marks a non-object frame as passthrough", () => {
    const events = normalizeClaudeFrame(42, context());
    expect(events[0]?.kind === "passthrough" && events[0].nativeKind).toBe("non-object");
  });

  it("splits assistant content into text.message and tool.started", () => {
    const frame = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "u1", name: "Read", input: { path: "a.ts" } },
        ],
      },
    };
    const events = normalizeClaudeFrame(frame, context());
    const text = events.find((event) => event.kind === "text.message");
    const tool = events.find((event) => event.kind === "tool.started");
    expect(text?.kind === "text.message" && text.text).toBe("looking");
    expect(tool?.kind === "tool.started" && tool.call.name).toBe("Read");
    expect(tool?.kind === "tool.started" && tool.call.kind).toBe("read");
  });

  it("emits tool.output from a user tool_result, echoing the tool_use_id (#259)", () => {
    const frame = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "u1", content: "1 failed | 0 passed" }],
      },
    };
    const events = normalizeClaudeFrame(frame, context());
    expect(events).toHaveLength(1);
    const out = events[0];
    expect(out?.kind).toBe("tool.output");
    expect(out?.kind === "tool.output" && out.callId).toBe("u1");
    expect(out?.kind === "tool.output" && out.ok).toBe(true);
    expect(out?.kind === "tool.output" && out.text).toBe("1 failed | 0 passed");
  });

  it("renders array tool_result content to text and maps is_error to ok=false (#259)", () => {
    const frame = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "u2",
            is_error: true,
            content: [{ type: "text", text: "TypeError: boom" }],
          },
        ],
      },
    };
    const events = normalizeClaudeFrame(frame, context());
    const out = events[0];
    expect(out?.kind === "tool.output" && out.callId).toBe("u2");
    expect(out?.kind === "tool.output" && out.ok).toBe(false);
    expect(out?.kind === "tool.output" && out.text).toBe("TypeError: boom");
  });

  it("passes a user frame with no tool_result through as passthrough (nothing lost)", () => {
    const frame = { type: "user", message: { content: [{ type: "text", text: "hi" }] } };
    const events = normalizeClaudeFrame(frame, context());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("passthrough");
  });
});

describe("classifyToolKind", () => {
  it("classifies by tool name", () => {
    expect(classifyToolKind("Read")).toBe("read");
    expect(classifyToolKind("Write")).toBe("write");
    expect(classifyToolKind("Bash")).toBe("exec");
    expect(classifyToolKind("Grep")).toBe("search");
    expect(classifyToolKind("mcp__server__tool")).toBe("mcp");
    expect(classifyToolKind("Task")).toBe("subagent");
  });
});

describe("mapClaudeError", () => {
  it("assigns class, origin, and an inferred retryable", () => {
    expect(mapClaudeError("rate_limit", "slow down")).toMatchObject({
      class: "rate-limit",
      origin: "provider",
      retryable: true,
      retryableSource: "inferred",
    });
    expect(mapClaudeError("totally_new_code", "?")).toMatchObject({
      class: "unknown",
      origin: "harness",
    });
  });

  it("maps the SDK error_during_execution result subtype (B09 F4)", () => {
    expect(mapClaudeError("error_during_execution", "resume rejected")).toMatchObject({
      class: "invalid-request",
      origin: "harness",
      retryable: false,
      nativeCode: "error_during_execution",
    });
  });
});

describe("resume-vanished detection through the real adapter mapping (B09 F4)", () => {
  // Drives a raw SDK result frame through the ACTUAL frame normalizer, then the
  // pure resume-vanished rule — not a hand-built HarnessError. If the mapping
  // regresses (subtype no longer preserved as nativeCode), these reddens.
  const outcomeOf = (frame: Record<string, unknown>): SessionOutcome => {
    const ended = normalizeClaudeFrame(frame, context()).find((e) => e.kind === "session.ended");
    if (ended?.kind !== "session.ended") throw new Error("no terminal outcome");
    return ended.outcome;
  };

  it("treats a resumed error_during_execution result as a vanished transcript", () => {
    const outcome = outcomeOf({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "resume rejected: no conversation found",
    });
    expect(outcome.status).toBe("failed");
    expect(isResumeVanished(true, outcome)).toBe(true);
  });

  it("does NOT treat a resumed error_max_turns result as vanished", () => {
    const outcome = outcomeOf({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "hit the turn ceiling",
    });
    expect(isResumeVanished(true, outcome)).toBe(false);
  });

  it("does not trigger the rebuild when the turn did not attempt resume", () => {
    const outcome = outcomeOf({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "some execution error",
    });
    expect(isResumeVanished(false, outcome)).toBe(false);
  });
});

function fakeQuery(
  frames: readonly unknown[],
  sink?: (args: ClaudeQueryArgs) => void,
): (args: ClaudeQueryArgs) => AsyncIterable<unknown> {
  return (args: ClaudeQueryArgs): AsyncIterable<unknown> => {
    sink?.(args);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        for (const frame of frames) yield frame;
      },
    };
  };
}

/** One SDK partial-message frame carrying a text increment (the shape the SDK emits
 *  only when `includePartialMessages` is set). */
function streamTextDelta(text: string): unknown {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

async function drain(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const collected: HarnessEvent[] = [];
  for await (const event of session.events) collected.push(event);
  return collected;
}

describe("ClaudeAdapter session", () => {
  it("round-trips a turn end to end with adapter-assigned monotonic seq", async () => {
    const frames = [
      initFrame("oauth"),
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "success", result: '{"ok":true}', structuredOutput: { ok: true } },
    ];
    const adapter = new ClaudeAdapter({
      binaryPath: "/home/rai/.local/bin/claude",
      queryFn: fakeQuery(frames),
      version: "2.1.220",
      now: () => 1,
    });
    const session = await adapter.createSession({ cwd: "/repo" });
    await session.send({ prompt: "hi" });
    const events = await drain(session);
    expect(events.map((event) => event.kind)).toEqual([
      "session.started",
      "text.message",
      "session.ended",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    const ended = events[2];
    expect(ended?.kind === "session.ended" && ended.outcome.status).toBe("completed");
    expect(
      ended?.kind === "session.ended" &&
        ended.outcome.status === "completed" &&
        ended.outcome.structuredOutput,
    ).toEqual({ ok: true });
  });

  it("builds a capable-by-default posture, sets the session env marker, and injects no key", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery([], (args) => {
        capturedArgs.push(args);
      }),
      env: { PATH: "/usr/bin", HOME: "/home/rai" },
    });
    const session = await adapter.createSession({
      cwd: "/repo",
      model: "haiku",
      outputSchema: { type: "object" },
    });
    await session.send({ prompt: "act" });
    const options: ClaudeQueryOptions | undefined = capturedArgs[0]?.options;
    if (!options) throw new Error("queryFn was not invoked with options");
    expect(options.pathToClaudeCodeExecutable).toBe("/bin/claude");
    // Capable by default: one session shape — bypass mode, the full toolset,
    // and NO deny list. RED-proof: restore a read-only branch (permissionMode
    // "default" + a disallowedTools deny list) and the three assertions below redden.
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowedTools).toContain("Read");
    expect(options.allowedTools).toContain("Write");
    expect(options.allowedTools).toContain("Bash");
    expect(options.disallowedTools).toBeUndefined();
    expect(options.model).toBe("haiku");
    expect(options.outputSchema).toEqual({ type: "object" });
    // Full env spread (the SDK replaces the child env), plus the scoped marker.
    expect(options.env.PATH).toBe("/usr/bin");
    expect(options.env.RENNET_HARNESS_SESSION).toBeDefined();
    // No API key was injected: a metered key is detected, never forced.
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // W5: the MCP surface. Configured on the adapter (as the Codex adapter carries it), so
  // every session this harness creates would reach it. This proves the plumbing only —
  // no loopback canvasOps server is stood up, so nothing supplies it in production yet.
  it("carries the configured mcpServers onto every session's options", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery([], (args) => {
        capturedArgs.push(args);
      }),
      mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } },
    });
    const session = await adapter.createSession({ cwd: "/repo" });
    await session.send({ prompt: "act" });
    expect(capturedArgs[0]?.options.mcpServers).toEqual({
      canvasops: { url: "http://127.0.0.1:5000/mcp" },
    });
  });

  it("omits mcpServers when the adapter was configured with none", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery([], (args) => {
        capturedArgs.push(args);
      }),
    });
    const session = await adapter.createSession({ cwd: "/repo" });
    await session.send({ prompt: "act" });
    expect(capturedArgs[0]?.options.mcpServers).toBeUndefined();
  });

  it("streams text.delta from stream_event frames when the spec asks for partial text", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const frames = [
      initFrame("oauth"),
      streamTextDelta("Hel"),
      streamTextDelta("lo"),
      { type: "result", subtype: "success", result: "Hello" },
    ];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery(frames, (args) => {
        capturedArgs.push(args);
      }),
    });
    // Positive control: drop `streamPartialText` here and the two assertions below
    // redden — the SDK option is omitted and no live turn would ever emit a delta.
    const session = await adapter.createSession({ cwd: "/repo", streamPartialText: true });
    await session.send({ prompt: "hi" });
    const events = await drain(session);
    expect(capturedArgs[0]?.options.includePartialMessages).toBe(true);
    const deltas = events.filter((event) => event.kind === "text.delta");
    expect(deltas.map((event) => (event.kind === "text.delta" ? event.text : ""))).toEqual([
      "Hel",
      "lo",
    ]);
    // In order, and before the terminal frame.
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("text.delta")).toBeLessThan(kinds.indexOf("session.ended"));
  });

  it("omits includePartialMessages when the spec does not ask for partial text", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery([], (args) => {
        capturedArgs.push(args);
      }),
    });
    const session = await adapter.createSession({ cwd: "/repo" });
    await session.send({ prompt: "hi" });
    expect(capturedArgs[0]?.options.includePartialMessages).toBeUndefined();
  });

  it("propagates a signal already aborted at creation (no un-cancellable live turn)", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery([], (args) => {
        capturedArgs.push(args);
      }),
    });
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE the session exists — a future-only listener would miss it
    const session = await adapter.createSession({
      cwd: "/repo",
      signal: controller.signal,
    });
    await session.send({ prompt: "hi" });
    const options: ClaudeQueryOptions | undefined = capturedArgs[0]?.options;
    if (!options) throw new Error("queryFn was not invoked with options");
    const { abortController } = options;
    if (!abortController) throw new Error("options carried no abortController");
    expect(abortController.signal.aborted).toBe(true);
  });

  it("derives descriptor capability flags from passing checks, not declaration", () => {
    const adapter = new ClaudeAdapter({ binaryPath: "/bin/claude", queryFn: fakeQuery([]) });
    const caps = adapter.descriptor.capabilities;
    // Implemented by the adapter (mapping code exists and is tested).
    expect(caps.structuredOutput.implementedByAdapter).toBe(true);
    expect(caps.interrupt.implementedByAdapter).toBe(true);
    // B09 wired cursor-resume: `resume` now has a real port path. `fork` is still
    // a later slice and stays false at every layer.
    expect(caps.resume.implementedByAdapter).toBe(true);
    expect(caps.fork.implementedByAdapter).toBe(false);
    // No conformance run and no live session yet, so these layers are all false.
    expect(caps.structuredOutput.advertisedByHarness).toBe(false);
    expect(caps.structuredOutput.availableInSession).toBe(false);
  });

  it("passes SessionSpec.resume through to the query options (cursor-resume, B09 task 2.1)", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery([], (args) => {
        capturedArgs.push(args);
      }),
    });
    const session = await adapter.createSession({
      cwd: "/repo",
      resume: { harnessSessionId: "harness-sess-42" },
    });
    await session.send({ prompt: "continue" });
    const options: ClaudeQueryOptions | undefined = capturedArgs[0]?.options;
    if (!options) throw new Error("queryFn was not invoked with options");
    // RED-proof: drop the resume passthrough in `#buildOptions` and this reddens —
    // the fresh `claude` process would start a new conversation instead of resuming.
    expect(options.resume).toBe("harness-sess-42");
  });

  it("omits resume for a fresh session (no cursor invented)", async () => {
    const capturedArgs: ClaudeQueryArgs[] = [];
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      queryFn: fakeQuery([], (args) => {
        capturedArgs.push(args);
      }),
    });
    const session = await adapter.createSession({ cwd: "/repo" });
    await session.send({ prompt: "start" });
    expect(capturedArgs[0]?.options.resume).toBeUndefined();
  });

  it("surfaces the harness session id + terminal anchor on the completed outcome (cursor, B09 task 2.1)", () => {
    const frame = {
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "harness-sess-99",
      uuid: "msg-uuid-tail",
    };
    const events = normalizeClaudeFrame(frame, context());
    const ended = events[0];
    expect(ended?.kind).toBe("session.ended");
    if (ended?.kind !== "session.ended" || ended.outcome.status !== "completed") {
      throw new Error("expected a completed session.ended outcome");
    }
    // The durable session persists these as its HarnessCursor.
    expect(ended.outcome.harnessSessionId).toBe("harness-sess-99");
    expect(ended.outcome.lastAssistantMessageAnchor).toBe("msg-uuid-tail");
  });

  it("omits the cursor when the result frame reports no session id (never fabricated)", () => {
    const frame = { type: "result", subtype: "success", result: "done" };
    const events = normalizeClaudeFrame(frame, context());
    const ended = events[0];
    if (ended?.kind !== "session.ended" || ended.outcome.status !== "completed") {
      throw new Error("expected a completed session.ended outcome");
    }
    expect(ended.outcome.harnessSessionId).toBeUndefined();
    expect(ended.outcome.lastAssistantMessageAnchor).toBeUndefined();
  });
});

describe("normalizeClaudeFrame: thinking / reasoning lane (issue-set B)", () => {
  it("maps an assistant `thinking` block to a thinking.message event", () => {
    const frame = {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "let me reason about this" }] },
    };
    const events = normalizeClaudeFrame(frame, context());
    const thinking = events.find((e) => e.kind === "thinking.message");
    expect(thinking?.kind === "thinking.message" && thinking.text).toBe("let me reason about this");
  });

  it("maps a stream_event thinking_delta to a thinking.delta (was a passthrough before B)", () => {
    const frame = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "step" } },
    };
    const events = normalizeClaudeFrame(frame, context());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === "thinking.delta" && events[0].text).toBe("step");
  });
});
