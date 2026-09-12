// The daemon's loopback MCP app-tools server (`session-thread-briefing`, "The app-tools
// server mirrors the board server, under `rennet_app`").
//
// The review's session thread is the reviewer's conversation inside Rennet, and this is
// how it uses Rennet: one HTTP MCP listener the daemon owns, serving `buildAppTools`' whole
// projection of `exposure.agent` and dispatching each call through the SAME `dispatch` the
// WS listener calls. `board-mcp-server.ts` is the model — the wire, the bearer, the port
// record and the JSON-RPC shape are its, deliberately, so the two are read together.
//
// ── Addressing, NOT authorization (Rule Zero) ────────────────────────────────────
// There is no per-tool allow/deny list here, no confirmation and no read-only mode. The
// tool SET is decided in one place — `AGENT_EXPOSED` in `protocol/commands` — and this
// module iterates it. A thread's address names the thread, exactly as a seat's address
// names a board; what it buys is not access (the bearer is that) but IDENTITY: the author
// this server stamps on a call, so an ask the thread stages is the thread's and not the
// reviewer's. See `app-credentials.ts` for why that needs no second secret.
//
// ── A tool result is billed like a prompt (#871, AGENTS.md) ──────────────────────
// Every result that carries a collection is paged: a declared element cap, a declared byte
// budget, an honest marker naming what was elided, and a cursor to ask for the rest. The
// ceilings are measured in `board/board-tool-surface.measure.test.ts` — a new capped row
// earns a row there. The caps are BYTE DISCIPLINE, not a gate: nothing is withheld, only
// split across calls the model can make as many of as it likes.
//
// ── The protocol ────────────────────────────────────────────────────────────────
// MCP over Streamable HTTP, hand-rolled: `initialize`, `notifications/initialized`,
// `tools/list`, `tools/call`, `ping`. Requests are answered as `application/json`, which
// the transport permits in place of an SSE stream, and no `Mcp-Session-Id` is issued —
// session management is optional and the address already identifies the thread. `GET`
// (the server→client stream) is answered `405`, which the transport also permits.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { normalizeOutputSchema } from "@rennet/adapters";
import { type CommandName, commands } from "@rennet/protocol";
import { z } from "zod";
import { type AppTool, type AppToolDispatch, buildAppTools } from "../agent-tools";
import { APP_BEARER_ENV_VAR, APP_MCP_SERVER_NAME } from "./app-credentials";

export { APP_BEARER_ENV_VAR, APP_MCP_SERVER_NAME } from "./app-credentials";

/** The MCP protocol revisions this server answers. The newest is what an unknown one gets. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Body cap for one JSON-RPC message. A tool call is small; anything near this is a bug. */
const MAX_BODY_BYTES = 1_000_000;

// ── The declared caps (design: "Every result that carries a collection…") ────────

/** How many board elements one `app_board_read` page carries. */
export const BOARD_READ_TOOL_ELEMENT_CAP = 200;
/** How many sessions one `app_session_list` page carries. */
export const SESSION_LIST_TOOL_CAP = 50;
/** How many transcript rows one `app_session_transcript` page carries. */
export const TRANSCRIPT_TOOL_ROW_CAP = 100;
/** How much patch text one `app_patchset_readEvidence` page carries. */
export const EVIDENCE_TOOL_BYTES_CAP = 16 * 1024;

/**
 * The SECOND bound on every paged collection, and the one that actually decides the byte
 * ceiling of a result.
 *
 * An element count is not a byte count: a board element is a sentence or a whole finding,
 * so 200 of them is anywhere from 8 kB to 90 kB, and a cap that admits 90 kB into the
 * conversation prefix is not a cap. So a page stops at whichever bound it reaches first,
 * and the marker names the cursor either way. Set to the same 16 kB the evidence read
 * declares, because it is the same question asked of a different payload: how much of one
 * answer may sit in the prefix and be re-read on every remaining round trip of the turn.
 */
export const PAGE_TOOL_BYTES_CAP = EVIDENCE_TOOL_BYTES_CAP;

/**
 * How much of a refusal comes back. A dispatch refusal is a Zod error over a command
 * schema, which can run to thousands of characters of `unionErrors` for one wrong field —
 * a result billed like a prompt to say "that input was wrong".
 */
const REFUSAL_TEXT_CAP = 2_000;

