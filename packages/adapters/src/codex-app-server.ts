/**
 * The `codex app-server` line protocol and turn runner (adopt-codex-app-server).
 *
 * ONE native surface for both the agentic transport (`codex-turn-transport.ts`)
 * and the utility executor (`codex-exec.ts`): spawn `codex app-server`, speak
 * newline-delimited JSON-RPC 2.0 over stdio, and run exactly one turn to a
 * terminal outcome. No daemon, no thread reuse — the child is turn-scoped (design
 * D1). No new dependency: the wire is `readline` + `JSON.parse` + an id map.
 *
 * Verified handshake (research vs the real codex-cli 0.147.0 binary + the
 * `.appserver-schema/` dump):
 *   1. `initialize` {clientInfo} → response, THEN the `initialized` notification
 *      before ANY other request (a request before it errors "Not initialized").
 *   2. `thread/start` → response carries `thread.id` and the resolved `model`.
 *   3. `turn/start` {threadId, input, cwd, model, effort, sandboxPolicy,
 *      approvalPolicy, outputSchema}. Full-access sandbox + never-ask approvals
 *      are the app-server peers of `--dangerously-bypass-approvals-and-sandbox`
 *      (Rule Zero acting path, design D4). Overrides persist on the thread.
 *   4. Streaming notifications (`item/agentMessage/delta`, `item/started`,
 *      `item/completed`, `thread/tokenUsage/updated`, …), terminal
 *      `turn/completed` {threadId, turn:{id, items, status, error?}}.
 *
 * `jsonrpc` is OMITTED on the wire (the server omits it and does not require it),
 * so we neither write nor require the member. The server may also send us REQUESTS
 * (approvals): the composed full-access policy makes them unreachable, but any that
 * arrives is answered affirmatively (never queued for a human) and surfaced as a
 * passthrough frame — no approval plumbing enters the adapter.
 *
 * Never reads a credential: `codex` authenticates itself on the user's own
 * subscription (shared `~/.codex` auth home).
 */

import { createInterface } from "node:readline";
import type { RspTokenUsage } from "@rennet/types";
import { execa } from "execa";

/** How Rennet introduces itself on `initialize`. */
export const CODEX_CLIENT_INFO = { name: "rennet", title: "Rennet", version: "1" } as const;

// ── The injected process seam (bidirectional, so the handshake is hermetic) ────

/** One live `codex app-server` child: write JSON messages, read parsed messages. */
export interface AppServerConnection {
  /** Write one JSON-RPC message as a single newline-terminated line to stdin. */
  send(message: Record<string, unknown>): void;
  /** Parsed stdout messages, one per non-empty line (stray log lines are skipped). */
  readonly messages: AsyncIterable<Record<string, unknown>>;
  /** Kill the child and its descendants. */
  kill(): void;
  /** Resolves when the child exits, with its exit code, stderr, and abort flag. */
  readonly exit: Promise<{ exitCode: number | null; stderr: string; aborted: boolean }>;
}

/** Spawn a `codex app-server` child. Injected so the runner is testable without a
 *  real process. `bin`/`args`/`cwd` are already locus-wrapped by the caller. */
export type SpawnAppServer = (spec: {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly signal?: AbortSignal;
}) => AppServerConnection;

// ── The turn spec and terminal frame ───────────────────────────────────────────

/** One app-server turn. `cwd` is locus-native (distro path for a WSL turn). */
export interface AppServerTurnParams {
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  /** Already sanitized by the caller (`sanitizeSchemaForCodex`). */
  readonly outputSchema?: unknown;
  readonly signal?: AbortSignal;
}

/** The normalized failure carried on a `failed` terminal frame. `source`
 *  disambiguates a turn-level failure (provider) from a transport/process one. */
export interface CodexTurnError {
  readonly source: "turn" | "jsonrpc" | "exit" | "spawn";
  readonly message: string;
  readonly codexErrorInfo?: unknown;
  readonly code?: number;
  readonly exitCode?: number | null;
}

/**
 * The ONE synthetic terminal frame the runner appends after the app-server
 * notification stream. It carries what only the session boundary knows: the final
 * outcome status, the accumulated final agent message, the in-protocol usage, and
 * the observed model. `error` is present iff `status === "failed"`.
 */
export interface CodexTurnResultFrame {
  readonly rennet: "turn-result";
  readonly status: "completed" | "failed" | "cancelled";
  readonly finalMessage: string | null;
  readonly usage?: RspTokenUsage;
  readonly model?: string;
  readonly error?: CodexTurnError;
}

