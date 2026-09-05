import { BOARD_TARGETS, boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BOARD_MCP_SERVER_NAME } from "../board/board-credentials";
import {
  BOARD_TOOL_COUNT,
  boardCallOf,
  boardReceipt,
  boardToolFromProviderName,
  isBoardToolName,
} from "./board-receipt";

/**
 * A board call, read back as the receipt a reviewer sees (`lens-board-tools` D11, 4.2).
 *
 * Every activity here is shaped the way T3's own projection shapes one — `data.toolName`,
 * `data.input` and a one-line `data.result.content` for the Claude adapter's path
 * (`ClaudeAdapter.ts` fills those three; `ActivityPayloadProjection.ts` is what keeps them),
 * and an `data.item` with `server`/`tool`/`arguments` for the MCP-item shape. What these
 * CANNOT prove is that a live provider fills either shape as the vendored source says it
 * does; that is task 7.1's drive to observe, and it is named in the PR as such.
 */

const ISO = (ms: number) => new Date(ms).toISOString();

/** The Claude adapter's shape: `data.toolName` + `data.input`, plus its detail line. */
const claudeCall = (
  tool: string,
  input: Record<string, unknown>,
  over: { result?: string; status?: string } = {},
) => ({
  tone: "tool",
  kind: over.result === undefined ? "tool.started" : "tool.completed",
  summary: "MCP tool call",
  payload: {
    itemType: "mcp_tool_call",
    toolCallId: `call-${tool}`,
    status: over.status ?? (over.result === undefined ? "inProgress" : "completed"),
    // T3 writes this verbatim from `summarizeToolRequest`, and it is the string every
    // pre-4.2 path would have rendered.
    detail: `mcp__${BOARD_MCP_SERVER_NAME}__${tool}: ${JSON.stringify(input)}`,
    data: {
      toolName: `mcp__${BOARD_MCP_SERVER_NAME}__${tool}`,
      input,
      ...(over.result === undefined ? {} : { result: { content: over.result } }),
    },
  },
  turnId: "turn-1",
  createdAt: ISO(1),
});

/** The MCP-item shape: `data.item.server` / `.tool` / `.arguments` / `.result.content`. */
const itemCall = (
  tool: string,
  input: Record<string, unknown>,
  over: { result?: string; status?: string } = {},
) => ({
  tone: "tool",
  kind: "tool.completed",
  summary: "MCP tool call",
  payload: {
    itemType: "mcp_tool_call",
    toolCallId: `item-${tool}`,
    status: over.status ?? "completed",
    data: {
      item: {
        type: "mcpToolCall",
        server: BOARD_MCP_SERVER_NAME,
        tool,
        arguments: input,
        status: over.status ?? "completed",
        ...(over.result === undefined ? {} : { result: { content: over.result } }),
      },
    },
  },
  turnId: "turn-1",
  createdAt: ISO(1),
});

describe("the board tool table", () => {
  it("covers every tool of every target, and says how many it swept", () => {
    // The literal is HARD-CODED. Deriving the expected total from the same tables the map
    // is built over is satisfied by an empty table on both sides — the failure this change
    // has already shipped once (`board-tool-surface.measure.test.ts`). Change this number
    // deliberately when a verb is added or removed.
    expect(BOARD_TOOL_COUNT).toBe(26);
    const swept = new Set<string>();
    for (const target of BOARD_TARGETS) {
      for (const name of boardToolsByName(target).keys()) {
        swept.add(name);
        expect(isBoardToolName(name), `${target}'s \`${name}\` is not a known board tool`).toBe(
          true,
        );
      }
    }
    expect(swept.size, "the sweep saw every tool the map claims").toBe(BOARD_TOOL_COUNT);
    expect(BOARD_TARGETS.length, "every target was swept").toBe(6);
  });

  it("reads a board tool only out of THIS server's namespace", () => {
    expect(boardToolFromProviderName(`mcp__${BOARD_MCP_SERVER_NAME}__add_step`)).toBe("add_step");
    expect(boardToolFromProviderName(`${BOARD_MCP_SERVER_NAME}__finish`)).toBe("finish");
    expect(boardToolFromProviderName(`${BOARD_MCP_SERVER_NAME}.cite`)).toBe("cite");
    // A seat inherits the user's own MCP servers (a settled ruling), so a bare verb from
    // somebody else's server must not read as this board settling.
    expect(boardToolFromProviderName("finish")).toBeUndefined();
    expect(boardToolFromProviderName("mcp__someone_else__finish")).toBeUndefined();
    // A name inside our namespace that is not one of our verbs is still not a board call.
    expect(boardToolFromProviderName(`mcp__${BOARD_MCP_SERVER_NAME}__rm_rf`)).toBeUndefined();
  });
});

