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
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { normalizeOutputSchema } from "@rennet/adapters";
import { type CommandName, commands } from "@rennet/protocol";
import { z } from "zod";
import { type AppTool, type AppToolDispatch, buildAppTools } from "../agent-tools";
import { writeRunScopedContext } from "../context-files";
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
 * and the marker names the cursor either way.
 *
 * 5 kB, and the number is chosen AGAINST {@link APP_TOOL_RESULT_MAX_BYTES} rather than for
 * its own sake. It used to be the evidence read's 16 kB, which is DOUBLE the universal
 * ceiling — so every page that actually filled its byte budget was immediately over the
 * ceiling and spilled to a file, and paging existed only to decide how much got written to
 * disk. A page has to be able to ride INLINE, which is the whole point of paging a
 * collection instead of spilling it: this leaves room for the JSON-RPC envelope, the
 * marker's own sentence and the escaping, with the head-room the ceiling's shrink loop needs
 * if a page does go over.
 */
export const PAGE_TOOL_BYTES_CAP = 5 * 1024;

/**
 * The universal ceiling on EVERY exposed command's complete serialised result (item 1, both
 * reviewers): only four commands declared a cap above, so every other command fell straight
 * through to a raw, unbounded `JSON.stringify(output)` — `ask.read` alone reproduced a
 * 144,611-byte result with 400 staged asks, and nothing here noticed. Now every result, paged
 * or not, answers to ONE ceiling after whatever per-command shaping already ran: under it, a
 * result rides inline exactly as before; over it, the complete result is written to a file
 * and the call gets back an honest envelope instead — never a silent truncation.
 */
export const APP_TOOL_RESULT_MAX_BYTES = 8_192;

/** How much of the oversized result's own text still rides inline, inside the envelope. */
const RESULT_HEAD_BYTES = 2_048;

/** Disambiguates two spill files minted in the same process within the same millisecond. */
let spillSeq = 0;

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
   * legitimately ask about another review (that is what `app_session_list` is for). This is
   * a REVIEW id, not a durable session id (`dispatch/chat.ts`'s `bindReviewThread` keys the
   * T3 thread binding on `{ kind: "session", sessionId: reviewId }`) — correct for this
   * stamp, and exactly why it must never be reused to decide where a spill lands (below).
   */
  readonly sessionFor?: (threadId: string) => string | undefined;
  /**
   * Where an oversized result spills, when the daemon can resolve one (item 1; corrected by
   * Codex's re-review, P2). Deliberately NOT keyed on the review id `sessionFor` returns:
   * that id is a review, and the durable session bound to a review is a DIFFERENT id
   * (`sessionIdForReview` in `create-server.ts`) — conflating the two sent a review `rev-1`
   * bound to session `s1`'s spills to the fallback tier, since `sessionStore.load("rev-1")`
   * never resolves, and archiving `s1` then left them behind forever. This resolves the
   * REAL owner in one step: the durable session id AND its bound workspace root together,
   * through the daemon's own review→session resolver, so the pair can never drift apart the
   * way two separately-resolved values could. Absent, or the thread's review or session
   * unresolved: the fallback tier is used instead, never a refusal.
   */
  readonly spillOwnerFor?: (
    threadId: string,
  ) => { readonly sessionId: string; readonly root: string } | undefined;
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
/** A malformed envelope: wrong/missing `jsonrpc`, no `method`, or an empty batch. */
export const JSON_RPC_INVALID_REQUEST = -32600;

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

/**
 * The largest index ≤ `end` that does not split a UTF-8 code point — back off while the
 * byte at the candidate boundary is a continuation byte (`10xxxxxx`, i.e.
 * `(byte & 0xC0) === 0x80`). No forward sequence-length arithmetic needed: walking backward
 * off any mid-sequence byte always lands on the sequence's leading byte or the position
 * right after the prior complete character.
 *
 * Fixes a real corruption (Codex P2, item 2): evidence paging split bytes before decoding,
 * so a page boundary landing inside a multibyte character (`'x'.repeat(16383) + '€after'`
 * cut mid-`€`) decoded BOTH sides to replacement characters — the model lost the character
 * entirely, on either page. Ending each page at a complete code point and reporting that
 * adjusted byte cursor keeps every character whole, on whichever page it falls in.
 */
