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
 *      (Rule Zero acting path, design D4). The `turn/start` RESPONSE is an ACK that
 *      may carry `status: "inProgress"`; the turn TERMINATES only on the matching
 *      `turn/completed` notification (or an error/exit path).
 *   4. Streaming notifications (`item/agentMessage/delta`, `item/started`,
 *      `item/completed`, `thread/tokenUsage/updated`, …), terminal
 *      `turn/completed` {threadId, turn:{id, items, status, error?}}.
 *
 * Correlation: every response is matched to the id we sent; a foreign response is
 * passed through but never mutates run state or terminates. Every notification is
 * checked against our thread/turn id; a foreign-thread/turn notification is passed
 * through (never dropped) but does not touch final text/usage or terminate.
 *
 * `jsonrpc` is OMITTED on the wire (the server omits it and does not require it).
 * The server may send us REQUESTS (approvals): the composed full-access policy makes
 * them unreachable, but any that arrives is answered affirmatively with the
 * method's schema-valid decision (never queued for a human) and surfaced as a
 * passthrough frame — no approval plumbing enters the adapter.
 *
 * Never reads a credential: `codex` authenticates itself on the user's own
 * subscription (shared `~/.codex` auth home).
 */

import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { HOST_LOCUS, type Locus, locusCommand } from "@rennet/core";
import type { RspTokenUsage } from "@rennet/protocol";
import { execa } from "execa";

/** How Rennet introduces itself on `initialize`. */
export const CODEX_CLIENT_INFO = { name: "rennet", title: "Rennet", version: "1" } as const;

/** Grace after `turn/interrupt` before force-killing the child if the server has
 *  not answered with `turn/completed`(interrupted). */
export const INTERRUPT_GRACE_MS = 2_000;

/** Sentinel key a malformed stdout line surfaces under (a protocol violation:
 *  app-server stdout is pure JSON-RPC, so an unparseable line is a real fault). */
const PARSE_ERROR_KEY = "__rennetParseError";

// ── The injected process seam (bidirectional, so the handshake is hermetic) ────

/** The resolved exit of a `codex app-server` child. `spawnError` is set when the
 *  process never started (ENOENT and friends). */
export interface AppServerExit {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly aborted: boolean;
  readonly spawnError?: string;
}

/** One live `codex app-server` child: write JSON messages, read parsed messages. */
export interface AppServerConnection {
  /** Write one JSON-RPC message as a single newline-terminated line to stdin. */
  send(message: Record<string, unknown>): void;
  /** Parsed stdout messages, one per non-empty line. A malformed line surfaces as
   *  a `{ [PARSE_ERROR_KEY]: line }` sentinel, never silently dropped. */
  readonly messages: AsyncIterable<Record<string, unknown>>;
  /** Kill the child and its descendants. */
  kill(): void;
  /** Resolves when the child exits. */
  readonly exit: Promise<AppServerExit>;
}

/** Spawn a `codex app-server` child. Injected so the runner is testable without a
 *  real process. `bin`/`args`/`cwd` are already locus-wrapped by the caller. The
 *  runner OWNS the kill (via `kill()`), so no caller `AbortSignal` is handed to the
 *  process — that avoids execa racing the in-flight `turn/interrupt` write. */
