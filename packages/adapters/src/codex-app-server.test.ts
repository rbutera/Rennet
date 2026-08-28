import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { HarnessEvent, SessionOutcome } from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex-adapter";
import {
  type AppServerConnection,
  type AppServerExit,
  type AppServerTurnParams,
  buildAppServerArgs,
  type CodexTurnResultFrame,
  defaultSpawnAppServer,
  INTERRUPT_GRACE_MS,
  mapTokenUsageBreakdown,
  probeAppServerHandshake,
  readAppServerMessages,
  runCodexTurn,
  serverRequestResponse,
} from "./codex-app-server";

// ── An async queue and a scripted connection (no process) ──────────────────────

function makeQueue<T>(): {
  push: (value: T) => void;
  close: () => void;
  iterable: AsyncIterable<T>;
} {
  const buffer: T[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const ping = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push: (value) => {
      buffer.push(value);
      ping();
    },
    close: () => {
      done = true;
      ping();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncIterator<T> {
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as T;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

type Handler = (
  msg: Record<string, unknown>,
  reply: (out: Record<string, unknown>) => void,
  close: () => void,
) => void;

interface Scripted {
  conn: AppServerConnection;
  sent: Record<string, unknown>[];
  order: string[];
  killed: () => boolean;
  resolveExit: (exit: AppServerExit) => void;
}

function scriptedConnection(
  handler: Handler,
  opts: { exit?: AppServerExit; deferExit?: boolean } = {},
): Scripted {
  const q = makeQueue<Record<string, unknown>>();
  const sent: Record<string, unknown>[] = [];
  const order: string[] = [];
  let killed = false;
  let resolveExit!: (exit: AppServerExit) => void;
  const exit = opts.deferExit
    ? new Promise<AppServerExit>((resolve) => {
        resolveExit = resolve;
      })
    : Promise.resolve(opts.exit ?? { exitCode: 0, stderr: "", aborted: false });
  if (!opts.deferExit) resolveExit = () => undefined;
  const conn: AppServerConnection = {
    send: (message) => {
      sent.push(message);
      if (typeof message.method === "string") order.push(`send:${message.method}`);
      handler(message, q.push, q.close);
    },
    messages: q.iterable,
    kill: () => {
      killed = true;
      order.push("kill");
      q.close();
    },
    exit,
  };
  return { conn, sent, order, killed: () => killed, resolveExit };
}

/** A realistic happy script: init → thread → turn ACK(inProgress) → stream → completed. */
function happyHandler(finalText = '{"ok":true}'): Handler {
  return (msg, reply) => {
    const { method, id } = msg;
    if (method === "initialize") reply({ id, result: {} });
    else if (method === "thread/start")
      reply({ id, result: { thread: { id: "th_1" }, model: "gpt-5.6-obs" } });
    else if (method === "turn/start") {
      // The ACK response carries status "inProgress" — MUST NOT terminate the turn.
      reply({ id, result: { turn: { id: "turn_1", status: "inProgress", items: [] } } });
      reply({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_1" } } });
      reply({
        method: "item/agentMessage/delta",
        params: { delta: finalText, itemId: "i", threadId: "th_1", turnId: "turn_1" },
      });
      reply({
        method: "item/completed",
        params: {
          threadId: "th_1",
          turnId: "turn_1",
          item: { id: "i", type: "agentMessage", text: finalText },
        },
      });
      reply({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "th_1",
          turnId: "turn_1",
          tokenUsage: {
            total: {
              inputTokens: 10,
              cachedInputTokens: 4,
              outputTokens: 3,
              reasoningOutputTokens: 1,
              totalTokens: 13,
            },
          },
        },
      });
      reply({
        method: "turn/completed",
        params: { threadId: "th_1", turn: { id: "turn_1", status: "completed", items: [] } },
      });
    }
  };
}

async function drive(
  conn: AppServerConnection,
  params: AppServerTurnParams,
): Promise<{ frames: unknown[]; terminal: CodexTurnResultFrame }> {
  const frames: unknown[] = [];
  let terminal: CodexTurnResultFrame | null = null;
  for await (const frame of runCodexTurn(conn, params)) {
    frames.push(frame);
    if ((frame as { rennet?: unknown }).rennet === "turn-result") {
      terminal = frame as CodexTurnResultFrame;
    }
  }
  if (!terminal) throw new Error("no terminal frame");
  return { frames, terminal };
}

const PARAMS: AppServerTurnParams = {
  cwd: "/repo",
  prompt: "go",
  outputSchema: { type: "object" },
};

describe("runCodexTurn", () => {
  it("handshakes init → initialized → thread/start → turn/start, then completes on turn/completed", async () => {
    const { conn, sent } = scriptedConnection(happyHandler());
    const { terminal } = await drive(conn, { ...PARAMS, model: "gpt-5.6-obs", effort: "high" });

    expect(sent.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    const init = sent[0] as Record<string, unknown>;
    expect((init.params as { clientInfo?: { name?: string } }).clientInfo?.name).toBe("rennet");

    const turn = sent[3]?.params as Record<string, unknown>;
    expect(turn.threadId).toBe("th_1");
    expect(turn.input).toEqual([{ type: "text", text: "go" }]);
    expect(turn.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turn.approvalPolicy).toBe("never");
    expect(turn.effort).toBe("high");
    expect(turn.outputSchema).toEqual({ type: "object" });

    const thread = sent[2]?.params as Record<string, unknown>;
    expect(thread.approvalPolicy).toBe("never");
    expect(thread.sandbox).toBe("danger-full-access");

    // The turn/start ACK carried status "inProgress" — the run did NOT mis-terminate;
    // it completed only on turn/completed.
    expect(terminal.status).toBe("completed");
    expect(terminal.finalMessage).toBe('{"ok":true}');
    expect(terminal.model).toBe("gpt-5.6-obs");
    expect(terminal.usage).toEqual({
      input: 6,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      reasoning: 1,
      total: 13,
    });
  });

  it("does not terminate on the turn/start ACK response (status inProgress)", async () => {
    // A turn/start response arrives with status inProgress and NO items; the run
    // must keep running until the real turn/completed notification.
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start") {
        reply({ id, result: { turn: { id: "tn", status: "inProgress", items: [] } } });
        reply({
          method: "item/completed",
          params: {
            threadId: "t",
            turnId: "tn",
            item: { id: "i", type: "agentMessage", text: "done" },
          },
        });
        reply({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: "tn", status: "completed", items: [] } },
        });
      }
    };
    const { conn } = scriptedConnection(handler);
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("completed");
    expect(terminal.finalMessage).toBe("done");
  });

  it("passes every app-server notification through, never dropped", async () => {
    const { conn } = scriptedConnection(happyHandler());
    const { frames } = await drive(conn, PARAMS);
    const methods = frames
      .map((f) => (f as { method?: string }).method)
      .filter((m): m is string => typeof m === "string");
    expect(methods).toEqual([
      "turn/started",
      "item/agentMessage/delta",
      "item/completed",
      "thread/tokenUsage/updated",
      "turn/completed",
    ]);
  });

  it("maps a failed turn to a failed terminal with the TurnError message verbatim", async () => {
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start")
        reply({
          method: "turn/completed",
          params: {
            threadId: "t",
            turn: {
              id: "tn",
              status: "failed",
              error: { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded" },
            },
          },
        });
    };
    const { conn } = scriptedConnection(handler);
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("failed");
    expect(terminal.error?.source).toBe("turn");
    expect(terminal.error?.message).toBe("usage limit reached");
    expect(terminal.error?.codexErrorInfo).toBe("usageLimitExceeded");
  });

  it("maps a JSON-RPC error response (to one of our requests) to a failed terminal", async () => {
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start")
        reply({ id, error: { code: -32001, message: "Server overloaded; retry later" } });
    };
    const { conn } = scriptedConnection(handler);
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("failed");
    expect(terminal.error?.source).toBe("jsonrpc");
    expect(terminal.error?.code).toBe(-32001);
  });

  it("ignores a FOREIGN error response (id we never sent) and still completes", async () => {
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start") {
        reply({ id: 9999, error: { code: -1, message: "not ours" } }); // foreign id
        reply({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: "tn", status: "completed", items: [] } },
        });
      }
    };
    const { conn } = scriptedConnection(handler);
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("completed");
  });

  it("ignores FOREIGN-thread notifications (surfaced, but neither mutating nor terminating)", async () => {
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "mine" } } });
      else if (method === "turn/start") {
        // A concurrent OTHER thread's chatter must not touch our final text/usage or end us.
        reply({
          method: "item/completed",
          params: {
            threadId: "other",
            turnId: "x",
            item: { id: "j", type: "agentMessage", text: "STOLEN" },
          },
        });
        reply({
          method: "turn/completed",
          params: {
            threadId: "other",
            turn: { id: "x", status: "failed", error: { message: "not mine" } },
          },
        });
        // Our own turn then completes cleanly.
        reply({
          method: "item/completed",
          params: {
            threadId: "mine",
            turnId: "tn",
            item: { id: "i", type: "agentMessage", text: "mine" },
          },
        });
        reply({
          method: "turn/completed",
          params: { threadId: "mine", turn: { id: "tn", status: "completed", items: [] } },
        });
      }
    };
    const { conn } = scriptedConnection(handler);
    const { frames, terminal } = await drive(conn, PARAMS);
    // The foreign notifications were surfaced (never dropped) — WRAPPED so the
    // adapter cannot mistake them for owned frames.
    const foreign = frames.filter((f) => (f as { rennet?: string }).rennet === "foreign");
    expect(foreign).toHaveLength(2);
    expect(
      (foreign[0] as { native?: { params?: { threadId?: string } } }).native?.params?.threadId,
    ).toBe("other");
    // …but did not steal our final text or terminate us as failed.
    expect(terminal.status).toBe("completed");
    expect(terminal.finalMessage).toBe("mine");
  });

  it("puts ephemeral on thread/start only when the caller asks for it (#585)", async () => {
    // `ephemeral` keeps a one-shot utility thread out of ~/.codex/sessions/
    // (app-server ThreadStartParams: "should not be materialized on disk").
    const withFlag = scriptedConnection(happyHandler());
    await drive(withFlag.conn, { ...PARAMS, ephemeral: true });
    expect((withFlag.sent[2].params as Record<string, unknown>).ephemeral).toBe(true);
    // The agentic transport passes nothing, so the user's own thread still persists.
    const without = scriptedConnection(happyHandler());
    await drive(without.conn, PARAMS);
    expect("ephemeral" in (without.sent[2].params as Record<string, unknown>)).toBe(false);
  });

  it("answers a server approval request with the method's schema-valid decision", async () => {
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start") {
        reply({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
        reply({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: "tn", status: "completed", items: [] } },
        });
      }
    };
    const { conn, sent } = scriptedConnection(handler);
    const { frames, terminal } = await drive(conn, PARAMS);
    const reply = sent.find((m) => m.id === 99 && "result" in m);
    expect(reply).toBeDefined();
    // v2 CommandExecutionRequestApprovalResponse requires decision "accept" — NOT an invented field.
    expect((reply?.result as { decision?: string } | undefined)?.decision).toBe("accept");
    expect(
      frames.some(
        (f) => (f as { method?: string }).method === "item/commandExecution/requestApproval",
      ),
    ).toBe(true);
    expect(terminal.status).toBe("completed");
  });

  it("maps a pre-terminal process exit to a failed terminal (source exit)", async () => {
    const handler: Handler = (msg, reply, close) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start") close();
    };
    const { conn } = scriptedConnection(handler, {
      exit: { exitCode: 1, stderr: "boom", aborted: false },
    });
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("failed");
    expect(terminal.error?.source).toBe("exit");
  });

  it("maps a spawn failure (exit carries spawnError) to a failed terminal (source spawn)", async () => {
    const handler: Handler = (_msg, _reply, close) => close();
    const { conn } = scriptedConnection(handler, {
      exit: { exitCode: null, stderr: "", aborted: false, spawnError: "spawn codex ENOENT" },
    });
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("failed");
    expect(terminal.error?.source).toBe("spawn");
    expect(terminal.error?.message).toMatch(/ENOENT/);
  });

  it("maps an unparseable stdout line to a failed terminal (source parse)", async () => {
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start")
        reply({ __rennetParseError: "<html>gateway timeout</html>" });
    };
    const { conn } = scriptedConnection(handler);
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("failed");
    expect(terminal.error?.source).toBe("parse");
  });

  it("interrupts on abort, sends turn/interrupt BEFORE kill, and awaits exit before resolving", async () => {
    const abort = new AbortController();
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start")
        reply({ method: "turn/started", params: { threadId: "t", turn: { id: "tn" } } });
      else if (method === "turn/interrupt")
        reply({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: "tn", status: "interrupted" } },
        });
    };
    const s = scriptedConnection(handler, { deferExit: true });
    let settled = false;
    const running = drive(s.conn, { ...PARAMS, signal: abort.signal }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    // Give the interrupt→turn/completed(interrupted)→kill sequence a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // turn/interrupt was sent, and it was sent BEFORE the kill.
    expect(s.sent.some((m) => m.method === "turn/interrupt")).toBe(true);
    expect(s.order.indexOf("send:turn/interrupt")).toBeLessThan(s.order.indexOf("kill"));
    // The run has NOT resolved yet — the finally is awaiting the process exit.
    expect(settled).toBe(false);
    s.resolveExit({ exitCode: 0, stderr: "", aborted: false });
    const { terminal } = await running;
    expect(terminal.status).toBe("cancelled");
  });

  it("force-kills at INTERRUPT_GRACE_MS when turn/completed(interrupted) never arrives", async () => {
    // Fake ONLY the grace timer; leave microtasks/setImmediate real so the handshake runs.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    try {
      const abort = new AbortController();
      // A server that starts the turn but NEVER answers the interrupt / completes it.
      const handler: Handler = (msg, reply) => {
        const { method, id } = msg;
        if (method === "initialize") reply({ id, result: {} });
        else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
        else if (method === "turn/start")
          reply({ method: "turn/started", params: { threadId: "t", turn: { id: "tn" } } });
      };
      const s = scriptedConnection(handler, { deferExit: true });
      let settled = false;
      const running = drive(s.conn, { ...PARAMS, signal: abort.signal }).then((r) => {
        settled = true;
        return r;
      });
      await tick(); // run the handshake through turn/started (ownTurnId now known)
      abort.abort();
      await tick(); // turn/interrupt is sent; the grace timer is armed
      expect(s.sent.some((m) => m.method === "turn/interrupt")).toBe(true);
      expect(s.killed()).toBe(false); // NOT killed before the deadline

      vi.advanceTimersByTime(INTERRUPT_GRACE_MS - 1);
      await tick();
      expect(s.killed()).toBe(false); // still not, one tick short

      vi.advanceTimersByTime(1); // cross the deadline → force kill
      await tick();
      expect(s.killed()).toBe(true);
      // The run still awaits the process exit before resolving.
      expect(settled).toBe(false);
      s.resolveExit({ exitCode: null, stderr: "", aborted: true });
      const { terminal } = await running;
      expect(terminal.status).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the grace timer on a normal interrupted completion (no late kill)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    try {
      const abort = new AbortController();
      const handler: Handler = (msg, reply) => {
        const { method, id } = msg;
        if (method === "initialize") reply({ id, result: {} });
        else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
        else if (method === "turn/start")
          reply({ method: "turn/started", params: { threadId: "t", turn: { id: "tn" } } });
        else if (method === "turn/interrupt")
          reply({
            method: "turn/completed",
            params: { threadId: "t", turn: { id: "tn", status: "interrupted" } },
          });
      };
      const s = scriptedConnection(handler);
      const running = drive(s.conn, { ...PARAMS, signal: abort.signal });
      await tick();
      abort.abort();
      const { terminal } = await running; // interrupted completion resolves the run
      expect(terminal.status).toBe("cancelled");
      const killsAtCompletion = s.order.filter((o) => o === "kill").length;
      // Advancing well past the grace window must NOT fire a late kill — the timer was cleared.
      vi.advanceTimersByTime(INTERRUPT_GRACE_MS * 2);
      await tick();
      expect(s.order.filter((o) => o === "kill").length).toBe(killsAtCompletion);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("serverRequestResponse (exhaustive, schema-valid dispatch)", () => {
  it.each([
    ["item/commandExecution/requestApproval", { result: { decision: "accept" } }],
    ["item/fileChange/requestApproval", { result: { decision: "accept" } }],
    ["item/permissions/requestApproval", { result: { permissions: {} } }],
    ["execCommandApproval", { result: { decision: "approved" } }],
    ["applyPatchApproval", { result: { decision: "approved" } }],
    ["item/tool/requestUserInput", { result: { answers: {} } }],
    ["mcpServer/elicitation/request", { result: { action: "decline" } }],
  ])("answers %s with its schema-valid result", (method, expected) => {
    expect(serverRequestResponse(method)).toEqual(expected);
  });

  it.each([
    "item/tool/call",
    "account/chatgptAuthTokens/refresh",
    "attestation/generate",
    "some/unknown/method",
  ])(
    "answers %s with a JSON-RPC error (never a bogus result shape that could stall the turn)",
    (method) => {
      const response = serverRequestResponse(method);
      expect("error" in response).toBe(true);
      if ("error" in response) expect(response.error.code).toBe(-32601);
    },
  );
});

// ── End-to-end ownership: runner → adapter, foreign frames cannot contaminate ──

describe("ownership end to end (transport → adapter)", () => {
  async function drainAdapter(
    conn: AppServerConnection,
    params: AppServerTurnParams,
  ): Promise<SessionOutcome | null> {
    const adapter = new CodexAdapter({
      binaryPath: "/x/codex",
      transport: () => runCodexTurn(conn, params),
      version: "0.146.0",
    });
    const session = await adapter.createSession({
      cwd: params.cwd,
      outputSchema: { type: "object" },
    });
    await session.send({ prompt: params.prompt });
    let outcome: SessionOutcome | null = null;
    for await (const event of session.events as AsyncIterable<HarnessEvent>) {
      if (event.kind === "session.ended") outcome = event.outcome;
    }
    return outcome;
  }

  it("a foreign message + foreign usage do NOT become our final output or tokens", async () => {
    // Our owned turn completes with NO agent message and NO usage; a concurrent
    // foreign thread streams both. The adapter must NOT publish the foreign values.
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "mine" } } });
      else if (method === "turn/start") {
        reply({ method: "turn/started", params: { threadId: "mine", turn: { id: "tn" } } });
        reply({
          method: "item/completed",
          params: {
            threadId: "other",
            turnId: "x",
            item: { id: "j", type: "agentMessage", text: '{"stolen":true}' },
          },
        });
        reply({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "other",
            turnId: "x",
            tokenUsage: {
              total: {
                inputTokens: 999,
                cachedInputTokens: 0,
                outputTokens: 999,
                reasoningOutputTokens: 0,
                totalTokens: 1998,
              },
            },
          },
        });
        // Our turn completes empty.
        reply({
          method: "turn/completed",
          params: { threadId: "mine", turn: { id: "tn", status: "completed", items: [] } },
        });
      }
    };
    const { conn } = scriptedConnection(handler);
    const outcome = await drainAdapter(conn, {
      cwd: "/repo",
      prompt: "go",
      outputSchema: { type: "object" },
    });
    expect(outcome?.status).toBe("completed");
    if (outcome?.status === "completed") {
      // No structured output (the foreign message was NOT parsed as ours)…
      expect(outcome.structuredOutput).toBeUndefined();
      expect(outcome.finalText).toBe("");
      // …and no usage (the foreign tokens were NOT adopted).
      expect(outcome.usage).toBeUndefined();
    }
  });
});