/** What a thread names so its harness child can reach Rennet's app tools. */
export interface AppThreadServer {
  readonly name: string;
  readonly url: string;
  readonly bearerTokenEnvVar: string;
}

export interface AppMcpServer {
  readonly port: number;
  readonly origin: string;
  /**
   * The `mcpServers` entry for one thread — THE SEAM the session bind calls
   * (`dispatch/chat.ts` `bindReviewThread`, cluster 4): it spreads this into
   * `createThread({ mcpServers: { [server.name]: { url, bearerTokenEnvVar } } })`, and the
   * thread carries it for its whole life. Pure: it mints nothing and registers nothing, so
   * the same thread id always yields the same url, which is what both providers require —
   * a session's MCP configuration is fixed when the harness child is created and a later
   * turn naming a different url is refused by name.
   */
  readonly addressFor: (threadId: string) => AppThreadServer;
  readonly close: () => Promise<void>;
}

export interface StartAppMcpServerOptions {
  /**
   * The process bearer every call must carry, READ ON EVERY CALL: the value that is in the
   * sidecar's environment under {@link APP_BEARER_ENV_VAR} right now. A supplier and not a
   * value for the reason the board server's is one — the sidecar respawns within one
   * daemon's life and every spawn puts a fresh bearer in a fresh environment.
   */
  readonly bearer: () => string;
  /**
   * The command router, LATE-BOUND: read when a call arrives, never captured at start.
   *
   * The daemon binds this listener at launch (#849) and `dispatch` is assigned further down
   * the composition root, so a captured value would be `undefined` forever. Reading it per
   * call also guarantees there is only ever ONE dispatch instance — a second one built for
   * this server would keep its own live-run registries and answer from a different daemon.
   */
  readonly dispatch: () => AppToolDispatch;
  /**
   * The review this thread is bound to, when the daemon knows it. Used ONLY to fill a
   * `sessionId` the model left out — never to overrule one it named, because a thread may
   * legitimately ask about another review (that is what `app_session_list` is for).
   */
  readonly sessionFor?: (threadId: string) => string | undefined;
  /** The interface to bind. Loopback, and there is no option that is not. */
  readonly host?: "127.0.0.1" | "::1";
  /**
   * Where the port this listener bound is remembered, so a restarted daemon comes back on
   * the SAME port and a thread's url is the url its session was opened with. The sidecar's
   * private base dir; absent ⇒ nothing is remembered and an ephemeral port is bound, which
   * is what a test wants.
   */
  readonly stateDir?: string;
  /** Bind exactly this port. Overrides whatever {@link StartAppMcpServerOptions.stateDir} remembers. */
  readonly port?: number;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

function digestsMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const utf8 = (value: string): number => Buffer.byteLength(value, "utf8");

/** Where the bound port is remembered between daemon runs. Not a secret; a port. */
const PORT_RECORD = "app-server.json";

function rememberedPort(stateDir: string | undefined): number | undefined {
  if (stateDir === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, PORT_RECORD), "utf8"));
    const port = (parsed as { port?: unknown }).port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function rememberPort(stateDir: string | undefined, port: number): void {
  if (stateDir === undefined) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, PORT_RECORD);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ port })}\n`);
    renameSync(tmp, path);
  } catch {
    // A port we could not write down is a url that will not survive a restart, which the
    // adapter refuses loudly. It is not a reason to fail the listener that is working.
  }
}

// ── The served catalog ──────────────────────────────────────────────────────────

/**
 * The extra input a PAGED tool takes: where in the collection this call starts.
 *
 * Added to the SERVED JSON schema, never to the registry's Zod schema — the registry row is
 * the command's contract and this is the tool surface's own pagination. Stripped again
 * before dispatch, so the command never sees a field it does not declare.
 */
const CURSOR_PROPERTY = {
  type: "integer",
  minimum: 0,
  description:
    "Where this page starts. Omit for the first page; a truncated result names the cursor for the next one.",
} as const;

/** The command ids whose results are paged, and the element cap each one declares. */
const PAGED_ROWS: Partial<Record<CommandName, number>> = {
  "board.read": BOARD_READ_TOOL_ELEMENT_CAP,
  "session.list": SESSION_LIST_TOOL_CAP,
  "session.transcript": TRANSCRIPT_TOOL_ROW_CAP,
  // Bytes, not rows: the evidence read's payload is one patch text, so its page is measured
  // in bytes and its cursor is a byte offset.
  "patchset.readEvidence": EVIDENCE_TOOL_BYTES_CAP,
};

const isPaged = (commandId: CommandName): boolean => PAGED_ROWS[commandId] !== undefined;

/**
 * One tool as `tools/list` answers it.
 *
 * `normalizeOutputSchema` is what drops the top-level `$schema`/`$id` Zod stamps, and it is
 * the SAME choke point Rennet's own adapter routes every provider-bound schema through. It
 * matters here for the reason it matters on the board server: an `inputSchema` is carried
 * by the harness child into the provider's tool definitions with nothing on that path to
 * strip it, and a meta declaration the installed `claude` CLI's ajv does not recognise is a
 * schema refused before the turn runs (#810). The schema BODY is untouched.
 */
function servedTool(tool: AppTool): {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
} {
  const schema = normalizeOutputSchema(z.toJSONSchema(tool.inputSchema, { io: "input" }));
  if (isPaged(tool.commandId) && typeof schema.properties === "object" && schema.properties) {
    schema.properties = { ...(schema.properties as object), cursor: CURSOR_PROPERTY };
  }
  return { name: tool.name, description: tool.description, inputSchema: schema };
}

/**
 * The whole served catalog — a projection of `exposure.agent` and nothing else.
 *
 * Exported so a test can compare it against `buildAppTools`' own names without going
 * through the wire, and so the measurement can price it. The wire path calls this too:
 * there is one catalog, not a copy of one.
 */
export function servedAppToolCatalog(dispatch: AppToolDispatch): ReturnType<typeof servedTool>[] {
  return buildAppTools(dispatch).map(servedTool);
}

// ── Paging a result ─────────────────────────────────────────────────────────────

/** What one tool call hands back: the data block, and an honest marker when it was paged. */
export interface AppToolResult {
  readonly text: string;
  /** Present only when something was elided. Says how much, and the cursor for the rest. */
  readonly marker?: string;
}

interface Page<T> {
  readonly taken: readonly T[];
  readonly next: number | undefined;
  readonly total: number;
  /** True when the byte budget stopped the page before the element cap did. */
  readonly byBytes: boolean;
}

/**
 * One page of a collection: at most `cap` items AND at most {@link PAGE_TOOL_BYTES_CAP}
 * bytes, whichever comes first, starting at `cursor`.
 *
 * The byte half is measured on the items as serialized, item by item, so the bound holds
 * whatever the items are — a board of one-line prose and a board of whole findings page
 * differently and both stay under the same ceiling. At least one item is always taken, even
 * when it alone exceeds the budget: a page of nothing would be a collection the model can
 * never read, which is a gate rather than a cap.
 */
function page<T>(items: readonly T[], cursor: number, cap: number): Page<T> {
  const start = Math.max(0, Math.min(cursor, items.length));
  const taken: T[] = [];
  let bytes = 0;
  let byBytes = false;
  for (let index = start; index < items.length && taken.length < cap; index += 1) {
    const item = items[index] as T;
    const size = utf8(JSON.stringify(item) ?? "");
    if (taken.length > 0 && bytes + size > PAGE_TOOL_BYTES_CAP) {
      byBytes = true;
      break;
    }
    taken.push(item);
    bytes += size;
  }
  const end = start + taken.length;
  return {
    taken,
    next: end < items.length ? end : undefined,
    total: items.length,
    byBytes,
  };
}

/** The honest marker a paged result carries, or `undefined` when nothing was elided. */
function pageMarker(
  toolName: string,
  noun: string,
  start: number,
  result: Page<unknown>,
): string | undefined {
  if (result.next === undefined && start === 0) return undefined;
  const shown = `${noun} ${start}–${start + result.taken.length - 1} of ${result.total}`;
  if (result.next === undefined) return `Served ${shown}. This is the last page.`;
  const why = result.byBytes
    ? `the ${PAGE_TOOL_BYTES_CAP}-byte page budget`
    : `this tool's ${noun} cap`;
  return `Served ${shown} — ${result.total - result.next} elided by ${why}. Call ${toolName} again with cursor: ${result.next} for the rest.`;
}

