import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardWrite, ChangedRegion, LintContext } from "@rennet/core";
import { BOARD_TARGETS } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_BEARER_ENV_VAR,
  BOARD_MCP_SERVER_NAME,
  type BoardMcpServer,
  type SeatBoardServer,
  startBoardMcpServer,
} from "./board-mcp-server";

/**
 * The daemon's loopback MCP board server (2.5/2.6).
 *
 * Every claim here is made over the REAL WIRE: an HTTP client speaking the MCP
 * Streamable-HTTP handshake against a listener bound to `127.0.0.1`, never by calling the
 * handler functions directly. That is deliberate — the thing being proved is that a
 * harness child's MCP client can discover and call these tools, and a direct call would
 * prove only that the writer works, which `board-writer.test.ts` already proves.
 *
 * What it still cannot catch: no real `claude` or `codex` child is driven here, so the
 * final hop — the provider's own MCP client against this listener — is covered by the
 * vendored adapters' tests (2.2) and by the drive in task 7.1, not by this file.
 */

/**
 * Deliberately full of characters `encodeURIComponent` changes (space, `/`, `+`, `=`), so
 * the percent-encoded assertion below is a DIFFERENT assertion from the plain one. With a
 * bearer of `[A-Za-z-]` the two were byte-identical and the second could not fail — the
 * `toContain("--draft")` pattern, and its comment called it the one that mattered.
 */
const BEARER = "process bearer/under+test=";

/** The bearer the listener reads on every call, so a test can respawn the sidecar under it. */
let currentBearer = BEARER;

const REGIONS: ChangedRegion[] = [
  { path: "src/auth.ts", side: "head", start: 10, end: 14 },
  { path: "src/util.ts", side: "head", start: 1, end: 3 },
];

const lint = (): Omit<LintContext, "lens"> => ({
  regions: REGIONS,
  files: new Map([
    ["src/auth.ts", 200],
    ["src/util.ts", 50],
  ]),
  baseFiles: new Map([["src/auth.ts", 190]]),
});

let started: BoardMcpServer[] = [];
/** Temp dirs a port-record test made; removed with the listeners that wrote them. */
let scratch: string[] = [];

