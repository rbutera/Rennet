import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandName, commands } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAppTools } from "../agent-tools";
import type { DispatchContext } from "../dispatch";
import { APP_BEARER_ENV_VAR, APP_MCP_SERVER_NAME } from "./app-credentials";
import { type AppMcpServer, startAppMcpServer } from "./app-mcp-server";

/**
 * The daemon's loopback app-tools server (`session-thread-briefing` 3.3/3.4).
 *
 * Every claim here is made over the REAL WIRE: an HTTP client speaking the MCP
 * Streamable-HTTP handshake against a listener bound to `127.0.0.1`, never by calling the
 * handler functions directly. The thing being proved is that a harness child's MCP client
 * can discover and call these tools, and a direct call would prove only that `buildAppTools`
 * works, which `agent-tools.test.ts` already proves.
 *
 * What it still cannot catch: no real `claude` or `codex` child is driven here, so the final
 * hop — the provider's own MCP client against this listener — is not covered, and neither is
 * the bind that hands a thread this address (cluster 4). The live drive is task 6.1.
 */

/** Full of characters `encodeURIComponent` changes, so an encoding bug cannot read as a pass. */
const BEARER = "process bearer/under+test=";
let currentBearer = BEARER;

const THREAD = "thread-abc";

let started: AppMcpServer[] = [];
let scratch: string[] = [];

afterEach(async () => {
  const running = started;
  started = [];
  currentBearer = BEARER;
  for (const server of running) await server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

type Dispatched = [CommandName, unknown, DispatchContext | undefined];

/** A dispatch that records what reached it and answers whatever the test told it to. */
function recordingDispatch(answer: (name: CommandName, input: unknown) => unknown = () => ({})) {
  const calls: Dispatched[] = [];
  const dispatch = async (
    name: CommandName,
    input: unknown,
    ctx?: DispatchContext,
  ): Promise<unknown> => {
    calls.push([name, input, ctx]);
    return answer(name, input);
  };
  return { calls, dispatch };
}

async function serverWith(
  options: Partial<Parameters<typeof startAppMcpServer>[0]> = {},
): Promise<AppMcpServer> {
  const server = await startAppMcpServer({
    bearer: () => currentBearer,
    dispatch: () => async () => ({}),
    ...options,
  });
  started.push(server);
  return server;
}

interface RpcAnswer {
  readonly status: number;
  readonly body: unknown;
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
    body: json && text.length > 0 ? JSON.parse(text) : undefined,
  };
}

const result = (answer: RpcAnswer): Record<string, unknown> => {
  const body = answer.body as { result?: unknown; error?: { message?: string } };
  if (body?.result === undefined) {
    throw new Error(`expected a JSON-RPC result, got ${JSON.stringify(answer.body)}`);
  }
  return body.result as Record<string, unknown>;
};

const blocks = (answer: RpcAnswer): { type: string; text: string }[] =>
  result(answer).content as { type: string; text: string }[];

const call = async (url: string, name: string, args: Record<string, unknown>): Promise<RpcAnswer> =>
  rpc(url, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

const listTools = async (url: string): Promise<{ name: string; inputSchema: unknown }[]> => {
  const answer = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  return result(answer).tools as { name: string; inputSchema: unknown }[];
};

describe("the app-tools server's catalog is the registry's projection", () => {
  it("lists exactly `buildAppTools`' names over the wire", async () => {
    const server = await serverWith();
    const url = server.addressFor(THREAD).url;
    const initialized = await rpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
    });
    expect((result(initialized).serverInfo as { name: string }).name).toBe(APP_MCP_SERVER_NAME);
    await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" });

    const tools = await listTools(url);
    const expected = buildAppTools(async () => undefined).map((tool) => tool.name);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...expected].sort());
    expect(expected.length).toBeGreaterThan(20);
    // The ajv hazard #810 was: a meta key the installed `claude` CLI's validator rejects,
    // which fails the turn before it runs. Every served schema goes through the same
    // normalizer Rennet's own adapter uses.
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$schema");
    }
  });

  it("loses a tool when its row loses `exposure.agent` — the flag is the whole inventory", async () => {
    const server = await serverWith();
    const url = server.addressFor(THREAD).url;
    expect((await listTools(url)).map((tool) => tool.name)).toContain("app_board_read");

    // The positive control, run against the LIVE registry the server reads: flip the row
    // off and the tool must vanish from the wire with no edit to the server.
    const row = commands["board.read"].exposure as { agent: boolean };
    row.agent = false;
    try {
      const without = (await listTools(url)).map((tool) => tool.name);
      expect(without).not.toContain("app_board_read");
      // And the call is refused by name rather than dispatched.
      const refused = await call(url, "app_board_read", { reviewId: "r", generation: "g" });
      expect((refused.body as { error?: { message: string } }).error?.message).toContain(
        "app_board_read",
      );
    } finally {
      row.agent = true;
    }
    expect((await listTools(url)).map((tool) => tool.name)).toContain("app_board_read");
  });

  it("gives the paged tools a cursor and leaves every other schema alone", async () => {
    const server = await serverWith();
    const tools = await listTools(server.addressFor(THREAD).url);
    const schemaOf = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema as {
        properties?: Record<string, unknown>;
      };
    expect(schemaOf("app_board_read").properties?.cursor).toBeDefined();
    expect(schemaOf("app_session_list").properties?.cursor).toBeDefined();
    expect(schemaOf("app_session_transcript").properties?.cursor).toBeDefined();
    expect(schemaOf("app_patchset_readEvidence").properties?.cursor).toBeDefined();
    expect(schemaOf("app_ask_stage").properties?.cursor).toBeUndefined();
  });
});