/** A byte page over one string (the evidence read's patch text). */
function pageText(
  toolName: string,
  field: string,
  text: string,
  cursor: number,
): { readonly text: string; readonly marker?: string } {
  const buffer = Buffer.from(text, "utf8");
  const start = Math.max(0, Math.min(cursor, buffer.length));
  const end = Math.min(start + EVIDENCE_TOOL_BYTES_CAP, buffer.length);
  const slice = buffer.subarray(start, end).toString("utf8");
  if (start === 0 && end === buffer.length) return { text: slice };
  const marker =
    end < buffer.length
      ? `Served bytes ${start}–${end} of ${buffer.length} of \`${field}\` — ${buffer.length - end} elided by this tool's ${EVIDENCE_TOOL_BYTES_CAP}-byte cap. Call ${toolName} again with cursor: ${end} for the rest.`
      : `Served bytes ${start}–${end} of ${buffer.length} of \`${field}\`. This is the last page.`;
  return { text: slice, marker };
}

/**
 * Shape one command's output for the model: the whole thing when it fits, one page and an
 * honest marker when it does not.
 *
 * Exported because the measurement drives THIS function — the one the wire calls — rather
 * than a rebuild of it. Three times on the board server an assertion pointed at a copy of
 * the thing instead of the thing (`board-tool-surface.measure.test.ts` names them).
 */