describe("buildAppServerArgs", () => {
  it("pins a FULL-TABLE mcp_servers override (only canvasOps, replacing user config)", () => {
    expect(buildAppServerArgs({ canvasops: { url: "http://127.0.0.1:5000/mcp" } })).toEqual([
      "app-server",
      "-c",
      'mcp_servers={canvasops={url="http://127.0.0.1:5000/mcp"}}',
    ]);
  });

  it("emits an EMPTY full-table override when no MCP servers are supplied (isolates user MCP)", () => {
    expect(buildAppServerArgs()).toEqual(["app-server", "-c", "mcp_servers={}"]);
  });
});

describe("mapTokenUsageBreakdown", () => {
  it("removes cached input from the billed input and reconciles the total", () => {
    expect(
      mapTokenUsageBreakdown({
        inputTokens: 100,
        cachedInputTokens: 60,
        outputTokens: 5,
        reasoningOutputTokens: 2,
        totalTokens: 105,
      }),
    ).toEqual({ input: 40, output: 5, cacheRead: 60, cacheWrite: 0, reasoning: 2, total: 105 });
  });
});

describe("readAppServerMessages (stdout parser)", () => {
  async function collect(chunks: string[]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for await (const message of readAppServerMessages(Readable.from(chunks))) out.push(message);
    return out;
  }

  it("handles multiple frames per chunk, a line split across chunks, and a trailing unterminated line", async () => {
    const messages = await collect([
      '{"method":"a"}\n{"me',
      'thod":"b"}\n',
      '{"method":"c"}', // no trailing newline — must still be emitted on stream end
    ]);
    expect(messages.map((m) => m.method)).toEqual(["a", "b", "c"]);
  });

  it("surfaces a malformed line as a parse-error sentinel (never silently dropped)", async () => {
    const messages = await collect(['{"method":"a"}\n', "not json at all\n", '{"method":"b"}\n']);
    expect(messages[0]?.method).toBe("a");
    expect(messages[1]?.__rennetParseError).toBe("not json at all");
    expect(messages[2]?.method).toBe("b");
  });
});

