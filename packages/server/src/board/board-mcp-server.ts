// The daemon's loopback MCP board server (`lens-board-tools` D8, tasks 2.5/2.6).
//
// A lens seat writes its board by CALLING TOOLS, and this is where those calls land: one
// HTTP MCP listener the daemon owns, bound to `127.0.0.1`, with one address per seat.
// `board-writer.ts` in `@rennet/core` is what a call actually does; this module is the
// wire, the addressing and the lifetime.
//
// ── Addressing, NOT authorization (D8, Rule Zero) ────────────────────────────────
// A seat's address names the board its calls write, exactly as a file handle names a
// file. Nothing here withholds a capability from a seat, and nothing here is a consent
// step. Two seats of a Flagged lane get two addresses onto ONE board because that is
// what a lane is, not because either is being kept out of the other's.
//
// ── The two halves of a seat's credential, and why they are two ──────────────────
// Both providers fix a session's MCP configuration when the harness child is created,
// and the caller-supplied credential travels as an ENVIRONMENT VARIABLE NAME, never as a
// value (`docs/developing/concepts/t3code-sidecar.md`). The variable is read out of the
// harness child's environment, which it inherits from the sidecar, which the daemon
// spawned — so a variable's VALUE is fixed for the sidecar's life and cannot be minted
// per seat. That is a fact about the seam, not a choice made here. So:
//
//   • the SEAT TOKEN is per seat — 32 random bytes, only its SHA-256 stored, liveness
//     refreshed on every turn, revoked the moment its lane settles — and it travels in
//     the address path, which is on the harness child's argument list;
//   • the PROCESS BEARER is the sidecar's — minted when the daemon spawns the sidecar,
//     placed in its environment under {@link BOARD_BEARER_ENV_VAR}, and on NO argument
//     list, because only the variable's name is ever serialised.
//
// Both are required on every call. So `ps` yields an address and not access, which is
// the property task 2.5's third control is about; and a lane that settles stops its
// seats writing at once, which is what the per-seat half is for.
//
// PONYTAIL: when the vendored seam can carry a per-turn credential VALUE into the child
// environment (`CodexAdapter` already does exactly this for T3's own server), the seat
// token moves into the `Authorization` header and the address becomes a plain seat id.
// Nothing outside this module and the sidecar spawn would change.
//
// ── The protocol ────────────────────────────────────────────────────────────────
// MCP over Streamable HTTP, hand-rolled: `initialize`, `notifications/initialized`,
// `tools/list`, `tools/call`, `ping`. Requests are answered as `application/json`, which
// the transport permits in place of an SSE stream, and no `Mcp-Session-Id` is issued —
// session management is optional and the address already identifies the seat. `GET`
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
import {
  type BoardToolOutcome,
  type BoardVoice,
  type BoardVoiceWriter,
  BoardWriter,
  type LintContext,
  type LintTarget,
} from "@rennet/core";
import {
  type Author,
  type BoardTarget,
  boardToolsByName,
  type DraftBoard,
  type DraftKind,
} from "@rennet/protocol";
import { z } from "zod";
import { BOARD_BEARER_ENV_VAR, BOARD_MCP_SERVER_NAME, deriveSeatToken } from "./board-credentials";

export { BOARD_BEARER_ENV_VAR, BOARD_MCP_SERVER_NAME } from "./board-credentials";

/** The MCP protocol revisions this server answers. The newest is what an unknown one gets. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** How long a seat's address stays live without a turn refreshing it. */
export const SEAT_LIVENESS_MS = 30 * 60_000;

/** Body cap for one JSON-RPC message. A board call is small; anything near this is a bug. */
const MAX_BODY_BYTES = 1_000_000;

/** How many `finish` pointers one tool result carries before it says how many more there are. */
const POINTER_SAMPLE = 20;

/** What a turn names so its harness child can reach one seat's board. */
export interface SeatBoardServer {
  readonly name: string;
  readonly url: string;
  readonly bearerTokenEnvVar: string;
}