describe("what a call carries into dispatch", () => {
  it("stamps the thread as the author and fills the session it is bound to", async () => {
    const recorder = recordingDispatch(() => ({ receipt: { kind: "unstage" } }));
    const server = await serverWith({
      dispatch: () => recorder.dispatch,
      sessionFor: (threadId) => (threadId === THREAD ? "session-7" : undefined),
    });
    const ask = { id: "ask-1", anchor: "src/auth.ts:12", type: "change", body: "Retry later." };
    const answer = await call(server.addressFor(THREAD).url, "app_ask_stage", { ask });

    expect(recorder.calls).toHaveLength(1);
    const [name, input, ctx] = recorder.calls[0] as Dispatched;
    expect(name).toBe("ask.stage");
    // The session the thread is bound to, filled because the model named none.
    expect(input).toEqual({ sessionId: "session-7", ask });
    // WHO staged it: the thread, from the address the call arrived on.
    expect(ctx?.author?.kind).toBe("orchestrator");
    expect(ctx?.author?.id).toBe(THREAD);
    expect(blocks(answer)[0]?.text).toBe(JSON.stringify({ receipt: { kind: "unstage" } }));
  });

  it("never overrules a session the model named — other reviews are reachable on purpose", async () => {
    const recorder = recordingDispatch();
    const server = await serverWith({
      dispatch: () => recorder.dispatch,
      sessionFor: () => "session-7",
    });
    await call(server.addressFor(THREAD).url, "app_ask_read", { sessionId: "session-other" });
    expect((recorder.calls[0] as Dispatched)[1]).toEqual({ sessionId: "session-other" });
  });

  it("stamps an authored row's author even when the model claims to be the reviewer", async () => {
    const recorder = recordingDispatch();
    const server = await serverWith({ dispatch: () => recorder.dispatch });
    await call(server.addressFor(THREAD).url, "app_ask_quoteReply", {
      sessionId: "s1",
      threadId: "quote-1",
      author: "user",
      text: "Done.",
    });
    // A durable log that recorded the model's word for this would put its sentences in the
    // reviewer's mouth. The address decides, not the input.
    expect((recorder.calls[0] as Dispatched)[1]).toMatchObject({ author: "orchestrator" });
  });

  it("reads the dispatch late, so a listener bound before dispatch exists still serves", async () => {
    // Exactly the composition root's shape: a slot filled below, read only when a call
    // arrives. Bound at daemon launch (#849), when `dispatch` does not exist yet.
    const late: { dispatch?: (name: CommandName, input: unknown) => Promise<unknown> } = {};
    const server = await serverWith({
      dispatch: () => late.dispatch as NonNullable<typeof late.dispatch>,
    });
    const seen: string[] = [];
    late.dispatch = async (name) => {
      seen.push(name);
      return { sessions: [] };
    };
    await call(server.addressFor(THREAD).url, "app_session_list", {});
    expect(seen).toEqual(["session.list"]);
  });

  it("hands a refusal back as a tool result, bounded, not as a protocol error", async () => {
    const long = "x".repeat(9_000);
    const server = await serverWith({
      dispatch: () => async () => {
        throw new Error(long);
      },
    });
    const answer = await call(server.addressFor(THREAD).url, "app_session_list", {});
    expect(result(answer).isError).toBe(true);
    const text = blocks(answer)[0]?.text ?? "";
    // A refusal is billed like any other result: capped, and honest about the cut.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(2_200);
    expect(text).toContain("elided");
  });
});