describe("probeAppServerHandshake", () => {
  function spawnFrom(handler: Handler) {
    return () => scriptedConnection(handler).conn;
  }

  it("certifies only on an initialize RESPONSE with the right id and a result", async () => {
    const ok = await probeAppServerHandshake({
      candidate: { path: "/codex" },
      spawn: spawnFrom((msg, reply) => {
        if (msg.method === "initialize") reply({ id: msg.id, result: { userAgent: "codex" } });
      }),
    });
    expect(ok).toBe(true);
  });

  it("does NOT certify when initialize answers with an ERROR", async () => {
    const ok = await probeAppServerHandshake({
      candidate: { path: "/codex" },
      spawn: spawnFrom((msg, reply) => {
        if (msg.method === "initialize")
          reply({ id: msg.id, error: { code: -32600, message: "bad" } });
      }),
    });
    expect(ok).toBe(false);
  });

  it("ignores an unrelated notification first, then certifies on the real response", async () => {
    const ok = await probeAppServerHandshake({
      candidate: { path: "/codex" },
      spawn: spawnFrom((msg, reply) => {
        if (msg.method === "initialize") {
          reply({ method: "warning", params: { message: "hi" } });
          reply({ id: msg.id, result: {} });
        }
      }),
    });
    expect(ok).toBe(true);
  });

  it("does NOT certify on a wrong-id response only", async () => {
    const ok = await probeAppServerHandshake({
      candidate: { path: "/codex" },
      timeoutMs: 50,
      spawn: spawnFrom((msg, reply, close) => {
        if (msg.method === "initialize") {
          reply({ id: 2, result: {} }); // never id 1
          close();
        }
      }),
    });
    expect(ok).toBe(false);
  });
});