/** The voice one seat writes a lane's board with. */
export interface BoardSeatVoice {
  /** The seat kind, as the thread binding names it (`design`, `flagged-codex`, …). */
  readonly seat: string;
  readonly author: Author;
  /** Prefixes the ids this seat is handed, so a Flagged element says which voice wrote it. */
  readonly idPrefix?: string;
}

/** One lane's board, and the addresses onto it. */
export interface BoardLane {
  readonly generationId: string;
  readonly target: LintTarget;
  /**
   * This seat's address. Minted on the first call and STABLE afterwards: both providers
   * fix the session's MCP configuration on the thread's first turn, and a later turn
   * naming a different url is refused by the adapter as a mismatch. A repeat call
   * refreshes the seat's liveness instead of minting again.
   */
  readonly address: (voice: BoardSeatVoice) => SeatBoardServer;
  /** The board as it stands, whichever voice wrote each element. */
  readonly board: () => DraftBoard;
  /** The writer this lane's seats share — one board, however many voices. */
  readonly writer: () => BoardWriter;
  /** This seat's handle on the shared board, for a caller that is not going through HTTP. */
  readonly seatWriter: (seat: string) => BoardVoiceWriter | undefined;
  /** Revoke every address of this lane. Eager: a settled lane's seats stop writing now. */
  readonly settle: () => void;
}

export interface OpenLaneInput {
  readonly generationId: string;
  readonly target: LintTarget;
  /** The patchset knowledge every boundary rule reads, WITHOUT its lens (the target is). */
  readonly lint: Omit<LintContext, "lens">;
  /** The lane's author when a seat has not named its own voice. */
  readonly author?: Author;
  readonly typedKinds?: Readonly<Record<BoardTarget, readonly DraftKind[]>>;
}

export interface BoardMcpServer {
  readonly port: number;
  readonly origin: string;
  /** Open (or return) the lane for one board of one generation. */
  readonly openLane: (input: OpenLaneInput) => BoardLane;
  readonly lane: (generationId: string, target: LintTarget) => BoardLane | undefined;
  /** The seat's server descriptor, when its lane is open and it has an address. */
  readonly seatServer: (generationId: string, seat: string) => SeatBoardServer | undefined;
  /** Every lane of a generation, settled at once — what an abandoned generation gets. */
  readonly settleGeneration: (generationId: string) => void;
  readonly close: () => Promise<void>;
}

/** One live address: a seat, its board, its voice, and how long it stays live. */
interface SeatEntry {
  readonly generationId: string;
  readonly target: LintTarget;
  readonly seat: string;
  readonly voice: BoardVoice;
  readonly writer: BoardWriter;
  readonly server: SeatBoardServer;
  expiresAt: number;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Constant-time equality over two digests of the same length. */
function digestsMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const laneKey = (generationId: string, target: LintTarget): string => `${generationId} ${target}`;
const seatKey = (generationId: string, seat: string): string => `${generationId} ${seat}`;

/**
 * What a successful call says back, in one short line.
 *
 * A tool result is a model-facing string and is billed like any other, so it says the one
 * thing the seat cannot work out for itself — the id it was handed, or the pointers it
 * has left — and nothing else. The reader-facing receipt is a different surface (D11,
 * task 4.2); this is not it.
 */
export function describeOutcome(outcome: BoardToolOutcome): string {
  switch (outcome.kind) {
    case "element":
      return outcome.id;
    case "removed":
      return `removed ${outcome.ids.join(", ")}`;
    case "document":
      return "document set";
    case "absent":
      return `settled absent (${outcome.reason})`;
    case "settled":
      return "board settled";
    case "pointers": {
      const shown = outcome.pointers
        .slice(0, POINTER_SAMPLE)
        .map((pointer) => `${pointer.elementRef} (${pointer.ruleId}): ${pointer.message}`);
      const more = outcome.pointers.length - shown.length;
      return [
        `not settled — ${outcome.pointers.length} to fix, then call finish again:`,
        ...shown,
        ...(more > 0 ? [`… and ${more} more`] : []),
      ].join("\n");
    }
  }
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The tools this seat may call, in the MCP `tools/list` shape.
 *
 * `normalizeOutputSchema` is what drops the top-level `$schema`/`$id` Zod stamps, and it
 * is the SAME choke point Rennet's own adapter routes every provider-bound schema
 * through. It matters more here, not less: an `inputSchema` is carried by the harness
 * child into the provider's tool definitions with nothing on that path to strip it, and
 * a meta declaration a validator does not recognise is what #810 was — a schema refused
 * before the turn ran. It is also 57 bytes per tool of overhead no reader and no model
 * ever sees. The schema BODY is untouched.
 */
export function servedToolCatalog(
  target: LintTarget,
  typedKinds?: OpenLaneInput["typedKinds"],
): { readonly name: string; readonly description: string; readonly inputSchema: unknown }[] {
  const tools = boardToolsByName(target, typedKinds);
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: normalizeOutputSchema(z.toJSONSchema(tool.input, { io: "input" })),
  }));
}