export function shapeAppToolResult(
  commandId: CommandName,
  output: unknown,
  cursor = 0,
): AppToolResult {
  const toolName = `app_${commandId.replaceAll(".", "_")}`;
  const record = (output ?? {}) as Record<string, unknown>;
  switch (commandId) {
    case "board.read": {
      const board = record.board as { elements?: unknown } | null | undefined;
      const elements = Array.isArray(board?.elements) ? (board.elements as unknown[]) : undefined;
      if (board === null || board === undefined || elements === undefined) break;
      const paged = page(elements, cursor, BOARD_READ_TOOL_ELEMENT_CAP);
      const marker = pageMarker(toolName, "elements", Math.min(cursor, elements.length), paged);
      if (marker === undefined) break;
      return {
        text: JSON.stringify({ ...record, board: { ...board, elements: paged.taken } }),
        marker,
      };
    }
    case "session.list": {
      const sessions = record.sessions;
      if (!Array.isArray(sessions)) break;
      const paged = page(sessions, cursor, SESSION_LIST_TOOL_CAP);
      const marker = pageMarker(toolName, "sessions", Math.min(cursor, sessions.length), paged);
      if (marker === undefined) break;
      return { text: JSON.stringify({ ...record, sessions: paged.taken }), marker };
    }
    case "session.transcript": {
      const rows = record.rows;
      if (!Array.isArray(rows)) break;
      const paged = page(rows, cursor, TRANSCRIPT_TOOL_ROW_CAP);
      const marker = pageMarker(toolName, "rows", Math.min(cursor, rows.length), paged);
      if (marker === undefined) break;
      return { text: JSON.stringify({ ...record, rows: paged.taken }), marker };
    }
    case "patchset.readEvidence": {
      if (typeof record.patch !== "string") break;
      const paged = pageText(toolName, "patch", record.patch, cursor);
      if (paged.marker === undefined) break;
      return {
        text: JSON.stringify({ ...record, patch: paged.text }),
        marker: paged.marker,
      };
    }
    default:
      break;
  }
  return { text: JSON.stringify(output ?? null) };
}

/** A refusal, held to the same byte discipline as everything else a result carries. */
export function refusalText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return utf8(message) <= REFUSAL_TEXT_CAP
    ? message
    : `${Buffer.from(message, "utf8").subarray(0, REFUSAL_TEXT_CAP).toString("utf8")}\n… and ${utf8(message) - REFUSAL_TEXT_CAP} more bytes of this refusal, elided.`;
}

// ── Stamping the caller ─────────────────────────────────────────────────────────

/** The shape of a Zod object's `.shape`, when the row's args is one. */
function shapeOf(commandId: CommandName): Record<string, unknown> | undefined {
  const args = commands[commandId].args as unknown as { shape?: Record<string, unknown> };
  return typeof args.shape === "object" && args.shape !== null ? args.shape : undefined;
}

