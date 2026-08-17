import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AppServerConnection,
  type AppServerTurnParams,
  buildAppServerArgs,
  type CodexTurnResultFrame,
  defaultSpawnAppServer,
  mapTokenUsageBreakdown,
  runCodexTurn,
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

function scriptedConnection(
  handler: Handler,
  exitValue: { exitCode: number | null; stderr: string; aborted: boolean } = {
    exitCode: 0,
    stderr: "",
    aborted: false,
  },
): { conn: AppServerConnection; sent: Record<string, unknown>[]; killed: () => boolean } {
  const q = makeQueue<Record<string, unknown>>();
  const sent: Record<string, unknown>[] = [];
  let killed = false;
  const conn: AppServerConnection = {
    send: (message) => {
      sent.push(message);
      handler(message, q.push, q.close);
    },
    messages: q.iterable,
    kill: () => {
      killed = true;
      q.close();
    },
    exit: Promise.resolve(exitValue),
  };
  return { conn, sent, killed: () => killed };
}

/** The stock happy-path script: init → thread → turn, streaming a text item, usage,
 *  and a completed turn carrying the final agent message. */
function happyHandler(finalText = '{"ok":true}'): Handler {
  return (msg, reply) => {
    const method = msg.method;
    const id = msg.id;
    if (method === "initialize") {
      reply({ id, result: {} });
    } else if (method === "thread/start") {
      reply({ id, result: { thread: { id: "th_1" }, model: "gpt-5.6-obs" } });
    } else if (method === "turn/start") {
      reply({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_1" } } });
      reply({
        method: "item/agentMessage/delta",
        params: { delta: finalText, itemId: "i", threadId: "th_1", turnId: "turn_1" },
      });
      reply({
        method: "item/completed",
        params: { item: { id: "i", type: "agentMessage", text: finalText } },
      });
      reply({
        method: "thread/tokenUsage/updated",
        params: {
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
  it("handshakes init → initialized → thread/start → turn/start, then completes", async () => {
    const { conn, sent } = scriptedConnection(happyHandler());
    const { terminal } = await drive(conn, { ...PARAMS, model: "gpt-5.6-obs", effort: "high" });

    // The exact ordered handshake.
    expect(sent.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    // `initialized` MUST follow the init response, before thread/start.
    const init = sent[0] as Record<string, unknown>;
    expect((init.params as { clientInfo?: { name?: string } }).clientInfo?.name).toBe("rennet");

    // turn/start carries the full-capability posture and the turn-scoped outputSchema.
    const turn = sent[3]?.params as Record<string, unknown>;
    expect(turn.threadId).toBe("th_1");
    expect(turn.input).toEqual([{ type: "text", text: "go" }]);
    expect(turn.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turn.approvalPolicy).toBe("never");
    expect(turn.model).toBe("gpt-5.6-obs");
    expect(turn.effort).toBe("high");
    expect(turn.outputSchema).toEqual({ type: "object" });

    // thread/start also composes never-ask approvals + full-access sandbox shorthand.
    const thread = sent[2]?.params as Record<string, unknown>;
    expect(thread.approvalPolicy).toBe("never");
    expect(thread.sandbox).toBe("danger-full-access");

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
      else if (method === "turn/start") {
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
      }
    };
    const { conn } = scriptedConnection(handler);
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("failed");
    expect(terminal.error?.source).toBe("turn");
    expect(terminal.error?.message).toBe("usage limit reached");
    expect(terminal.error?.codexErrorInfo).toBe("usageLimitExceeded");
  });

  it("maps a JSON-RPC error response to a failed terminal", async () => {
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

  it("interrupts on abort and resolves to cancelled after turn/completed(interrupted)", async () => {
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
    const { conn, sent } = scriptedConnection(handler);
    const iterate = drive(conn, { ...PARAMS, signal: abort.signal });
    // Let the turn get to `turn/started`, then abort.
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    const { terminal } = await iterate;
    expect(sent.some((m) => m.method === "turn/interrupt")).toBe(true);
    expect(terminal.status).toBe("cancelled");
  });

  it("maps a pre-terminal process exit to a failed terminal", async () => {
    const handler: Handler = (msg, reply, close) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start") close(); // process died before completing
    };
    const { conn } = scriptedConnection(handler, {
      exitCode: 1,
      stderr: "boom",
      aborted: false,
    });
    const { terminal } = await drive(conn, PARAMS);
    expect(terminal.status).toBe("failed");
    expect(terminal.error?.source).toBe("exit");
  });

  it("answers a server-initiated approval request affirmatively and surfaces it", async () => {
    const handler: Handler = (msg, reply) => {
      const { method, id } = msg;
      if (method === "initialize") reply({ id, result: {} });
      else if (method === "thread/start") reply({ id, result: { thread: { id: "t" } } });
      else if (method === "turn/start") {
        reply({ id: 99, method: "applyPatchApproval", params: {} });
        reply({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: "tn", status: "completed", items: [] } },
        });
      }
    };
    const { conn, sent } = scriptedConnection(handler);
    const { frames, terminal } = await drive(conn, PARAMS);
    // The approval got an affirmative response, never queued for a human.
    const reply = sent.find((m) => m.id === 99 && "result" in m);
    expect(reply).toBeDefined();
    expect((reply?.result as { approved?: boolean } | undefined)?.approved).toBe(true);
    // And it is surfaced as evidence in the frame stream.
    expect(frames.some((f) => (f as { method?: string }).method === "applyPatchApproval")).toBe(
      true,
    );
    expect(terminal.status).toBe("completed");
  });
});

describe("buildAppServerArgs", () => {
  it("prefixes app-server and rides canvasOps MCP URLs on -c overrides", () => {
    const args = buildAppServerArgs({ canvasops: { url: "http://127.0.0.1:5000/mcp" } });
    expect(args[0]).toBe("app-server");
    expect(args).toContain("-c");
    expect(args).toContain("mcp_servers.canvasops.url=http://127.0.0.1:5000/mcp");
  });

  it("is just app-server when no MCP servers are supplied", () => {
    expect(buildAppServerArgs()).toEqual(["app-server"]);
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
});