describe("boardCallOf", () => {
  it("reads the Claude adapter's projected payload", () => {
    const call = boardCallOf(claudeCall("add_step", { title: "Read the entry point" }));
    expect(call?.tool).toBe("add_step");
    expect(call?.input?.title).toBe("Read the entry point");
    expect(call?.refused).toBe(false);
  });

  it("reads the MCP item's own server and tool", () => {
    const call = boardCallOf(itemCall("cite", { path: "src/foo.ts" }, { result: "e4" }));
    expect(call?.tool).toBe("cite");
    expect(call?.input?.path).toBe("src/foo.ts");
    expect(call?.result).toBe("e4");
  });

  it("falls back to the detail line when the adapter projected neither", () => {
    const bare = {
      tone: "tool",
      kind: "tool.started",
      summary: "MCP tool call",
      payload: {
        itemType: "mcp_tool_call",
        detail: `${BOARD_MCP_SERVER_NAME}.finish: {}`,
      },
      turnId: "turn-1",
      createdAt: ISO(1),
    };
    expect(boardCallOf(bare)?.tool).toBe("finish");
  });

  it("is not a board call when nothing names this server", () => {
    const other = {
      tone: "tool",
      kind: "tool.started",
      summary: "Tool",
      payload: { itemType: "file_change", detail: 'Read: {"file_path":"/x/src/a.ts"}' },
      turnId: "turn-1",
      createdAt: ISO(1),
    };
    expect(boardCallOf(other)).toBeUndefined();
  });
});