function toolCatalogFor(entry: SeatEntry, typedKinds?: OpenLaneInput["typedKinds"]): unknown[] {
  return servedToolCatalog(entry.target, typedKinds);
}

export interface StartBoardMcpServerOptions {
  /**
   * The process bearer every call must carry, READ ON EVERY CALL: the value that is in
   * the sidecar's environment under {@link BOARD_BEARER_ENV_VAR} right now.
   *
   * A supplier and not a value, because the sidecar RESPAWNS within one daemon's life —
   * the supervisor clears its handle when the child exits and the next `ensure()` spawns
   * a fresh one — and every spawn puts a fresh bearer in a fresh environment. A listener
   * holding the first sidecar's bearer would 401 every seat of every later one, silently
   * and for the daemon's whole life: seats would run, bill the user's subscription and
   * write nothing. Only the digest of whatever this returns is ever compared.
   */
  readonly bearer: () => string;
  /** The interface to bind. Loopback, and there is no option that is not. */
  readonly host?: "127.0.0.1" | "::1";
  /**
   * Where the port this listener bound is remembered, so a restarted daemon comes back on
   * the SAME port and a seat's url is the url its session was opened with. The sidecar's
   * private base dir; absent ⇒ nothing is remembered and an ephemeral port is bound, which
   * is what a test wants.
   */
  readonly stateDir?: string;
  /** Bind exactly this port. Overrides whatever {@link StartBoardMcpServerOptions.stateDir} remembers. */
  readonly port?: number;
  readonly now?: () => number;
  readonly livenessMs?: number;
}

/** Where the bound port is remembered between daemon runs. Not a secret; a port. */
const PORT_RECORD = "board-server.json";

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

/**
 * Start the loopback board server. Resolves once it is listening.
 *
 * Its own listener, deliberately: the sidecar's `/mcp` sits outside T3's environment auth
 * stack and belongs to T3, and this one is Rennet's, whose only client is a harness child
 * on this machine.
 */