// ── Real spawn: the child tree is killed (task 1.3 — kill the whole tree) ───────

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("descendant pid was not written");
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`descendant ${pid} survived kill`);
}

describe("defaultSpawnAppServer", () => {
  it.skipIf(process.platform === "win32")(
    "kills a Node launcher and its long-lived descendant on kill()",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rennet-codex-tree-"));
      const pidPath = join(dir, "descendant.pid");
      const launcher = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "writeFileSync(process.argv[1], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      try {
        const conn = defaultSpawnAppServer({
          bin: process.execPath,
          args: ["-e", launcher, pidPath],
          cwd: dir,
        });
        const descendantPid = await waitForPid(pidPath);
        conn.kill();
        await conn.exit;
        await waitForExit(descendantPid);
        expect(() => process.kill(descendantPid, 0)).toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("reports a spawn failure (ENOENT) as spawnError on exit, not a throw", async () => {
    const conn = defaultSpawnAppServer({
      bin: "/no/such/codex-binary-xyz",
      args: ["app-server"],
      cwd: undefined,
    });
    const exit = await conn.exit;
    if (process.platform === "win32") {
      // Probed on a real Windows host: execa resolves a MISSING binary there with
      // a plain `exitCode: 1, failed: true` and no errno on the result, so a spawn
      // failure is indistinguishable from a nonzero exit at this layer. It still
      // fails the turn honestly (pre-terminal exit path); discovery's
      // executability + handshake probes gate the composed path long before a
      // blind spawn, so the errno classification is a POSIX-only refinement.
      expect(exit.exitCode).not.toBe(0);
      expect(exit.spawnError).toBeUndefined();
    } else {
      expect(exit.spawnError).toBeDefined();
    }
    conn.kill();
  });
});