function codePointFloor(buffer: Buffer, end: number): number {
  let index = end;
  while (index > 0 && ((buffer[index] ?? 0) & 0xc0) === 0x80) index -= 1;
  return index;
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
  const rawEnd = Math.min(start + EVIDENCE_TOOL_BYTES_CAP, buffer.length);
  // End at a complete code point, not a raw byte offset (item 2): a split multibyte
  // character decodes as replacement characters on both sides of the cut. `floored > start`
  // guards a pathological page whose whole budget lands inside one long code-point run —
  // unreachable for the byte-sized caps here, but a page of zero bytes would be a
  // collection the model can never advance past, which is worse than one split character.
  const floored = codePointFloor(buffer, rawEnd);
  const end = floored > start ? floored : rawEnd;
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

// ── The universal ceiling (item 1, both reviewers) ───────────────────────────────

/** `text` cut to at most `maxBytes`, ending at a complete UTF-8 code point (reuses item 2's). */
function headAtCodePointBoundary(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, codePointFloor(buffer, maxBytes)).toString("utf8");
}

/**
 * Where an oversized result's complete body is written, so the envelope can point at it.
 *
 * Two tiers, tried in order:
 *
 *   1. The thread's own session's context directory, `.rennet/context/<sessionId>/tool-
 *      results/`, via `writeRunScopedContext` — the same directory the rest of that
 *      session's turns already read files from, purged with it at archive. Used only when
 *      `spillOwnerFor` resolves a `{ sessionId, root }` pair for this call's thread — the
 *      DURABLE session id bound to the thread's review, never the review id itself (Codex
 *      P2; see {@link StartAppMcpServerOptions.spillOwnerFor}'s doc for why the two must
 *      not be conflated).
 *   2. `<stateDir>/tool-results/` (the sidecar's own base dir, or the OS temp dir when no
 *      `stateDir` was given — a test's ephemeral server, never the daemon). Nothing purges
 *      this tier per-session, which is why {@link sweepStaleAppToolResults} exists: swept by
 *      AGE at daemon start rather than at archive.
 */