export async function startBoardMcpServer(
  options: StartBoardMcpServerOptions,
): Promise<BoardMcpServer> {
  const host = options.host ?? "127.0.0.1";
  const now = options.now ?? Date.now;
  const livenessMs = options.livenessMs ?? SEAT_LIVENESS_MS;

  const lanes = new Map<
    string,
    { readonly writer: BoardWriter; readonly input: OpenLaneInput; readonly seats: Set<string> }
  >();
  /** SHA-256 of the seat token → the seat it addresses. The token itself is never stored. */
  const bySeatTokenDigest = new Map<string, SeatEntry>();
  /** (generation, seat) → its token digest, so a repeat `address` refreshes rather than mints. */
  const digestBySeat = new Map<string, string>();

  let boundPort = 0;

  const entryFor = (generationId: string, seat: string): SeatEntry | undefined => {
    const digest = digestBySeat.get(seatKey(generationId, seat));
    return digest === undefined ? undefined : bySeatTokenDigest.get(digest);
  };

  const revokeSeat = (generationId: string, seat: string): void => {
    const key = seatKey(generationId, seat);
    const digest = digestBySeat.get(key);
    if (digest === undefined) return;
    digestBySeat.delete(key);
    bySeatTokenDigest.delete(digest);
  };

  const makeLane = (key: string): BoardLane => {
    const held = lanes.get(key);
    if (held === undefined) throw new Error(`board server: no lane at ${key}`);
    const { writer, input, seats } = held;
    return {
      generationId: input.generationId,
      target: input.target,
      address: (voice) => {
        const existing = entryFor(input.generationId, voice.seat);
        if (existing !== undefined) {
          existing.expiresAt = now() + livenessMs;
          return existing.server;
        }
        // Derived from the sidecar's own bearer over (generation, board, seat), so this
        // seat's url is the same url after a daemon restart and after a settled lane is
        // re-opened for a retry — both of which a random token loses, and both of which
        // the provider then refuses as an MCP-server mismatch. Only the digest is kept
        // here; see `deriveSeatToken` for why this is not weaker than minting.
        const token = deriveSeatToken({
          bearer: options.bearer(),
          generationId: input.generationId,
          target: input.target,
          seat: voice.seat,
        });
        const server: SeatBoardServer = {
          name: BOARD_MCP_SERVER_NAME,
          url: `http://${host}:${boundPort}/board/${token}`,
          bearerTokenEnvVar: BOARD_BEARER_ENV_VAR,
        };
        const entry: SeatEntry = {
          generationId: input.generationId,
          target: input.target,
          seat: voice.seat,
          voice: {
            author: voice.author,
            ...(voice.idPrefix === undefined ? {} : { idPrefix: voice.idPrefix }),
          },
          writer,
          server,
          expiresAt: now() + livenessMs,
        };
        const digest = sha256(token).toString("hex");
        bySeatTokenDigest.set(digest, entry);
        digestBySeat.set(seatKey(input.generationId, voice.seat), digest);
        seats.add(voice.seat);
        return server;
      },
      board: () => writer.board(),
      writer: () => writer,
      seatWriter: (seat) => {
        const entry = entryFor(input.generationId, seat);
        return entry === undefined ? undefined : writer.voice(entry.voice);
      },
      settle: () => {
        for (const seat of seats) revokeSeat(input.generationId, seat);
        seats.clear();
      },
    };
  };

  const openLane = (input: OpenLaneInput): BoardLane => {
    const key = laneKey(input.generationId, input.target);
    if (!lanes.has(key)) {
      lanes.set(key, {
        writer: new BoardWriter({
          target: input.target,
          lint: input.lint,
          author: input.author ?? { kind: "lens-agent", id: `lens:${input.target}` },
          ...(input.typedKinds === undefined ? {} : { typedKinds: input.typedKinds }),
        }),
        input,
        seats: new Set<string>(),
      });
    }
    return makeLane(key);
  };

  // ── The wire ───────────────────────────────────────────────────────────────

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

  /** The seat token out of `/board/<token>`, or undefined for any other path. */
  const seatTokenOf = (url: string | undefined): string | undefined => {
    const path = (url ?? "").split("?")[0] ?? "";
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 2 || segments[0] !== "board") return undefined;
    const token = segments[1];
    return token === undefined || token.length === 0 ? undefined : decodeURIComponent(token);
  };

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

  const callTool = (entry: SeatEntry, params: unknown): unknown => {
    const record = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof record.name !== "string") {
      return {
        error: {
          code: JSON_RPC_INVALID_PARAMS,
          message: "`tools/call` needs a tool `name`.",
        },
      };
    }
    const result = entry.writer.call(record.name, record.arguments, entry.voice);
    // A refusal is the model's to answer inside the same turn (D6), so it comes back as a
    // tool result marked `isError`, never as a JSON-RPC error — a protocol error is the
    // client's problem and would not reach the seat as words it can act on.
    return {
      result: result.ok
        ? { content: [{ type: "text", text: describeOutcome(result.outcome) }] }
        : { content: [{ type: "text", text: result.refusal }], isError: true },
    };
  };

  /** One JSON-RPC message. `null` means "a notification: answer 202 with no body". */
  const handleMessage = (entry: SeatEntry, message: JsonRpcRequest): unknown | null => {
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
          serverInfo: {
            name: BOARD_MCP_SERVER_NAME,
            title: `Rennet ${entry.target} board`,
            version: "1",
          },
          instructions: `Write the ${entry.target} board of this review with these tools. Every id you use is one an earlier call returned.`,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: toolCatalogFor(
            entry,
            lanes.get(laneKey(entry.generationId, entry.target))?.input.typedKinds,
          ),
        });
      case "tools/call": {
        const answered = callTool(entry, message.params) as {
          result?: unknown;
          error?: { code: number; message: string };
        };
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
      const token = seatTokenOf(req.url);
      if (token === undefined) {
        sendPlain(res, 404, "not found");
        return;
      }
      // The process bearer first: a caller with the right address and the wrong bearer has
      // no more standing than one with neither.
      const presented = bearerOf(req);
      // Read NOW, not at construction: the sidecar may have respawned under us with a
      // fresh bearer in a fresh environment (see the option's note).
      if (presented === undefined || !digestsMatch(sha256(presented), sha256(options.bearer()))) {
        sendPlain(res, 401, "unauthorized", {
          "www-authenticate": 'Bearer realm="rennet-board"',
        });
        return;
      }
      const entry = bySeatTokenDigest.get(sha256(token).toString("hex"));
      // Revoked, or never minted. There is no board at this address, and saying which of
      // the two it is would say something about a lane the caller cannot address.
      if (entry === undefined) {
        sendPlain(res, 404, "no board at this address");
        return;
      }
      if (entry.expiresAt <= now()) {
        sendPlain(res, 401, "this seat address is stale", {
          "www-authenticate": 'Bearer realm="rennet-board", error="invalid_token"',
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
      const answers = messages
        .map((message) => handleMessage(entry, (message ?? {}) as JsonRpcRequest))
        .filter((answer): answer is unknown => answer !== null);
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
      // fallback: the seats of a generation that was mid-flight get new urls and their
      // next turn is refused by name, which is loud, where binding nothing would take the
      // whole feature down for a port number.
      await bindTo(0);
    }
  }
  rememberPort(options.stateDir, boundPort);

  return {
    port: boundPort,
    origin: `http://${host}:${boundPort}`,
    openLane,
    lane: (generationId, target) => {
      const key = laneKey(generationId, target);
      return lanes.has(key) ? makeLane(key) : undefined;
    },
    seatServer: (generationId, seat) => entryFor(generationId, seat)?.server,
    settleGeneration: (generationId) => {
      for (const [key, held] of lanes) {
        if (held.input.generationId !== generationId) continue;
        for (const seat of held.seats) revokeSeat(generationId, seat);
        held.seats.clear();
        lanes.delete(key);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        bySeatTokenDigest.clear();
        digestBySeat.clear();
        lanes.clear();
        httpServer.close(() => {
          resolve();
        });
        httpServer.closeAllConnections?.();
      }),
  };
}

/**
 * One generation's board lanes: what the drafting pipeline opens, and what a seat's
 * address is looked up on.
 *
 * The listener is started on the first `openLane` and not before, so a daemon that never
 * drafts a board binds no port.
 */
export interface GenerationBoards {
  /** Open (or return) this generation's lane for one board. */
  readonly openLane: (input: Omit<OpenLaneInput, "generationId">) => Promise<BoardLane>;
  readonly lane: (target: LintTarget) => BoardLane | undefined;
  /** Settle one lane: every address onto its board stops working at once. */
  readonly settleLane: (target: LintTarget) => void;
  /** Settle every lane of this generation — what an abandoned generation gets. */
  readonly settleAll: () => void;
}

/** Bind {@link GenerationBoards} to one generation over a lazily started server. */
export function generationBoards(
  generationId: string,
  ensure: () => Promise<BoardMcpServer>,
): GenerationBoards {
  let server: BoardMcpServer | undefined;
  return {
    openLane: async (input) => {
      server ??= await ensure();
      return server.openLane({ ...input, generationId });
    },
    lane: (target) => server?.lane(generationId, target),
    settleLane: (target) => {
      server?.lane(generationId, target)?.settle();
    },
    settleAll: () => {
      server?.settleGeneration(generationId);
    },
  };
}