afterEach(async () => {
  const running = started;
  started = [];
  currentBearer = BEARER;
  for (const server of running) await server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

async function serverWith(
  options: Partial<Parameters<typeof startBoardMcpServer>[0]> = {},
): Promise<BoardMcpServer> {
  const server = await startBoardMcpServer({ bearer: () => currentBearer, ...options });
  started.push(server);
  return server;
}

interface RpcAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** One JSON-RPC POST, exactly as an MCP Streamable-HTTP client sends it. */
async function rpc(
  url: string,
  message: unknown,
  init: { readonly bearer?: string | null } = {},
): Promise<RpcAnswer> {
  const bearer = init.bearer === undefined ? currentBearer : init.bearer;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  const json = response.headers.get("content-type")?.startsWith("application/json") === true;
  return {
    status: response.status,
    // A refusal answers in plain text, so the body is only parsed when the server said it
    // was JSON — parsing everything would turn a 401 into a syntax error and hide it.
    body: json && text.length > 0 ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

const result = (answer: RpcAnswer): Record<string, unknown> => {
  const body = answer.body as { result?: unknown; error?: { message?: string } };
  if (body?.result === undefined) {
    throw new Error(`expected a JSON-RPC result, got ${JSON.stringify(answer.body)}`);
  }
  return body.result as Record<string, unknown>;
};

/** The one text block a board tool result carries. */
const textOf = (answer: RpcAnswer): string => {
  const content = result(answer).content as { type: string; text: string }[];
  return content.map((block) => block.text).join("\n");
};

const isError = (answer: RpcAnswer): boolean => result(answer).isError === true;

/** The full handshake a client performs before it may call anything. */
async function handshake(url: string): Promise<RpcAnswer> {
  const initialized = await rpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1" },
    },
  });
  await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" });
  return initialized;
}

/** Unwrap an address that must exist, so a lane that refuses to mint one fails loudly here. */
function addressOf(server: SeatBoardServer | undefined): SeatBoardServer {
  if (server === undefined) throw new Error("expected this seat to be given an address");
  return server;
}

const designLane = async (server: BoardMcpServer) =>
  server.openLane({ generationId: "gen-1", target: "design", lint: lint() });

const designAddress = (lane: Awaited<ReturnType<typeof designLane>>) =>
  addressOf(
    lane.address({
      seat: "design",
      author: { kind: "lens-agent", id: "lens:design" },
      idPrefix: "d",
    }),
  );

// ── 2.5 The protocol, over the wire ──────────────────────────────────────────

describe("a seat's MCP client discovers and calls the board tools (2.5)", () => {
  it("initialize answers with the client's protocol revision and a tools capability", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    const initialized = await handshake(url);
    expect(initialized.status).toBe(200);
    expect(result(initialized).protocolVersion).toBe("2025-06-18");
    expect(result(initialized).capabilities).toMatchObject({ tools: {} });
  });

  it("a protocol revision this server does not know is answered with the one it speaks", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    const answer = await rpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01", capabilities: {} },
    });
    expect(result(answer).protocolVersion).toBe("2025-06-18");
  });

  it("a notification is answered 202 with no body, as the transport requires", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    const answer = await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(answer.status).toBe(202);
    expect(answer.body).toBeUndefined();
  });

  it("tools/list serves this lens's derived tool set, each input a flat object", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    await handshake(url);
    const listed = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = result(listed).tools as { name: string; inputSchema: { type?: string } }[];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("add_section");
    expect(names).toContain("add_requirement");
    expect(names).toContain("settle_absent");
    expect(names).toContain("finish");
    // Design authors no step; the surface is derived from the kind tables, so it has no
    // step verb rather than refusing one after the fact.
    expect(names).not.toContain("add_step");
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
  });

  it("serves no meta declaration on any tool of ANY target's input schema", async () => {
    // EVERY target, over the wire. A one-target sample was the first version and it was a
    // gap, not a shorthand: `servedToolCatalog` takes the target as a parameter, so
    // stripping everywhere except `sequence` left the whole suite green (control M20).
    const server = await serverWith();
    let seen = 0;
    for (const target of BOARD_TARGETS) {
      const lane = server.openLane({ generationId: "gen-meta", target, lint: lint() });
      const url = addressOf(
        lane.address({ seat: target, author: { kind: "lens-agent", id: `lens:${target}` } }),
      ).url;
      await handshake(url);
      const listed = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = result(listed).tools as {
        name: string;
        inputSchema: Record<string, unknown>;
      }[];
      expect(tools.length, target).toBeGreaterThan(0);
      for (const tool of tools) {
        // Zod stamps a draft-2020-12 `$schema` on every rendered input, and this
        // `inputSchema` is carried by the harness child into the provider's own tool
        // definitions with nothing on that path to strip it. A meta declaration a
        // validator does not recognise is what #810 was — a schema refused before the turn
        // ran — and Rennet's own adapter drops these keys for exactly that reason.
        expect(Object.keys(tool.inputSchema), `${target}/${tool.name}`).not.toContain("$schema");
        expect(Object.keys(tool.inputSchema), `${target}/${tool.name}`).not.toContain("$id");
        seen += 1;
      }
      // …and the body is untouched: the constraints still travel.
      const cite = tools.find((tool) => tool.name === "cite");
      expect(Object.keys((cite?.inputSchema.properties ?? {}) as object), target).toContain(
        "start_line",
      );
    }
    // A count, so a loop that silently stopped iterating cannot pass as a clean sweep.
    // 94, not 96: the Noise seat lost two verbs when its membership became the host's
    // derivation (D16) — no verb creates a member, and none settles the absence the host
    // decides from an empty complement.
    expect(seen).toBe(100);
  });

  it("a Sequence seat is served no settle_absent, because Sequence admits no absence", async () => {
    const server = await serverWith();
    const lane = server.openLane({ generationId: "gen-1", target: "sequence", lint: lint() });
    const url = addressOf(
      lane.address({ seat: "sequence", author: { kind: "lens-agent", id: "lens:sequence" } }),
    ).url;
    await handshake(url);
    const listed = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (result(listed).tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("add_step");
    expect(names).not.toContain("settle_absent");
  });

  it("tools/call writes the board and hands back the host-minted id", async () => {
    const server = await serverWith();
    const lane = await designLane(server);
    const url = designAddress(lane).url;
    await handshake(url);
    const called = await rpc(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "add_section", arguments: { title: "What the spec asks for" } },
    });
    expect(isError(called)).toBe(false);
    const id = textOf(called);
    expect(id).toMatch(/^d/);
    // The board the address names now holds exactly that element.
    expect(lane.board().elements.map((element) => element.id)).toEqual([id]);
  });

  it("a citation outside the change comes back as a tool error the seat can answer", async () => {
    const server = await serverWith();
    const lane = await designLane(server);
    const url = designAddress(lane).url;
    await handshake(url);
    const called = await rpc(url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "cite",
        arguments: { path: "src/auth.ts", side: "head", start_line: 900, end_line: 901 },
      },
    });
    // A refusal is a RESULT, not a JSON-RPC error: the seat reads it and fixes the call
    // inside the same turn (D6). A protocol error would never reach it as words.
    expect(isError(called)).toBe(true);
    expect(textOf(called)).toContain("src/auth.ts");
    expect(lane.board().elements).toHaveLength(0);
  });

  it("an unknown method is a JSON-RPC error, not a tool result", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    const answer = await rpc(url, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    expect((answer.body as { error?: { code: number } }).error?.code).toBe(-32601);
  });

  it("the server offers no server→client stream and says so", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${BEARER}`, accept: "text/event-stream" },
    });
    expect(response.status).toBe(405);
    await response.text();
  });
});

// ── 2.5 The two halves of a seat's credential ────────────────────────────────

describe("an address names a board and a bearer authenticates the caller (2.5)", () => {
  it("the right address with no bearer is refused", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    const answer = await rpc(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { bearer: null });
    expect(answer.status).toBe(401);
    expect(answer.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("the right address with the wrong bearer is refused", async () => {
    const server = await serverWith();
    const url = designAddress(await designLane(server)).url;
    const answer = await rpc(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { bearer: "guessed" });
    expect(answer.status).toBe(401);
  });

  it("the right bearer at an address nobody minted reaches no board", async () => {
    const server = await serverWith();
    // A LIVE address exists alongside it. Without one the registry is empty and any
    // lookup answers 404 whatever it does, so this asserted nothing: a mutation that
    // resolved an unknown token to whatever seat was to hand reddened nothing (control
    // M2, 2026-09-05). The live seat is what makes the token itself load-bearing.
    const live = designAddress(await designLane(server));
    expect((await rpc(live.url, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
    const answer = await rpc(`${server.origin}/board/never-minted`, {
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    });
    expect(answer.status).toBe(404);
  });

  it("a stale address is refused, and a turn's refresh makes it live again", async () => {
    let clock = 1_000;
    const server = await serverWith({ now: () => clock, livenessMs: 60_000 });
    const lane = await designLane(server);
    const address = designAddress(lane);
    expect((await rpc(address.url, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);

    clock += 60_001;
    const stale = await rpc(address.url, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(stale.status).toBe(401);

    // What a turn does: `address` for a seat that already has one refreshes its liveness
    // and hands back the SAME url, because the provider fixed the session's MCP
    // configuration on the thread's first turn.
    const again = designAddress(lane);
    expect(again.url).toBe(address.url);
    expect((await rpc(address.url, { jsonrpc: "2.0", id: 3, method: "ping" })).status).toBe(200);
  });

  it("a settled lane's addresses stop working on the very next call, and a sibling's do not", async () => {
    const server = await serverWith();
    const lane = await designLane(server);
    const url = designAddress(lane).url;
    // A SIBLING lane runs on. Its live address is what keeps the settled one's 404 about
    // this lane rather than about an empty registry (controls M2/M4, 2026-09-05).
    const sibling = server.openLane({ generationId: "gen-1", target: "sequence", lint: lint() });
    const siblingUrl = addressOf(
      sibling.address({
        seat: "sequence",
        author: { kind: "lens-agent", id: "lens:sequence" },
        idPrefix: "q",
      }),
    ).url;
    await handshake(url);
    await handshake(siblingUrl);
    const before = await rpc(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "add_section", arguments: { title: "Before the lane settled" } },
    });
    expect(isError(before)).toBe(false);

    lane.settle();

    const after = await rpc(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "add_section", arguments: { title: "After the lane settled" } },
    });
    expect(after.status).toBe(404);
    // Nothing landed after the settlement; the board is what it was.
    expect(lane.board().elements).toHaveLength(1);
    // The sibling lane never settled, so its seat is still writing.
    const siblingCall = await rpc(siblingUrl, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "add_section", arguments: { title: "Still drafting" } },
    });
    expect(isError(siblingCall)).toBe(false);
    expect(sibling.board().elements).toHaveLength(1);
  });

  it("settling a generation revokes every lane it holds", async () => {
    const server = await serverWith();
    const design = await designLane(server);
    const sequence = server.openLane({ generationId: "gen-1", target: "sequence", lint: lint() });
    const designUrl = designAddress(design).url;
    const sequenceUrl = addressOf(
      sequence.address({ seat: "sequence", author: { kind: "lens-agent", id: "lens:sequence" } }),
    ).url;

    server.settleGeneration("gen-1");

    expect((await rpc(designUrl, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
    expect((await rpc(sequenceUrl, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
  });

  it("keeps working when the sidecar respawns under it with a fresh bearer", async () => {
    const server = await serverWith();
    const lane = await designLane(server);
    const url = designAddress(lane).url;
    await handshake(url);
    expect((await rpc(url, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);

    // The supervisor's child exited and the next `ensure()` spawned a fresh sidecar, whose
    // environment carries a fresh bearer. Every harness child now presents the NEW one.
    // A listener that captured the first bearer would 401 every seat from here to the end
    // of the daemon's life — silently, while the seats ran and billed.
    currentBearer = "the-respawned-sidecars-bearer";

    const after = await rpc(url, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(after.status).toBe(200);
    // …and the bearer the first sidecar handed out is no longer one of ours.
    expect(
      (await rpc(url, { jsonrpc: "2.0", id: 3, method: "ping" }, { bearer: BEARER })).status,
    ).toBe(401);
  });

  it("hands a seat the SAME address after a restart, because a session's url is fixed", async () => {
    const first = await serverWith({ port: 0 });
    const lane = await designLane(first);
    const before = designAddress(lane).url;
    const port = first.port;
    await first.close();
    started = started.filter((server) => server !== first);

    // A new daemon, a new listener, the same sidecar and the same generation. Both
    // providers fixed the session's MCP configuration when the child was created, so a
    // seat whose url moved is refused by name on its next turn rather than served.
    const second = await serverWith({ port });
    const restored = second.openLane({ generationId: "gen-1", target: "design", lint: lint() });
    expect(designAddress(restored).url).toBe(before);
  });

  it("hands a re-opened lane's seat the address its session already holds", async () => {
    const server = await serverWith();
    const lane = await designLane(server);
    const before = designAddress(lane).url;
    lane.settle();
    // A retry re-opens the lane. A freshly minted token here would change the url under a
    // session that is still open, and its next turn would be refused as a mismatch.
    const again = server.openLane({ generationId: "gen-1", target: "design", lint: lint() });
    expect(designAddress(again).url).toBe(before);
  });

  it("gives two generations' same-named seats different addresses", async () => {
    const server = await serverWith();
    const first = designAddress(await designLane(server)).url;
    const second = addressOf(
      server
        .openLane({ generationId: "gen-2", target: "design", lint: lint() })
        .address({ seat: "design", author: { kind: "lens-agent", id: "lens:design" } }),
    ).url;
    expect(first).not.toBe(second);
  });

  it("mints no address at all while there is no sidecar to derive from", async () => {
    currentBearer = "";
    const server = await serverWith();
    const lane = await designLane(server);
    // HMAC over an EMPTY key is a publicly computable value, and it would stay live in the
    // registry once the next sidecar arrived. Refusing withholds nothing: there is no
    // sidecar for a call to have come from, so there is no seat to serve.
    expect(
      lane.address({ seat: "design", author: { kind: "lens-agent", id: "lens:design" } }),
    ).toBeUndefined();

    // An empty PRESENTED bearer never gets as far as the registry either: `bearerOf`'s
    // `.+` is what stops `sha256("")` matching `sha256("")` while no sidecar is up.
    expect((await rpc(`${server.origin}/board/anything`, { jsonrpc: "2.0", id: 1 })).status).toBe(
      401,
    );

    // The real claim: once a sidecar IS up, the token an attacker could have computed from
    // the empty key still reaches nothing, because it was never registered. Computed here
    // exactly as the derivation would compute it.
    currentBearer = BEARER;
    const guessable = createHmac("sha256", "").update("gen-1 design design").digest("base64url");
    expect(
      (
        await rpc(`${server.origin}/board/${encodeURIComponent(guessable)}`, {
          jsonrpc: "2.0",
          id: 2,
          method: "ping",
        })
      ).status,
    ).toBe(404);

    // …and the seat now gets its real address, which is a different string.
    const real = designAddress(lane);
    expect(real.url).toContain("/board/");
    expect(real.url).not.toContain(encodeURIComponent(guessable));
  });

  it("a seat's address carries no bearer: the credential travels by variable NAME", async () => {
    const server = await serverWith();
    const address = designAddress(await designLane(server));
    expect(address.name).toBe(BOARD_MCP_SERVER_NAME);
    expect(address.bearerTokenEnvVar).toBe(BOARD_BEARER_ENV_VAR);
    // The url is what Codex writes onto its app-server argument list. The bearer is not in
    // it — only the name of the variable the child reads it out of is on the turn at all.
    expect(address.url).not.toContain(BEARER);
    expect(JSON.stringify(address)).not.toContain(BEARER);
    // A url-encoded bearer is a different string from a raw one — see BEARER's note — so
    // this asks a second question: the token is DERIVED from the bearer, and the
    // derivation must not put it in the address in either spelling.
    expect(encodeURIComponent(BEARER)).not.toBe(BEARER);
    expect(address.url).not.toContain(encodeURIComponent(BEARER));
  });
});

// ── 2.5 The port survives the daemon that bound it ───────────────────────────

describe("the listener comes back on the port it recorded (2.5)", () => {
  it("re-binds the recorded port, so a live session's url still resolves", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rennet-board-port-"));
    scratch.push(stateDir);
    const first = await serverWith({ stateDir });
    const port = first.port;
    expect(JSON.parse(readFileSync(join(stateDir, "board-server.json"), "utf8"))).toEqual({ port });
    await first.close();
    started = started.filter((server) => server !== first);

    // A new daemon, the same sidecar, the same generation. Nothing tells this listener
    // which port to take but the record it left.
    const second = await serverWith({ stateDir });
    expect(second.port).toBe(port);
  });

  it("falls back to a fresh port when something took the recorded one, and rewrites the record", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rennet-board-port-"));
    scratch.push(stateDir);
    const first = await serverWith({ stateDir });
    const taken = first.port;
    await first.close();
    started = started.filter((server) => server !== first);

    // Something else grabbed it while the daemon was down.
    const squatter = createServer();
    await new Promise<void>((resolve) => {
      squatter.listen(taken, "127.0.0.1", resolve);
    });
    try {
      const second = await serverWith({ stateDir });
      // Not fatal: the whole feature does not go down for a port number. The seats of a
      // generation that was mid-flight get new urls and are refused by name, which is loud.
      expect(second.port).not.toBe(taken);
      expect(JSON.parse(readFileSync(join(stateDir, "board-server.json"), "utf8"))).toEqual({
        port: second.port,
      });
    } finally {
      await new Promise<void>((resolve) => {
        squatter.close(() => {
          resolve();
        });
      });
    }
  });

  it("binds an ephemeral port and records nothing when it is given no state dir", async () => {
    const server = await serverWith();
    expect(server.port).toBeGreaterThan(0);
  });
});

// ── 2.6 Flagged: two addresses, one board ────────────────────────────────────

describe("a Flagged lane gets two addresses onto one board (2.6, D9)", () => {
  it("both seats write the ONE board and the ids they are handed cannot collide", async () => {
    const server = await serverWith();
    const lane = server.openLane({ generationId: "gen-1", target: "flagged", lint: lint() });
    const claude = addressOf(
      lane.address({
        seat: "flagged-claude",
        author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
        idPrefix: "f",
      }),
    );
    const codex = addressOf(
      lane.address({
        seat: "flagged-codex",
        author: { kind: "lens-agent", id: "lens:flagged:codex" },
        idPrefix: "g",
      }),
    );
    expect(claude.url).not.toBe(codex.url);

    await handshake(claude.url);
    await handshake(codex.url);
    const cite = async (url: string, id: number, startLine: number) =>
      textOf(
        await rpc(url, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "cite",
            arguments: {
              path: "src/auth.ts",
              side: "head",
              start_line: startLine,
              end_line: startLine + 1,
            },
          },
        }),
      );
    const addFinding = async (url: string, id: number, concern: string, ref: string) =>
      textOf(
        await rpc(url, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "add_finding",
            arguments: { severity: "high", concern, code_ref_ids: [ref] },
          },
        }),
      );

    const claudeRef = await cite(claude.url, 2, 10);
    const codexRef = await cite(codex.url, 3, 12);
    const fromClaude = await addFinding(
      claude.url,
      4,
      "The refresh token is classified before its code is read.",
      claudeRef,
    );
    const fromCodex = await addFinding(
      codex.url,
      5,
      "The retry loop has no ceiling on the error path.",
      codexRef,
    );

    expect(new Set([claudeRef, codexRef, fromClaude, fromCodex]).size).toBe(4);
    expect(claudeRef.startsWith("f")).toBe(true);
    expect(fromClaude.startsWith("f")).toBe(true);
    expect(codexRef.startsWith("g")).toBe(true);
    expect(fromCodex.startsWith("g")).toBe(true);

    // ONE board, holding all four in the order the two seats' calls arrived — not two
    // boards that happen to be prefixed differently.
    const elements = lane.board().elements;
    expect(elements.map((element) => element.id)).toEqual([
      claudeRef,
      codexRef,
      fromClaude,
      fromCodex,
    ]);
    // Each element carries the voice that wrote it.
    const authorOf = (id: string): string | undefined => {
      const data = elements.find((element) => element.id === id)?.data as
        | { author?: { id?: string } }
        | undefined;
      return data?.author?.id;
    };
    expect(authorOf(fromClaude)).toBe("lens:flagged:claudeAgent");
    expect(authorOf(fromCodex)).toBe("lens:flagged:codex");
  });

  it("one voice can cite an element the other voice created, because it is one board", async () => {
    const server = await serverWith();
    const lane = server.openLane({ generationId: "gen-1", target: "flagged", lint: lint() });
    const claude = addressOf(
      lane.address({
        seat: "flagged-claude",
        author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
        idPrefix: "f",
      }),
    );
    const codex = addressOf(
      lane.address({
        seat: "flagged-codex",
        author: { kind: "lens-agent", id: "lens:flagged:codex" },
        idPrefix: "g",
      }),
    );
    await handshake(claude.url);
    await handshake(codex.url);

    const cited = textOf(
      await rpc(claude.url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "cite",
          arguments: { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 },
        },
      }),
    );
    const finding = await rpc(codex.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "add_finding",
        arguments: {
          severity: "medium",
          concern: "The classification happens before the code is read.",
          code_ref_ids: [cited],
        },
      },
    });
    expect(isError(finding)).toBe(false);
  });

  it("opening the same lane twice returns the board that is already being written", async () => {
    const server = await serverWith();
    const first = server.openLane({ generationId: "gen-1", target: "flagged", lint: lint() });
    const url = addressOf(
      first.address({
        seat: "flagged-claude",
        author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
        idPrefix: "f",
      }),
    ).url;
    await handshake(url);
    await rpc(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "add_section", arguments: { title: "Correctness" } },
    });
    const second = server.openLane({ generationId: "gen-1", target: "flagged", lint: lint() });
    expect(second.board().elements).toHaveLength(1);
  });
});

// ── 3.1 What the health report is allowed to say ─────────────────────────────

/**
 * `openLaneCount` is the ONLY input to the `t3code-sidecar` disclosure clause: the daemon's
 * `localToolServers` reports this listener as local exactly when it is serving at least one
 * lane, and reports nothing when it is not, so that a status field never claims a running
 * loopback server while none runs. It had no test, and its production caller was reading a
 * number that could not move because the pipeline's lane-opening loop was never handed its
 * board runtime — see `opens every lens lane on the board server before any seat turn is
 * dispatched` in `rounds.test.ts` for the other half.
 */
describe("the listener discloses how many lanes it is serving (3.1)", () => {
  it("counts open lanes, keeps counting a settled one, and forgets a settled generation", async () => {
    const server = await serverWith();
    expect(server.openLaneCount(), "nothing open yet, so nothing to disclose").toBe(0);

    for (const target of ["design", "sequence", "decisions"] as const) {
      server.openLane({ generationId: "gen-1", target, lint: lint() });
    }
    expect(server.openLaneCount()).toBe(3);

    // Re-opening the same lane returns the existing one; it is not a second board.
    server.openLane({ generationId: "gen-1", target: "design", lint: lint() });
    expect(server.openLaneCount(), "re-opening a lane does not add one").toBe(3);

    // A second generation's lanes are this listener's too — the disclosure is about the
    // SERVER, not about one generation.
    server.openLane({ generationId: "gen-2", target: "design", lint: lint() });
    expect(server.openLaneCount()).toBe(4);

    // `settle()` revokes a lane's seat addresses; the board is still served, and saying
    // otherwise would under-report a listener that is still listening.
    server.lane("gen-1", "design")?.settle();
    expect(server.openLaneCount(), "a settled lane is still a board this listener serves").toBe(4);

    // `settleGeneration` DELETES its lanes, so the count falls.
    server.settleGeneration("gen-1");
    expect(server.openLaneCount()).toBe(1);
    server.settleGeneration("gen-2");
    expect(server.openLaneCount(), "nothing left to disclose").toBe(0);
  });
});

/**
 * Who hears a board being written (`lens-board-tools` D11, task 4.1).
 *
 * A lane outlives whoever opened it, in two ways this daemon really has: nothing deletes
 * one — `settleLane` revokes its seats and keeps its writer, and `settleGeneration` has no
 * production caller — and a generation id is `gen:<patchsetId>` over a CONTENT-ADDRESSED
 * patchset, which `rounds.ts` already states is global across sessions and reviews. So one
 * lane, one board and one writer are legitimately shared by two reviews of identical
 * content, and both of their readers are looking at the same board.
 *
 * The fixture is therefore TWO OPENERS over ONE generation, per CLAUDE.md's own rule that a
 * single-opener fixture cannot see this class at all. It could not: the first observer was
 * bound at the writer's construction and no later open could reach it.
 */
describe("a lane's write observers (4.1)", () => {
  const seat = { author: { kind: "lens-agent", id: "seat:sequence" } } as const;

  it("tells EVERY opener about every write, not only the first", async () => {
    const server = await serverWith();
    const first: BoardWrite[] = [];
    const second: BoardWrite[] = [];
    server.openLane({
      generationId: "gen:ps-1",
      target: "sequence",
      lint: lint(),
      onWrite: (write) => first.push(write),
    });
    // The SAME generation, opened by a second review of identical content. Before this it
    // took the first review's writer and the first review's observer: this reviewer watched
    // a board that opened, never filled and closed, while the other reviewer's stream
    // carried writes it had not asked for and could not attribute.
    const lane = server.openLane({
      generationId: "gen:ps-1",
      target: "sequence",
      lint: lint(),
      onWrite: (write) => second.push(write),
    });

    const written = lane.writer().voice(seat).call("add_section", { title: "Reading Order" });
    expect(written.ok, "the fixture's call was refused").toBe(true);

    expect(first, "the first opener still hears it").toHaveLength(1);
    expect(second, "and so does the second").toHaveLength(1);
    expect(second[0]?.changed.map(({ element }) => element.kind)).toEqual(["section"]);
  });

  it("keeps one broken watcher from starving the rest of the fan-out", async () => {
    const server = await serverWith();
    const survivor: BoardWrite[] = [];
    server.openLane({
      generationId: "gen:ps-2",
      target: "sequence",
      lint: lint(),
      onWrite: () => {
        throw new Error("this watcher is broken");
      },
    });
    const lane = server.openLane({
      generationId: "gen:ps-2",
      target: "sequence",
      lint: lint(),
      onWrite: (write) => survivor.push(write),
    });
    expect(lane.writer().voice(seat).call("add_section", { title: "Reading Order" }).ok).toBe(true);
    expect(survivor).toHaveLength(1);
    // …and the write itself went through, because a publication seam never changes the
    // board it describes.
    expect(lane.board().elements).toHaveLength(1);
  });

  it("hands a re-opened lane the board it already holds, so a reader can be seeded from it", async () => {
    // The other half of the same fact: a re-opened lane's board is not empty, and the
    // `opened` frame is built from `lane.board()` for exactly this reason.
    const server = await serverWith();
    const lane = server.openLane({ generationId: "gen:ps-3", target: "sequence", lint: lint() });
    expect(lane.writer().voice(seat).call("add_section", { title: "Reading Order" }).ok).toBe(true);
    const reopened = server.openLane({
      generationId: "gen:ps-3",
      target: "sequence",
      lint: lint(),
    });
    expect(reopened.board().elements).toHaveLength(1);
  });
});