/**
 * The arguments a call actually dispatches with: the model's, with the identity fields
 * stamped from the ADDRESS the call arrived on.
 *
 * Two stamps, both because the address knows and the model does not get to say:
 *
 * - `author` — a row that carries one (`ask.quoteReply`) records who spoke, and the model
 *   naming itself `"user"` would put its words in the reviewer's mouth in a durable log.
 * - `sessionId` — filled only when the model left it out and the thread's own review is
 *   known. Never overwritten: asking about another review is exactly what `app_session_list`
 *   and `app_review_load` are for.
 */
export function stampedArguments(input: {
  readonly commandId: CommandName;
  readonly args: Record<string, unknown>;
  readonly sessionId?: string;
}): Record<string, unknown> {
  const shape = shapeOf(input.commandId);
  if (shape === undefined) return input.args;
  const next = { ...input.args };
  if (Object.hasOwn(shape, "author")) next.author = "orchestrator";
  if (
    Object.hasOwn(shape, "sessionId") &&
    next.sessionId === undefined &&
    input.sessionId !== undefined
  ) {
    next.sessionId = input.sessionId;
  }
  return next;
}

// ── The listener ────────────────────────────────────────────────────────────────

/**
 * Start the loopback app-tools server. Resolves once it is listening.
 *
 * Its own listener, deliberately, for the reason the board server has its own: the
 * sidecar's `/mcp` sits outside T3's environment auth stack and belongs to T3, and this one
 * is Rennet's, whose only client is a harness child on this machine.
 */