describe("paging a collection-carrying result", () => {
  // Small on purpose, so THIS fixture's page is stopped by the element cap and the next
  // test's is stopped by the byte budget. Both bounds are real and each test drives one.
  const element = (index: number) => ({ id: `e${index}` });
  const board = (count: number) => ({
    board: {
      lens: "noise",
      generation: "gen-1",
      boardId: "b1",
      document: { title: "Noise" },
      sections: [],
      elements: Array.from({ length: count }, (_, index) => element(index)),
    },
  });

  it("caps a board read, says what it elided, and serves the next page from the cursor", async () => {
    const server = await serverWith({ dispatch: () => async () => board(640) });
    const url = server.addressFor(THREAD).url;
    const first = await call(url, "app_board_read", {
      reviewId: "r",
      generation: "g",
      lens: "noise",
    });
    const content = blocks(first);
    const served = JSON.parse(content[0]?.text ?? "{}") as {
      board: { elements: { id: string }[] };
    };
    expect(served.board.elements).toHaveLength(200);
    expect(served.board.elements[0]?.id).toBe("e0");
    const marker = content[1]?.text ?? "";
    expect(marker).toContain("of 640");
    expect(marker).toContain("cursor: 200");

    const second = await call(url, "app_board_read", {
      reviewId: "r",
      generation: "g",
      lens: "noise",
      cursor: 200,
    });
    const page2 = JSON.parse(blocks(second)[0]?.text ?? "{}") as {
      board: { elements: { id: string }[] };
    };
    expect(page2.board.elements[0]?.id).toBe("e200");
    expect(blocks(second)[1]?.text).toContain("cursor: 400");
  });

  it("a board that fits carries no marker at all", async () => {
    const server = await serverWith({ dispatch: () => async () => board(3) });
    const answer = await call(server.addressFor(THREAD).url, "app_board_read", {
      reviewId: "r",
      generation: "g",
      lens: "noise",
    });
    expect(blocks(answer)).toHaveLength(1);
  });

  it("strips the cursor before dispatch — the command never sees a field it does not declare", async () => {
    const recorder = recordingDispatch(() => board(3));
    const server = await serverWith({ dispatch: () => recorder.dispatch });
    await call(server.addressFor(THREAD).url, "app_board_read", {
      reviewId: "r",
      generation: "g",
      lens: "noise",
      cursor: 2,
    });
    expect((recorder.calls[0] as Dispatched)[1]).toEqual({
      reviewId: "r",
      generation: "g",
      lens: "noise",
    });
  });

  it("pages the evidence read by bytes, with the cursor as a byte offset", async () => {
    const patch = "+".repeat(40_000);
    const server = await serverWith({
      dispatch: () => async () => ({ patch, path: "src/a.ts", counterparts: [] }),
    });
    const answer = await call(server.addressFor(THREAD).url, "app_patchset_readEvidence", {
      ref: { path: "src/a.ts" },
    });
    const served = JSON.parse(blocks(answer)[0]?.text ?? "{}") as { patch: string };
    expect(Buffer.byteLength(served.patch, "utf8")).toBe(16 * 1024);
    expect(blocks(answer)[1]?.text).toContain(`cursor: ${16 * 1024}`);
  });

  it("caps a page by BYTES when the elements are large, and still moves the cursor", async () => {
    // Ten elements would be under the count cap; each is ~4 kB, so the byte budget is what
    // stops this page. A count cap alone would have admitted 200 of these — 800 kB into the
    // conversation prefix, re-read on every remaining round trip of the turn.
    const fat = Array.from({ length: 40 }, (_, index) => ({
      id: `e${index}`,
      kind: "prose",
      markdown: "y".repeat(4_000),
    }));
    const server = await serverWith({
      dispatch: () => async () => ({
        board: {
          lens: "noise",
          generation: "g",
          boardId: "b",
          document: {},
          sections: [],
          elements: fat,
        },
      }),
    });
    const answer = await call(server.addressFor(THREAD).url, "app_board_read", {
      reviewId: "r",
      generation: "g",
      lens: "noise",
    });
    const served = JSON.parse(blocks(answer)[0]?.text ?? "{}") as {
      board: { elements: unknown[] };
    };
    expect(served.board.elements.length).toBeLessThan(10);
    expect(Buffer.byteLength(blocks(answer)[0]?.text ?? "", "utf8")).toBeLessThan(20_000);
    expect(blocks(answer)[1]?.text).toContain("page budget");
  });
});