// ── Small typed accessors ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function str(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}
function num(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Map an app-server `TokenUsageBreakdown` into the RSP usage shape. `inputTokens`
 *  includes cached input, so `input` removes `cacheRead` and the buckets stay
 *  disjoint; `total = input + output + cacheRead` reconciles with codex's own. */
export function mapTokenUsageBreakdown(
  breakdown: Record<string, unknown> | null,
): RspTokenUsage | undefined {
  if (!breakdown) return undefined;
  const inputTokens = num(breakdown, "inputTokens");
  const cacheRead = num(breakdown, "cachedInputTokens");
  const output = num(breakdown, "outputTokens");
  const reasoning = num(breakdown, "reasoningOutputTokens");
  const input = Math.max(inputTokens - cacheRead, 0);
  return { input, output, cacheRead, cacheWrite: 0, reasoning, total: input + output + cacheRead };
}

/** Extract the final agent message text from a completed turn's `items` array
 *  (the last `agentMessage` item wins), as a backstop to the streamed capture. */
function finalMessageFromItems(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  let text: string | null = null;
  for (const raw of items) {
    const item = asRecord(raw);
    if (item?.type === "agentMessage") text = str(item, "text") ?? text;
  }
  return text;
}

// ── Composed turn parameters (full-capability by default; Rule Zero) ────────────

/** The full-access sandbox policy — the app-server peer of `--dangerously-bypass-
 *  approvals-and-sandbox`. */
export const FULL_ACCESS_SANDBOX_POLICY = { type: "dangerFullAccess" } as const;
/** Never-ask approvals: server-initiated approval requests are made unreachable. */
export const NEVER_ASK_APPROVAL_POLICY = "never" as const;

function threadStartParams(params: AppServerTurnParams): Record<string, unknown> {
  return {
    cwd: params.cwd,
    approvalPolicy: NEVER_ASK_APPROVAL_POLICY,
    sandbox: "danger-full-access",
    ...(params.model === undefined ? {} : { model: params.model }),
  };
}

function turnStartParams(threadId: string, params: AppServerTurnParams): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: params.prompt }],
    cwd: params.cwd,
    sandboxPolicy: FULL_ACCESS_SANDBOX_POLICY,
    approvalPolicy: NEVER_ASK_APPROVAL_POLICY,
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.effort === undefined ? {} : { effort: params.effort }),
    ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
  };
}

// ── The turn runner (the state machine both callers drive) ──────────────────────

/**
 * Run exactly one turn over a live connection, yielding each app-server
 * notification (never dropped) followed by the ONE synthetic terminal frame. The
 * child is killed on completion (turn-scoped, design D1). An aborted signal sends
 * `turn/interrupt` (when a turn id is known) and resolves to a `cancelled`
 * terminal after the server's own `turn/completed`(interrupted) or process exit.
 */