export async function startAppMcpServer(options: StartAppMcpServerOptions): Promise<AppMcpServer> {
  const host = options.host ?? "127.0.0.1";
  let boundPort = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  const sendPlain = (
    res: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(body);
  };

  /** The thread id out of `/threads/<threadId>`, or undefined for any other path. */
  const threadIdOf = (url: string | undefined): string | undefined => {
    const path = (url ?? "").split("?")[0] ?? "";
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 2 || segments[0] !== "threads") return undefined;
    const id = segments[1];
    return id === undefined || id.length === 0 ? undefined : decodeURIComponent(id);
  };

  /**
   * The presented bearer, or `undefined`.
   *
   * The `.+` is LOAD-BEARING and is not ordinary parsing: it is what makes an EMPTY
   * presented bearer unrepresentable. Relax it to `.*` and `Authorization: Bearer ` with
   * nothing after it presents the empty string, which digests equal to the empty supplier
   * value the moment there is no sidecar — `sha256("") === sha256("")`, and the door is
   * open. Do not simplify this regex.
   */
  const bearerOf = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization;
    if (typeof header !== "string") return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1];
  };

  const readBody = async (req: IncomingMessage): Promise<string | null> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const toolFor = (name: unknown): AppTool | undefined =>
    typeof name !== "string"
      ? undefined
      : buildAppTools(options.dispatch()).find((tool) => tool.name === name);

  const callTool = async (
    threadId: string,
    params: unknown,
  ): Promise<{ readonly result?: unknown; readonly error?: { code: number; message: string } }> => {
    const record = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = toolFor(record.name);
    if (tool === undefined) {
      return {
        error: {
          code: JSON_RPC_INVALID_PARAMS,
          message:
            typeof record.name === "string"
              ? `this server has no \`${record.name}\``
              : "`tools/call` needs a tool `name`.",
        },
      };
    }
    const raw = (record.arguments ?? {}) as Record<string, unknown>;
    // The tool surface's own pagination, not the command's: taken off here so the command
    // never sees a field it does not declare.
    const cursor = typeof raw.cursor === "number" && Number.isInteger(raw.cursor) ? raw.cursor : 0;
    const { cursor: _cursor, ...rest } = raw;
    const args = stampedArguments({
      commandId: tool.commandId,
      args: rest,
      ...(options.sessionFor?.(threadId) === undefined
        ? {}
        : { sessionId: options.sessionFor(threadId) as string }),
    });
    try {
      const output = await tool.run(args, {
        // WHO called, from the address and never from the model's input.
        author: { kind: "orchestrator", id: threadId },
      });
      const shaped = shapeAppToolResult(tool.commandId, output, cursor);
      return {
        result: {
          content: [
            { type: "text", text: shaped.text },
            ...(shaped.marker === undefined ? [] : [{ type: "text", text: shaped.marker }]),
          ],
        },
      };
    } catch (error) {
      // A refusal is the model's to answer inside the same turn, so it comes back as a tool
      // result marked `isError`, never as a JSON-RPC error — a protocol error is the
      // client's problem and would not reach the thread as words it can act on.
      return {
        result: { content: [{ type: "text", text: refusalText(error) }], isError: true },
      };
    }
  };

  /** One JSON-RPC message. `null` means "a notification: answer 202 with no body". */
  const handleMessage = async (
    threadId: string,
    message: JsonRpcRequest,
  ): Promise<unknown | null> => {
    const { method, id } = message;
    const reply = (result: unknown): unknown => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string): unknown => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });

    if (typeof method !== "string") return fail(JSON_RPC_INVALID_PARAMS, "no method named");
    // A notification carries no id and gets no response, whatever it asks for.
    if (id === undefined || id === null) return null;

    switch (method) {
      case "initialize": {
        const asked = (message.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion;
        const version =
          typeof asked === "string" &&
          (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
            ? asked
            : LATEST_PROTOCOL_VERSION;
        return reply({
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: APP_MCP_SERVER_NAME, title: "Rennet", version: "1" },
          instructions:
            "Use Rennet through these tools: read the review's sessions, boards and patchset, and stage asks into the reviewer's composer. A result that was paged says so and names its cursor.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: servedAppToolCatalog(options.dispatch()) });
      case "tools/call": {
        const answered = await callTool(threadId, message.params);
        return answered.error === undefined
          ? reply(answered.result)
          : fail(answered.error.code, answered.error.message);
      }
      default:
        return fail(JSON_RPC_METHOD_NOT_FOUND, `this server has no \`${method}\``);
    }
  };

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      const threadId = threadIdOf(req.url);
      if (threadId === undefined) {
        sendPlain(res, 404, "not found");
        return;
      }
      const presented = bearerOf(req);
      // Read NOW, not at construction: the sidecar may have respawned under us with a fresh
      // bearer in a fresh environment (see the option's note).
      if (presented === undefined || !digestsMatch(sha256(presented), sha256(options.bearer()))) {
        sendPlain(res, 401, "unauthorized", {
          "www-authenticate": 'Bearer realm="rennet-app"',
        });
        return;
      }
      // The server→client stream. Nothing here pushes, so the transport's own answer for
      // "this server offers no stream" is the honest one.
      if (req.method === "GET") {
        sendPlain(res, 405, "method not allowed", { allow: "POST, DELETE" });
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST") {
        sendPlain(res, 405, "method not allowed", { allow: "POST, DELETE" });
        return;
      }

      const body = await readBody(req);
      if (body === null) {
        sendPlain(res, 413, "payload too large");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
        return;
      }
      // A batch is the 2025-03-26 shape; a single message is the newer one. Both arrive.
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const answers: unknown[] = [];
      for (const message of messages) {
        const answer = await handleMessage(threadId, (message ?? {}) as JsonRpcRequest);
        if (answer !== null) answers.push(answer);
      }
      if (answers.length === 0) {
        res.writeHead(202).end();
        return;
      }
      sendJson(res, 200, Array.isArray(parsed) ? answers : answers[0]);
    })().catch(() => {
      if (!res.headersSent) sendPlain(res, 500, "internal error");
      else res.end();
    });
  });

  const bindTo = async (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      httpServer.once("error", onError);
      httpServer.listen(port, host, () => {
        boundPort = (httpServer.address() as AddressInfo).port;
        httpServer.removeListener("error", onError);
        resolve();
      });
    });

  const wanted = options.port ?? rememberedPort(options.stateDir);
  if (wanted === undefined) {
    await bindTo(0);
  } else {
    try {
      await bindTo(wanted);
    } catch {
      // Something else took it while the daemon was down. An ephemeral port is the honest
      // fallback: a thread created against the old url has its next turn refused by name,
      // which is loud, where binding nothing would take the whole surface down for a port.
      await bindTo(0);
    }
  }
  rememberPort(options.stateDir, boundPort);

  return {
    port: boundPort,
    origin: `http://${host}:${boundPort}`,
    addressFor: (threadId) => ({
      name: APP_MCP_SERVER_NAME,
      url: `http://${host}:${boundPort}/threads/${encodeURIComponent(threadId)}`,
      bearerTokenEnvVar: APP_BEARER_ENV_VAR,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
        httpServer.closeAllConnections?.();
      }),
  };
}
