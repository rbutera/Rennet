import type { ChangedRegion, LintContext } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_BEARER_ENV_VAR,
  BOARD_MCP_SERVER_NAME,
  type BoardMcpServer,
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

const BEARER = "process-bearer-under-test";

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

afterEach(async () => {
  const running = started;
  started = [];
  for (const server of running) await server.close();
});

async function serverWith(
  options: Partial<Parameters<typeof startBoardMcpServer>[0]> = {},
): Promise<BoardMcpServer> {
  const server = await startBoardMcpServer({ bearer: BEARER, ...options });
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
  const bearer = init.bearer === undefined ? BEARER : init.bearer;
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

const designLane = async (server: BoardMcpServer) =>
  server.openLane({ generationId: "gen-1", target: "design", lint: lint() });

const designAddress = (lane: Awaited<ReturnType<typeof designLane>>) =>
  lane.address({
    seat: "design",
    author: { kind: "lens-agent", id: "lens:design" },
    idPrefix: "d",
  });

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

  it("a Sequence seat is served no settle_absent, because Sequence admits no absence", async () => {
    const server = await serverWith();
    const lane = server.openLane({ generationId: "gen-1", target: "sequence", lint: lint() });
    const url = lane.address({
      seat: "sequence",
      author: { kind: "lens-agent", id: "lens:sequence" },
    }).url;
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
    await designLane(server);
    const answer = await rpc(`${server.origin}/board/never-minted`, {
      jsonrpc: "2.0",
      id: 1,
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

  it("a settled lane's addresses stop working on the very next call", async () => {
    const server = await serverWith();
    const lane = await designLane(server);
    const url = designAddress(lane).url;
    await handshake(url);
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
  });

  it("settling a generation revokes every lane it holds", async () => {
    const server = await serverWith();
    const design = await designLane(server);
    const sequence = server.openLane({ generationId: "gen-1", target: "sequence", lint: lint() });
    const designUrl = designAddress(design).url;
    const sequenceUrl = sequence.address({
      seat: "sequence",
      author: { kind: "lens-agent", id: "lens:sequence" },
    }).url;

    server.settleGeneration("gen-1");

    expect((await rpc(designUrl, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
    expect((await rpc(sequenceUrl, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
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
  });

  it("two seats of two generations do not share an address", async () => {
    const server = await serverWith();
    const first = designAddress(await designLane(server));
    const second = server
      .openLane({ generationId: "gen-2", target: "design", lint: lint() })
      .address({ seat: "design", author: { kind: "lens-agent", id: "lens:design" } });
    expect(first.url).not.toBe(second.url);
  });
});

// ── 2.6 Flagged: two addresses, one board ────────────────────────────────────

describe("a Flagged lane gets two addresses onto one board (2.6, D9)", () => {
  it("both seats write the ONE board and the ids they are handed cannot collide", async () => {
    const server = await serverWith();
    const lane = server.openLane({ generationId: "gen-1", target: "flagged", lint: lint() });
    const claude = lane.address({
      seat: "flagged-claude",
      author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
      idPrefix: "f",
    });
    const codex = lane.address({
      seat: "flagged-codex",
      author: { kind: "lens-agent", id: "lens:flagged:codex" },
      idPrefix: "g",
    });
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
    const claude = lane.address({
      seat: "flagged-claude",
      author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
      idPrefix: "f",
    });
    const codex = lane.address({
      seat: "flagged-codex",
      author: { kind: "lens-agent", id: "lens:flagged:codex" },
      idPrefix: "g",
    });
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
    const url = first.address({
      seat: "flagged-claude",
      author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
      idPrefix: "f",
    }).url;
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