function writeSpillFile(
  options: StartAppMcpServerOptions,
  threadId: string,
  toolName: string,
  body: string,
): string {
  spillSeq += 1;
  const name = `${toolName}-${Date.now()}-${spillSeq}.json`;
  const owner = options.spillOwnerFor?.(threadId);
  if (owner !== undefined) {
    const written = writeRunScopedContext(
      owner.root,
      owner.sessionId,
      `tool-results/${name}`,
      body,
    );
    // Relative, deliberately (Codex, second reviewer): a WSL-locus session stores its bound
    // root as a Windows-visible path (see create-server.ts's boundRootForSession / the
    // "review finding 4" comment near its spillOwnerFor wiring), while the harness agent
    // that later reads this path back runs inside the distro, with a distro-native cwd that
    // IS that same root. A relative path resolves under both; joining it onto `owner.root`
    // only resolves under the daemon's own view of the root, which the agent does not
    // share. `writeRunScopedContext` already returns relative for exactly this reason
    // (context-files.ts, tested at context-files.test.ts:469-470) — this tier just has to
    // stop discarding that by re-joining it back to absolute.
    return written.path;
  }
  const dir = join(options.stateDir ?? tmpdir(), "tool-results");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

/** The MCP `content` items a tool result carries: text blocks, in the wire's own order. */
type ToolContentBlock = { readonly type: "text"; readonly text: string };

/**
 * The COMPLETE `tools/call` result object the wire actually serialises — `content` (and
 * `isError` when the call failed) — never the bare inner text {@link applyResultCeiling}
 * used to measure before this fix (both reviewers' P1). JSON escaping (quotes, backslashes,
 * control bytes) and the `{"type":"text","text":...}` wrapper both add bytes a raw-text
 * measurement misses entirely: an 8,023 B quote-heavy inner payload serialised to 16,068 B
 * once wrapped, and a refusal carrying 2,000 NUL characters — each escaping to the six-byte
 * `\u0000` — serialised to 12,054 B with no ceiling in front of it at all.
 */
function toolResultOf(
  result: AppToolResult,
  isError: boolean,
): { readonly content: readonly ToolContentBlock[]; readonly isError?: true } {
  return {
    content: [
      { type: "text", text: result.text },
      ...(result.marker === undefined ? [] : [{ type: "text" as const, text: result.marker }]),
    ],
    ...(isError ? { isError: true as const } : {}),
  };
}

/**
 * The bytes actually on the wire for one `tools/call` reply: `{jsonrpc:"2.0", id, result}` —
 * the EXACT shape `handleMessage`'s own `reply()` builds — never the bare `result` object
 * alone (Codex, round 4). The `jsonrpc`/`id`/`result` keys and the request's own `id` are
 * overhead this function's earlier version never counted, and `id` is the caller's to pick:
 * a client that sends a large numeric id (this file's own probes used `9999999`) pushes the
 * REAL wire body a further 20-34 bytes past what a bare-`result` measurement saw, which is
 * exactly how a ceiling that measured only `{content, isError?}` still let the complete HTTP
 * body land at 8,212-8,226 B against an 8,192 B budget. Measuring the reply shape itself,
 * every time, is what keeps this function and `reply()` from drifting apart again.
 */
function wireBytes(requestId: unknown, result: unknown): number {
  return utf8(JSON.stringify({ jsonrpc: "2.0", id: requestId, result }));
}

/**
 * The universal ceiling: whatever `shapeAppToolResult` (or any other per-command shaping,
 * or a dispatch refusal) produced, this is the LAST word on whether it rides inline —
 * measured on the COMPLETE JSON-RPC reply body the wire sends, `{jsonrpc, id, result}`, not
 * the bare result object and not the inner text (both reviewers' P1; the envelope-vs-result
 * distinction is round 4's own finding, above). A success and a refusal take the EXACT same
 * path through here: `isError` only changes one field of the wrapper this function builds,
 * never whether the ceiling applies — a refusal that blows the budget spills exactly like an
 * oversized success would.
 *
 * Only four commands declared their own cap before item 1 — every other exposed command's
 * complete serialised result went straight to the model, unbounded (`ask.read` alone
 * reproduced 144,611 bytes with 400 staged asks). So this runs on EVERY result: under
 * {@link APP_TOOL_RESULT_MAX_BYTES}, the wrapped result is returned unchanged; over it,
 * `spill` is handed the complete text-plus-marker body to write wherever it decides (the two
 * tiers above), and the call gets back a small envelope naming where the rest is and
 * carrying a head-sized sample inline — but the REPLACEMENT envelope is itself measured the
 * same way, because escaping the sample can inflate it too, and so is the `id` this call
 * arrived on: `head` shrinks at a UTF-8 code-point boundary, one measured iteration at a
 * time, until the whole wire body — envelope AND `{jsonrpc, id, result}` wrapper together —
 * fits, never computed from the raw byte count alone.
 */
export function applyResultCeiling(
  result: AppToolResult,
  spill: (body: string) => string,
  requestId: unknown,
  isError = false,
): { readonly content: readonly ToolContentBlock[]; readonly isError?: true } {
  const full = toolResultOf(result, isError);
  const fullBytes = wireBytes(requestId, full);
  if (fullBytes <= APP_TOOL_RESULT_MAX_BYTES) return full;

  const body = result.marker === undefined ? result.text : `${result.text}\n\n${result.marker}`;
  const bytes = utf8(body);
  const path = spill(body);
  // Tier 1 (`spillOwnerFor` resolved) returns a path RELATIVE to the thread's own
  // cwd, which IS the bound root, deliberately (see writeSpillFile's doc): the note
  // has to say so, since "read the path above" is only true as written for tier
  // 2's absolute sidecar fallback.
  const pathIsAbsolute = isAbsolute(path);

  // Shrink `head` until the REPLACEMENT envelope's own complete serialisation fits too:
  // escaping (quotes, backslashes, control bytes) can expand a raw byte up to sixfold
  // (`\u0000`), so this is MEASURED on the wrapped wire object every pass, never computed
  // analytically from the raw head length.
  const locationNote = pathIsAbsolute
    ? "it was written whole to the path above"
    : "it was written whole to the path above, relative to your working directory";
  let headBytes = RESULT_HEAD_BYTES;
  for (;;) {
    const head = headAtCodePointBoundary(result.text, headBytes);
    const envelope = {
      truncated: true,
      bytes,
      path,
      head,
      // The PAGING CURSOR, when the per-command shaping produced one. It was folded into
      // the spilled FILE and dropped from the reply, so a thread whose board page both
      // paged and spilled was told where the bytes are and NOT how to ask for the next
      // page — and the only way back was to guess a cursor. The shrink loop below
      // re-measures the whole wrapped body on every pass, so carrying it here cannot push
      // the envelope over: it costs `head` bytes, which is what `head` is for.
      ...(result.marker === undefined ? {} : { marker: result.marker }),
      note: `The complete ${bytes}-byte result did not fit this call's ${APP_TOOL_RESULT_MAX_BYTES}-byte budget, so ${locationNote}; read it with your own tools for the rest. \`head\` is this result's own first bytes, not a separate summary.`,
    };
    const candidate = toolResultOf({ text: JSON.stringify(envelope) }, isError);
    const candidateBytes = wireBytes(requestId, candidate);
    if (candidateBytes <= APP_TOOL_RESULT_MAX_BYTES || headBytes === 0) return candidate;
    // Escaping only ever ADDS bytes, so trimming the overage straight off the raw head byte
    // count is always enough progress to terminate — never less, occasionally more, and a
    // second pass at a smaller `head` costs nothing here.
    headBytes = Math.max(0, headBytes - (candidateBytes - APP_TOOL_RESULT_MAX_BYTES));
  }
}

/**
 * The daemon-start sweep for the FALLBACK spill tier (item 1): a result that spilled before
 * a session had resolved for its thread lands under the sidecar's base dir, outside every
 * root the session-context purge covers, so nothing else ever reclaims it. Age-based, not
 * incarnation-stamped, because a fallback spill carries no session id to check a store
 * against — swept only when it is older than `maxAgeMs`, never by a liveness check.
 *
 * Returns how many files were removed. Never throws: an absent or unreadable directory is
 * the ordinary case (no fallback spill ever happened) and not this sweep's problem.
 */
export function sweepStaleAppToolResults(
  stateDir: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): number {
  const dir = join(stateDir, "tool-results");
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      // Already gone, or unreadable — not this sweep's problem.
    }
  }
  return removed;
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
    // The request's own JSON-RPC `id`, threaded all the way to `applyResultCeiling` (round
    // 4): the wire body this call answers is `{jsonrpc, id, result}`, not the bare `result`,
    // and `id` is the CALLER's to pick — a large numeric one is real overhead the ceiling
    // has to count. `handleMessage` already refused a notification (no id) before this is
    // ever reached, so a real id is always in hand here.
    requestId: unknown,
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
    const rest: Record<string, unknown> = { ...raw };
    delete rest.cursor;
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
      // The universal ceiling (item 1) measured on the COMPLETE serialised `tools/call`
      // result (both reviewers' P1), not the inner text: whatever shape the command's own
      // paging gave this result, it still answers to ONE byte budget as it will actually
      // ride the wire. Under the budget, the wrapped result rides inline unchanged; over
      // it, `applyResultCeiling` returns a small spill envelope and the marker (if any) is
      // folded into the spilled file, not carried separately.
      return {
        result: applyResultCeiling(
          shaped,
          (body) => writeSpillFile(options, threadId, tool.name, body),
          requestId,
        ),
      };
    } catch (error) {
      // A refusal is the model's to answer inside the same turn, so it comes back as a tool
      // result marked `isError`, never as a JSON-RPC error — a protocol error is the
      // client's problem and would not reach the thread as words it can act on. It takes the
      // SAME ceiling as a success (both reviewers' P1): `refusalText`'s own cap holds an
      // ordinary refusal well under budget, but a pathological one (control characters that
      // each escape to several bytes) can still blow it once wrapped, so this spills exactly
      // like an oversized success would rather than riding the wire unbounded.
      return {
        result: applyResultCeiling(
          { text: refusalText(error) },
          (body) => writeSpillFile(options, threadId, tool.name, body),
          requestId,
          true,
        ),
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

    // Envelope validation BEFORE the notification check (item 3, Codex P2): a malformed
    // request answers `-32600`/`id: null` per the JSON-RPC 2.0 spec's own canonical shape
    // for an invalid request, rather than being read as a notification (silently answered
    // with nothing) or refused as `-32602` with whatever `id` it happened to carry. Both
    // `{}` (no `method`, no `jsonrpc`) and `{"jsonrpc":"1.0", ...}` are invalid this way.
    if (message.jsonrpc !== "2.0" || typeof method !== "string") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: "invalid request" },
      };
    }
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
        const answered = await callTool(threadId, message.params, id);
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
      // An empty batch is itself an Invalid Request (item 3, Codex P2) — it carried no
      // message to notify or reply to, so answering `202` as if a lone notification had
      // been served would be silently wrong rather than silently right.
      if (Array.isArray(parsed) && parsed.length === 0) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: JSON_RPC_INVALID_REQUEST, message: "empty batch" },
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