describe("boardReceipt", () => {
  const receipt = (
    activity: ReturnType<typeof claudeCall>,
    options: { ordinal?: number; repoRoot?: string } = {},
  ): string => {
    const call = boardCallOf(activity);
    if (call === undefined) throw new Error("expected a board call");
    return boardReceipt(call, options);
  };

  it("reads an in-flight add in the present tense and a finished one as a receipt", () => {
    expect(receipt(claudeCall("add_step", { title: "x" }), { ordinal: 3 })).toBe("adding step 3");
    expect(receipt(claudeCall("add_step", { title: "x" }, { result: "e9" }), { ordinal: 3 })).toBe(
      "added step 3",
    );
  });

  it("reads a citation as its span, relative to the checkout", () => {
    expect(
      receipt(
        claudeCall(
          "cite",
          { path: "/Users/x/repo/src/foo.ts", side: "head", start_line: 41, end_line: 58 },
          { result: "e2" },
        ),
        { repoRoot: "/Users/x/repo" },
      ),
    ).toBe("cited `src/foo.ts:41-58`");
  });

  it("reads `finish` as the verdict it came back with", () => {
    // The pointer count is parsed off `describeOutcome`'s OWN first line — a sentence this
    // daemon writes, not a guess at the provider's shape.
    expect(
      receipt(
        claudeCall("finish", {}, { result: "not settled — 1 to fix, then call finish again:" }),
      ),
    ).toBe("finish returned 1 pointer");
    expect(
      receipt(
        claudeCall("finish", {}, { result: "not settled — 4 to fix, then call finish again:" }),
      ),
    ).toBe("finish returned 4 pointers");
    expect(receipt(claudeCall("finish", {}, { result: "board settled" }))).toBe(
      "finished the board",
    );
    expect(receipt(claudeCall("finish", {}))).toBe("finishing the board");
  });

  it("reads a refusal as the sentence the board wrote to be read", () => {
    const refused = claudeCall(
      "cite",
      { path: "src/nope.ts", side: "head", start_line: 1, end_line: 2 },
      { result: "`src/nope.ts` has no changed lines on the head side.", status: "failed" },
    );
    expect(receipt(refused)).toBe("refused: `src/nope.ts` has no changed lines on the head side.");
  });

  it("names every verb of every target without ever speaking the call's payload", () => {
    // THE NO-RAW-INPUT ASSERTION, and the answer to #819's second half. Every board tool of
    // every target is called with a distinct poison value in every field, and the receipt
    // must speak NONE of them — except the two that are ADDRESSES rather than payload and
    // that the receipt names on purpose:
    //
    //   `path`       — a citation reads "cited `src/foo.ts:41-58`" (D11's own example);
    //   `element_id` — a removal or a revision reads which element it moved.
    //
    // Everything else a seat writes — a title, a markdown body, a reason, a note — is the
    // element it is handing over, and rendering it in the line the reviewer reads as speech
    // is exactly the defect (#819: `StructuredOutput: {"elements":[…`). The exception list
    // is not a blanket: both members are asserted to have actually been spoken below, so a
    // receipt that quietly stopped naming a citation's file would redden this too.
    const poison = (field: string) => `POISON_${field}`;
    const SPOKEN = new Set(["path", "element_id"]);
    const spokenSeen = new Set<string>();
    let asserted = 0;
    for (const target of BOARD_TARGETS) {
      for (const [name, tool] of boardToolsByName(target)) {
        const fields = ["element_id", ...tool.fields.map((field) => field.name)];
        const input: Record<string, unknown> = {};
        for (const field of fields) input[field] = poison(field);
        const activity = claudeCall(name, input, { result: poison("result") });
        const call = boardCallOf(activity);
        expect(call, `${target}/${name} was not read as a board call`).toBeDefined();
        const line = boardReceipt(call ?? { tool: name, refused: false }, { ordinal: 1 });
        for (const field of fields) {
          if (SPOKEN.has(field)) {
            if (line.includes(poison(field))) spokenSeen.add(field);
            continue;
          }
          expect(line, `${target}/${name} spoke its \`${field}\``).not.toContain(poison(field));
        }
        // VACUOUS AS WRITTEN, and kept for what they document rather than what they
        // catch. `boardReceipt` reads the parsed call, never `payload.detail`, and no
        // poison value here contains a brace or the server's name — so neither of these
        // can fail against this fixture. The per-field assertion above is the real one.
        // They stay because they name the two shapes the receipt must never become, and
        // a future receipt built from the detail string would have to delete them rather
        // than quietly slip past a sweep that no longer looked.
        expect(line, `${target}/${name} rendered JSON`).not.toMatch(/[{}[\]]/);
        expect(line, `${target}/${name} fell back to the detail line`).not.toContain(
          BOARD_MCP_SERVER_NAME,
        );
        expect(line.trim(), `${target}/${name} said nothing`).not.toBe("");
        asserted += 1;
      }
    }
    // A loop that stopped iterating passes as a sweep, so the sweep counts what it swept.
    // 26 distinct tools spread over 6 targets, most of them shared: 95 (target, tool) pairs.
    // 95 and not 100: `write_board` is on the Noise target alone (#869), so it adds one
    // pair rather than six.
    expect(asserted).toBe(95);
    // The exception list is exercised rather than merely declared.
    expect([...spokenSeen].sort()).toEqual(["element_id", "path"]);
  });
});