export async function* runCodexTurn(
  conn: AppServerConnection,
  params: AppServerTurnParams,
): AsyncGenerator<Record<string, unknown> | CodexTurnResultFrame> {
  let nextId = 0;
  const initId = ++nextId;
  let threadStartId = -1;
  let turnStartId = -1;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let observedModel: string | undefined;
  let finalMessage: string | null = null;
  let usage: RspTokenUsage | undefined;
  let interruptSent = false;

  const onAbort = (): void => {
    if (threadId !== null && turnId !== null && !interruptSent) {
      interruptSent = true;
      conn.send({ id: ++nextId, method: "turn/interrupt", params: { threadId, turnId } });
    } else {
      // No turn id yet (abort before the turn started) — kill directly.
      conn.kill();
    }
  };
  const signal = params.signal;
  if (signal?.aborted) {
    conn.kill();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  const terminalFromTurn = (turn: Record<string, unknown> | null): CodexTurnResultFrame => {
    const status = str(turn, "status");
    if (status === "interrupted" || interruptSent) {
      return {
        rennet: "turn-result",
        status: "cancelled",
        finalMessage,
        ...(usage ? { usage } : {}),
        ...(observedModel ? { model: observedModel } : {}),
      };
    }
    if (status === "failed") {
      const te = asRecord(turn?.error);
      return {
        rennet: "turn-result",
        status: "failed",
        finalMessage,
        error: {
          source: "turn",
          message: str(te, "message") ?? "codex turn failed",
          ...(te?.codexErrorInfo === undefined ? {} : { codexErrorInfo: te.codexErrorInfo }),
        },
        ...(usage ? { usage } : {}),
        ...(observedModel ? { model: observedModel } : {}),
      };
    }
    return {
      rennet: "turn-result",
      status: "completed",
      finalMessage: finalMessage ?? finalMessageFromItems(turn?.items),
      ...(usage ? { usage } : {}),
      ...(observedModel ? { model: observedModel } : {}),
    };
  };

  try {
    conn.send({ id: initId, method: "initialize", params: { clientInfo: CODEX_CLIENT_INFO } });
    for await (const msg of conn.messages) {
      const method = str(msg, "method");
      const id = msg.id;
      const hasId = id !== undefined && id !== null;

      // A response to one of our requests (id present, no method).
      if (method === null && hasId) {
        if (msg.error !== undefined && msg.error !== null) {
          const err = asRecord(msg.error);
          yield {
            rennet: "turn-result",
            status: "failed",
            finalMessage,
            error: {
              source: "jsonrpc",
              message: str(err, "message") ?? "codex app-server error",
              ...(typeof err?.code === "number" ? { code: err.code } : {}),
            },
          };
          return;
        }
        const result = asRecord(msg.result);
        if (id === initId) {
          conn.send({ method: "initialized", params: {} });
          threadStartId = ++nextId;
          conn.send({
            id: threadStartId,
            method: "thread/start",
            params: threadStartParams(params),
          });
        } else if (id === threadStartId) {
          threadId = str(asRecord(result?.thread), "id");
          observedModel = str(result, "model") ?? observedModel;
          if (threadId === null) {
            yield {
              rennet: "turn-result",
              status: "failed",
              finalMessage,
              error: { source: "jsonrpc", message: "thread/start returned no thread id" },
            };
            return;
          }
          turnStartId = ++nextId;
          conn.send({
            id: turnStartId,
            method: "turn/start",
            params: turnStartParams(threadId, params),
          });
        } else if (id === turnStartId) {
          // The turn/start response carries the completed Turn as a backstop; the
          // `turn/completed` notification is the primary terminal (handled below).
          yield terminalFromTurn(asRecord(result?.turn));
          return;
        }
        continue;
      }

      // A server → client request (method AND id): answer affirmatively (D4) and
      // surface as evidence — never queue for a human, never drop.
      if (method !== null && hasId) {
        conn.send({ id, result: affirmativeApprovalResult(method) });
        yield msg;
        continue;
      }

      // A notification (method, no id).
      if (method !== null) {
        const p = asRecord(msg.params);
        if (method === "turn/started") {
          turnId = str(asRecord(p?.turn), "id") ?? turnId;
        } else if (method === "item/completed") {
          const item = asRecord(p?.item);
          if (item?.type === "agentMessage") finalMessage = str(item, "text") ?? finalMessage;
        } else if (method === "thread/tokenUsage/updated") {
          const tu = asRecord(p?.tokenUsage);
          usage = mapTokenUsageBreakdown(asRecord(tu?.total) ?? asRecord(tu?.last)) ?? usage;
        }
        yield msg;
        if (method === "turn/completed") {
          yield terminalFromTurn(asRecord(p?.turn));
          return;
        }
      }
      // A message with neither method nor a matched id — ignore (never dropped
      // that is modelled: notifications and responses are the only real shapes).
    }

    // The stream ended before a terminal notification: the process exited.
    const exit = await conn.exit;
    if (exit.aborted || interruptSent) {
      yield {
        rennet: "turn-result",
        status: "cancelled",
        finalMessage,
        ...(usage ? { usage } : {}),
        ...(observedModel ? { model: observedModel } : {}),
      };
      return;
    }
    yield {
      rennet: "turn-result",
      status: "failed",
      finalMessage,
      error: {
        source: "exit",
        message: `codex app-server exited before completing the turn (code ${exit.exitCode ?? "unknown"})${exit.stderr.trim() ? `: ${exit.stderr.trim()}` : ""}`,
        exitCode: exit.exitCode,
      },
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    conn.kill();
  }
}

/** The affirmative response body for a server-initiated approval request. Shapes
 *  differ per approval method, but every one accepts a `decision`/`approved` grant;
 *  we send the broadest affirmative. Unreachable under never-ask, defensive only. */
function affirmativeApprovalResult(method: string): Record<string, unknown> {
  void method;
  return { decision: "approved", approved: true };
}

// ── Argv composition ────────────────────────────────────────────────────────────

/**
 * The `codex app-server` argv. canvasOps@2 (and future) loopback MCP servers ride
 * spawn-time `-c mcp_servers.<name>.url=<url>` config overrides exactly as the exec
 * transport did (design D6). No prompt, no schema flag, no `-o` capture — the turn
 * is driven over stdio, not argv.
 */
export function buildAppServerArgs(
  mcpServers?: Readonly<Record<string, { readonly url: string }>>,
): string[] {
  const args = ["app-server"];
  for (const [name, server] of Object.entries(mcpServers ?? {})) {
    args.push("-c", `mcp_servers.${name}.url=${server.url}`);
  }
  return args;
}

// ── The real spawn (execa) ──────────────────────────────────────────────────────

/** The real bidirectional spawn: piped stdio, readline over stdout, killable tree. */
export const defaultSpawnAppServer: SpawnAppServer = ({ bin, args, cwd, signal }) => {
  const child = execa(bin, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
    buffer: false,
    killDescendants: true,
    forceKillAfterDelay: 1_000,
    ...(signal === undefined ? {} : { cancelSignal: signal }),
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  async function* messages(): AsyncIterable<Record<string, unknown>> {
    const stdout = child.stdout;
    if (!stdout) return;
    const lines = createInterface({ input: stdout });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // a stray non-JSON log line on stdout
      }
      const record = asRecord(parsed);
      if (record) yield record;
    }
  }
  const exit = child.then(
    (result) => ({
      exitCode: result.exitCode ?? null,
      stderr,
      aborted: result.isCanceled === true || signal?.aborted === true,
    }),
    () => ({ exitCode: null, stderr, aborted: signal?.aborted === true }),
  );
  return {
    send: (message) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    messages: messages(),
    kill: () => {
      child.kill();
    },
    exit,
  };
};