describe("the address, the bearer and the port", () => {
  it("refuses a call with no bearer, and one with the wrong bearer", async () => {
    const dispatch = vi.fn(async () => ({}));
    const server = await serverWith({ dispatch: () => dispatch });
    const url = server.addressFor(THREAD).url;
    expect(
      (await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { bearer: null })).status,
    ).toBe(401);
    expect(
      (await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { bearer: "guessed" }))
        .status,
    ).toBe(401);
    // Not one call reached the dispatch behind those refusals.
    expect(dispatch).not.toHaveBeenCalled();
    // And the same request with the right bearer works, so the two above failed on the
    // bearer and not on the request.
    expect((await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  it("reads the bearer per call, so a respawned sidecar's children are not locked out", async () => {
    const server = await serverWith();
    const url = server.addressFor(THREAD).url;
    currentBearer = "the-next-sidecars-bearer";
    expect(
      (await rpc(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { bearer: BEARER })).status,
    ).toBe(401);
    expect((await rpc(url, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });

  it("names an empty bearer nothing: no sidecar means no caller", async () => {
    const server = await serverWith();
    currentBearer = "";
    const answer = await rpc(
      server.addressFor(THREAD).url,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { bearer: "" },
    );
    expect(answer.status).toBe(401);
  });

  it("404s a path that is not a thread address", async () => {
    const server = await serverWith();
    const response = await fetch(`${server.origin}/board/whatever`, {
      method: "POST",
      headers: { authorization: `Bearer ${currentBearer}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("addresses a thread stably, and comes back on the remembered port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-app-server-"));
    scratch.push(dir);
    const first = await serverWith({ stateDir: dir });
    const address = first.addressFor(THREAD);
    expect(address.name).toBe(APP_MCP_SERVER_NAME);
    expect(address.bearerTokenEnvVar).toBe(APP_BEARER_ENV_VAR);
    expect(address.url).toBe(`http://127.0.0.1:${first.port}/threads/${THREAD}`);
    expect(first.addressFor(THREAD).url).toBe(address.url);
    await first.close();
    started = started.filter((server) => server !== first);

    // A thread's url is fixed when its provider session is created, so a restarted daemon
    // that came back on a different port would have every later turn refused by name.
    const second = await serverWith({ stateDir: dir });
    expect(second.port).toBe(first.port);
    expect(second.addressFor(THREAD).url).toBe(address.url);
  });
});

describe("evidence paging ends at a complete UTF-8 code point (item 2, Codex P2)", () => {
  it("does not split a multibyte character across the page boundary", async () => {
    // `EVIDENCE_TOOL_BYTES_CAP` is 16 kB (16384). A raw byte-offset cut lands mid-`€`
    // (a 3-byte UTF-8 sequence starting at offset 16383), which decodes each half of the
    // split sequence as a replacement character (`�`) — corrupting both pages. This first
    // page (16383 bytes of paged patch text) is well within a plain inline reply here
    // (the universal ceiling lands in a later commit), so the paging fix is visible
    // directly in the reply.
    const patch = `${"x".repeat(16_383)}€after`;
    const server = await serverWith({
      dispatch: () => async () => ({ patch, path: "src/a.ts", counterparts: [] }),
    });
    const answer = await call(server.addressFor(THREAD).url, "app_patchset_readEvidence", {
      ref: { path: "src/a.ts" },
    });
    const served = JSON.parse(blocks(answer)[0]?.text ?? "{}") as { patch: string };
    expect(served.patch).not.toContain("�");
    // The whole 16383-byte run of `x` came through, and the cut backed off BEFORE `€`
    // entirely (a complete code point never starts a page split) rather than admitting a
    // truncated half of it.
    expect(served.patch).toBe("x".repeat(16_383));
    expect(served.patch).not.toContain("€");

    const marker = blocks(answer)[1]?.text ?? "";
    const cursorMatch = /cursor: (\d+)/.exec(marker);
    expect(cursorMatch?.[1]).toBe("16383");

    // The second, much smaller page (`€after`, 8 bytes) proves the byte the first page
    // could not safely include is exactly where the second page starts, with the
    // multibyte character whole again.
    const second = await call(server.addressFor(THREAD).url, "app_patchset_readEvidence", {
      ref: { path: "src/a.ts" },
      cursor: Number(cursorMatch?.[1]),
    });
    const servedSecond = JSON.parse(blocks(second)[0]?.text ?? "{}") as { patch: string };
    expect(servedSecond.patch).toBe("€after");
  });
});