export type SpawnAppServer = (spec: {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
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
  /**
   * #585: start the thread ephemeral — "the thread is ephemeral and should not be
   * materialized on disk" (app-server `ThreadStartParams`, verified against
   * codex-cli 0.147.0), so no rollout lands in `~/.codex/sessions/`. Absent ⇒
   * codex's normal persistence, which a user's own agentic thread keeps.
   */
  readonly ephemeral?: boolean;
  readonly signal?: AbortSignal;
}

/** The normalized failure carried on a `failed` terminal frame. `source`
 *  disambiguates a turn-level failure (provider) from a transport/process one. */
export interface CodexTurnError {
  readonly source: "turn" | "jsonrpc" | "exit" | "spawn" | "parse";
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

/** The turn id a notification names (`turnId`, or the nested `turn.id`). */
function notificationTurnId(params: Record<string, unknown> | null): string | null {
  return str(params, "turnId") ?? str(asRecord(params?.turn), "id");
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
    ...(params.ephemeral === undefined ? {} : { ephemeral: params.ephemeral }),
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

/**
 * The response to a server-initiated request, dispatched EXHAUSTIVELY by method so
 * every reply matches that request's response schema (`.appserver-schema/`). Most
 * approvals are unreachable under never-ask + full-access, but `item/tool/
 * requestUserInput` and `mcpServer/elicitation/request` are NOT approval-gated and
 * can arrive in a real turn — a wrong shape would stall it. Returns either a
 * `result` body or a JSON-RPC `error` (for requests we cannot satisfy validly).
 *
 *   - v2 `item/{commandExecution,fileChange}/requestApproval` → `{ decision: "accept" }`
 *   - v2 `item/permissions/requestApproval` → `{ permissions: {} }` (empty granted profile;
 *     full-access already covers it — the fields are all nullable)
 *   - legacy `execCommandApproval`/`applyPatchApproval` (ReviewDecision) → `{ decision: "approved" }`
 *   - `item/tool/requestUserInput` → `{ answers: {} }` (schema-valid empty answers)
 *   - `mcpServer/elicitation/request` → `{ action: "decline" }` (no form data to accept; a
 *     valid, non-stalling response)
 *   - `item/tool/call` → `-32601` (dynamic tools; unreachable — we never opt into
 *     experimentalApi/dynamicTools — but named so union growth cannot slip through)
 *   - `account/chatgptAuthTokens/refresh` / `attestation/generate` → we cannot mint a valid
 *     token, so a JSON-RPC error (never a bogus result shape that the server rejects/hangs on)
 *   - unknown → method-not-found error (`-32601`)
 */
export function serverRequestResponse(
  method: string,
): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "accept" } };
    case "item/permissions/requestApproval":
      return { result: { permissions: {} } };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { result: { decision: "approved" } };
    case "item/tool/requestUserInput":
      return { result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline" } };
    case "item/tool/call":
      // A dynamic tool call — unreachable today (we never opt into experimentalApi /
      // dynamic tools). Named explicitly so a schema-union addition cannot silently
      // slip through the exhaustive claim into the default branch.
      return { error: { code: -32601, message: "Rennet does not support dynamic tool calls" } };
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
      return {
        error: { code: -32601, message: `Rennet cannot satisfy ${method}` },
      };
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── The turn runner (the state machine both callers drive) ──────────────────────

/**
 * Run exactly one turn over a live connection, yielding each app-server
 * notification (never dropped) followed by the ONE synthetic terminal frame. The
 * child is killed and its exit awaited on completion (turn-scoped, design D1). An
 * aborted signal sends `turn/interrupt` (when a turn id is known), waits a bounded
 * grace for the server's own `turn/completed`(interrupted), then force-kills; the
 * run resolves `cancelled`.
 */
export async function* runCodexTurn(
  conn: AppServerConnection,
  params: AppServerTurnParams,
): AsyncGenerator<Record<string, unknown> | CodexTurnResultFrame> {
  let nextId = 0;
  const pending = new Set<number>();
  const send = (message: Record<string, unknown>): number | null => {
    const id = message.id;
    if (typeof id === "number") pending.add(id);
    conn.send(message);
    return typeof id === "number" ? id : null;
  };

  const initId = send({
    id: ++nextId,
    method: "initialize",
    params: { clientInfo: CODEX_CLIENT_INFO },
  });
  let threadStartId = -1;
  let turnStartId = -1;
  let interruptId = -1;
  let ownThreadId: string | null = null;
  let ownTurnId: string | null = null;
  let observedModel: string | undefined;
  let finalMessage: string | null = null;
  let usage: RspTokenUsage | undefined;
  let interruptSent = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => {
    if (interruptSent) return;
    interruptSent = true;
    if (ownThreadId !== null && ownTurnId !== null) {
      interruptId =
        send({
          id: ++nextId,
          method: "turn/interrupt",
          params: { threadId: ownThreadId, turnId: ownTurnId },
        }) ?? -1;
      graceTimer = setTimeout(() => conn.kill(), INTERRUPT_GRACE_MS);
      graceTimer.unref?.();
    } else {
      // No turn id yet (abort before the turn started) — kill directly.
      conn.kill();
    }
  };
  const signal = params.signal;
  if (signal?.aborted) {
    conn.kill();
    interruptSent = true;
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  /** Does this notification belong to OUR thread/turn? A foreign one is passed
   *  through (never dropped) but must not touch state or terminate. */
  const belongs = (p: Record<string, unknown> | null): boolean => {
    const tid = str(p, "threadId");
    if (ownThreadId !== null && tid !== null && tid !== ownThreadId) return false;
    const turnId = notificationTurnId(p);
    if (ownTurnId !== null && turnId !== null && turnId !== ownTurnId) return false;
    return true;
  };

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
    for await (const msg of conn.messages) {
      // A malformed stdout line: a protocol violation, surfaced as a transport failure.
      if (typeof msg[PARSE_ERROR_KEY] === "string") {
        yield {
          rennet: "turn-result",
          status: "failed",
          finalMessage,
          error: {
            source: "parse",
            message: `unparseable codex app-server line: ${msg[PARSE_ERROR_KEY]}`,
          },
        };
        return;
      }

      const method = str(msg, "method");
      const id = msg.id;
      const hasId = id !== undefined && id !== null;
      const nid = typeof id === "number" ? id : null;

      // A response to a request (id present, no method).
      if (method === null && hasId) {
        if (msg.error !== undefined && msg.error !== null) {
          // An error response to our `turn/interrupt` is expected on the cancel
          // path — keep waiting for turn/completed(interrupted)/exit, don't fail.
          if (nid === interruptId) continue;
          if (nid !== null && pending.has(nid)) {
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
          yield msg; // foreign error response — surfaced, never terminates our run
          continue;
        }
        const result = asRecord(msg.result);
        if (nid === initId) {
          conn.send({ method: "initialized", params: {} });
          threadStartId =
            send({ id: ++nextId, method: "thread/start", params: threadStartParams(params) }) ?? -1;
        } else if (nid === threadStartId) {
          ownThreadId = str(asRecord(result?.thread), "id");
          observedModel = str(result, "model") ?? observedModel;
          if (ownThreadId === null) {
            yield {
              rennet: "turn-result",
              status: "failed",
              finalMessage,
              error: { source: "jsonrpc", message: "thread/start returned no thread id" },
            };
            return;
          }
          turnStartId =
            send({
              id: ++nextId,
              method: "turn/start",
              params: turnStartParams(ownThreadId, params),
            }) ?? -1;
        } else if (nid === turnStartId) {
          // ACK only — capture the turn id; the response may carry status
          // "inProgress". The turn terminates on the turn/completed notification.
          ownTurnId = ownTurnId ?? str(asRecord(result?.turn), "id");
        } else {
          yield msg; // foreign success response — surfaced, non-terminating
        }
        continue;
      }

      // A server → client request (method AND id): answer with the method's
      // schema-valid response (D4), and surface the request as evidence.
      if (method !== null && hasId) {
        conn.send({ id, ...serverRequestResponse(method) });
        yield msg;
        continue;
      }

      // A notification (method, no id). Ownership is decided HERE (the runner is
      // authoritative) and marked on what we emit: an owned notification flows
      // through with its method for the adapter to normalize; a FOREIGN one is
      // wrapped as a passthrough envelope so the adapter surfaces it (never dropped)
      // but never mutates our final text/usage or terminates our turn.
      if (method !== null) {
        const p = asRecord(msg.params);
        if (!belongs(p)) {
          yield { rennet: "foreign", native: msg };
          continue;
        }
        if (method === "turn/started") {
          ownTurnId = ownTurnId ?? str(asRecord(p?.turn), "id");
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
        continue;
      }
      // A message with neither method nor a matched id — surface, never drop.
      yield msg;
    }

    // The stream ended before a terminal notification: the process exited.
    const exit = await conn.exit;
    if (exit.spawnError !== undefined) {
      yield {
        rennet: "turn-result",
        status: "failed",
        finalMessage,
        error: { source: "spawn", message: exit.spawnError },
      };
      return;
    }
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
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    signal?.removeEventListener("abort", onAbort);
    conn.kill();
    // Await the real process exit so interrupt()/close() never resolve with
    // descendants still alive (the kill owns the tree via killDescendants).
    await conn.exit;
  }
}

/** The synthetic spawn-failure terminal frame, for callers that catch a synchronous
 *  spawn throw before a connection exists (never leaves the event stream). */
export function spawnFailureFrame(error: unknown): CodexTurnResultFrame {
  return {
    rennet: "turn-result",
    status: "failed",
    finalMessage: null,
    error: {
      source: "spawn",
      message: `codex app-server failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
    },
  };
}

// ── Argv composition ────────────────────────────────────────────────────────────

export interface CodexMcpServerInventoryEntry {
  readonly name: string;
  readonly transport: "stdio" | "streamable_http";
}

export interface CodexMcpListCommandSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

export interface CodexMcpListCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunCodexMcpList = (spec: CodexMcpListCommandSpec) => Promise<CodexMcpListCommandResult>;

export const defaultRunCodexMcpList: RunCodexMcpList = async ({ bin, args, cwd }) => {
  const result = await execa(bin, [...args], { cwd, reject: false, stdin: "ignore" });
  return {
    exitCode: result.exitCode ?? null,
    stdout: result.stdout == null ? "" : String(result.stdout),
    stderr: result.stderr == null ? "" : String(result.stderr),
  };
};

/** Validate the untrusted `codex mcp list --json` result at the process seam. */
export async function readCodexMcpServerInventory(
  run: RunCodexMcpList,
  spec: CodexMcpListCommandSpec,
): Promise<readonly CodexMcpServerInventoryEntry[]> {
  let result: CodexMcpListCommandResult;
  try {
    result = await run(spec);
  } catch (cause) {
    throw new Error("codex mcp list --json could not run", { cause });
  }
  if (result.exitCode !== 0) {
    throw new Error(`codex mcp list --json exited ${result.exitCode ?? "without a status"}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error("codex mcp list --json returned invalid JSON", { cause });
  }
  if (!Array.isArray(value)) {
    throw new Error("codex mcp list --json returned a non-array inventory");
  }

  const names = new Set<string>();
  return value.map((raw, index) => {
    const entry = asRecord(raw);
    const name = str(entry, "name");
    const transport = str(asRecord(entry?.transport), "type");
    if (name === null || name.length === 0) {
      throw new Error(`codex mcp list --json entry ${index} has no name`);
    }
    if (names.has(name)) {
      throw new Error(`codex mcp list --json contains duplicate server ${tomlString(name)}`);
    }
    names.add(name);
    switch (transport) {
      case "stdio":
      case "streamable_http":
        return { name, transport };
      default:
        throw new Error(`codex mcp list --json entry ${index} has an unsupported transport`);
    }
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render one inline table that shadows every configured ambient server. Codex
 * deep-merges `-c` tables into the user's config, so `{}` cannot clear the
 * ambient table. Disabled placeholders must retain each entry's transport kind
 * or Codex rejects the merged config before it observes `enabled=false`.
 */
function renderMcpServersToml(
  servers: Readonly<Record<string, { readonly url: string }>>,
  ambientServers: readonly CodexMcpServerInventoryEntry[],
): string {
  const requested = new Map(Object.entries(servers));
  const ambient = new Map(ambientServers.map((server) => [server.name, server]));
  const names = [...new Set([...ambient.keys(), ...requested.keys()])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const entries = names.map((name) => {
    const requestedServer = requested.get(name);
    if (requestedServer !== undefined) {
      if (ambient.has(name)) {
        throw new Error(`requested MCP server ${tomlString(name)} is already configured by Codex`);
      }
      return `${tomlString(name)}={url=${tomlString(requestedServer.url)},enabled=true}`;
    }
    const ambientServer = ambient.get(name);
    if (ambientServer === undefined) {
      throw new Error(`missing ambient MCP inventory for ${tomlString(name)}`);
    }
    if (ambientServer.transport === "stdio") {
      return `${tomlString(name)}={command="false",args=[],enabled=false}`;
    }
    return `${tomlString(name)}={url="http://127.0.0.1",enabled=false}`;
  });
  return `{${entries.join(",")}}`;
}

/**
 * The `codex app-server` argv. `codex app-server` REJECTS `--ignore-user-config`
 * (verified: "unexpected argument"), and `-c` deep-merges tables. An explicit MCP
 * policy therefore disables plugin discovery and writes one inline table
 * containing Rennet's enabled servers plus disabled placeholders for every
 * configured ambient server. No prompt, schema, or `-o` flags are needed because
 * the turn rides stdio.
 *
 * An absent table inherits the user's MCP configuration. An explicit empty table
 * starts no MCP sidecars for a job that does not use them. That does not affect
 * Codex's native repository or shell tools.
 */
export function buildAppServerArgs(): string[];
export function buildAppServerArgs(
  mcpServers: Readonly<Record<string, { readonly url: string }>> | undefined,
  ambientServers: readonly CodexMcpServerInventoryEntry[],
): string[];
export function buildAppServerArgs(
  mcpServers?: Readonly<Record<string, { readonly url: string }>>,
  ambientServers?: readonly CodexMcpServerInventoryEntry[],
): string[] {
  if (mcpServers === undefined) return ["app-server"];
  if (ambientServers === undefined) {
    throw new Error("explicit Codex MCP policy requires the configured server inventory");
  }
  return [
    "app-server",
    "--disable",
    "plugins",
    "-c",
    `mcp_servers=${renderMcpServersToml(mcpServers, ambientServers)}`,
  ];
}

// ── The real spawn (execa) ──────────────────────────────────────────────────────

/** Read parsed JSON-RPC messages off a `codex app-server` stdout stream. A
 *  malformed line surfaces as a `{ [PARSE_ERROR_KEY]: line }` sentinel (never
 *  dropped). Extracted so the parser is tested over a synthetic stream. */
export async function* readAppServerMessages(
  stdout: Readable,
): AsyncIterable<Record<string, unknown>> {
  const lines = createInterface({ input: stdout });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      yield { [PARSE_ERROR_KEY]: trimmed };
      continue;
    }
    const record = asRecord(parsed);
    if (record) yield record;
    else yield { [PARSE_ERROR_KEY]: trimmed };
  }
}

/** The real bidirectional spawn: piped stdio, readline over stdout, killable tree.
 *  Owns its own kill — no caller `AbortSignal` is handed to execa. */
export const defaultSpawnAppServer: SpawnAppServer = ({ bin, args, cwd }) => {
  const child = execa(bin, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
    buffer: false,
    killDescendants: true,
    forceKillAfterDelay: 1_000,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  // `stdout: "pipe"` always yields a stream; the empty fallback is defensive only.
  const messages = readAppServerMessages(child.stdout ?? Readable.from([]));
  const exit: Promise<AppServerExit> = child.then(
    (result) => {
      // With `reject:false`, execa RESOLVES a spawn failure (ENOENT) instead of
      // rejecting: no numeric exit code, `failed` set, not cancelled. Surface it as
      // a spawnError so the runner classifies it as a spawn failure, not a plain exit.
      const r = result as {
        exitCode?: number | null;
        failed?: boolean;
        isCanceled?: boolean;
        shortMessage?: string;
        code?: string;
      };
      const spawnFailed =
        r.failed === true &&
        (r.exitCode === undefined || r.exitCode === null) &&
        r.isCanceled !== true;
      return {
        exitCode: r.exitCode ?? null,
        stderr,
        aborted: r.isCanceled === true,
        ...(spawnFailed
          ? { spawnError: r.shortMessage ?? r.code ?? "codex app-server failed to spawn" }
          : {}),
      };
    },
    (error: unknown) => ({
      exitCode: null,
      stderr,
      aborted: false,
      spawnError: error instanceof Error ? error.message : String(error),
    }),
  );
  return {
    send: (message) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    messages,
    kill: () => {
      child.kill();
    },
    exit,
  };
};

// ── The app-server capability handshake probe (discovery) ───────────────────────

/**
 * Probe a codex candidate for app-server capability: spawn `app-server`, send
 * `initialize`, and resolve true iff the child answers a RESPONSE with the
 * initialize id and a `result` (no `error`) within the timeout. A JSON error
 * response, or any other line, does NOT certify — an old binary that errors on
 * `initialize` must read as unavailable. Never throws.
 */
export async function probeAppServerHandshake(args: {
  readonly candidate: { readonly path: string; readonly runtimePath?: string };
  readonly locus?: Locus;
  readonly spawn?: SpawnAppServer;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const { candidate } = args;
  const spawn = args.spawn ?? defaultSpawnAppServer;
  const locus = args.locus ?? HOST_LOCUS;
  const timeoutMs = args.timeoutMs ?? 10_000;
  const program = candidate.runtimePath ?? candidate.path;
  const programArgs =
    candidate.runtimePath === undefined ? ["app-server"] : [candidate.path, "app-server"];
  const cmd = locusCommand(locus, program, programArgs);
  let conn: AppServerConnection;
  try {
    conn = spawn({ bin: cmd.file, args: cmd.args, cwd: undefined });
  } catch {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const initId = 1;
    conn.send({ id: initId, method: "initialize", params: { clientInfo: CODEX_CLIENT_INFO } });
    return await Promise.race([
      (async () => {
        for await (const message of conn.messages) {
          if (message.id === initId) {
            return message.error === undefined || message.error === null
              ? asRecord(message.result) !== null || message.result !== undefined
              : false;
          }
          // Any other line (a notification, a foreign response) is not the answer.
        }
        return false;
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    conn.kill();
  }
}
