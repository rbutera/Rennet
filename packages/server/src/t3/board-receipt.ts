// A board tool call, read back as a RECEIPT (`lens-board-tools` D11, task 4.2).
//
// PURE. Input is one T3 thread activity (the shape `subscribeThread` yields); output is
// one sentence a reviewer can read. No Effect, no `@t3tools`, no I/O — the same discipline
// `latest-event.ts` keeps, and this is its board arm.
//
// ── Why an arm and not the fallback ──────────────────────────────────────────────
// `toolLine`'s unknown-tool fallback shows T3's own `<toolName>: <input>` detail, and for
// a board call that input IS the element the seat is writing. #819's live line read
// `StructuredOutput: {"elements":[…` for exactly this reason once, and the tools would
// have brought it back one call at a time: `mcp__rennet_board__add_step:
// {"parent_id":"e3","title":…}` is the same defect with a different tool name in front of
// it. A seat's line is its SPEECH; the payload it is handing over is not speech.
//
// ── Why a finished board call still speaks ───────────────────────────────────────
// `projectLatestEvent` normally shows only a call IN FLIGHT, because a finished `Read` is
// no longer what the seat is doing. A board call is different in kind: the daemon answers
// it in microseconds, so its in-flight window is invisible, and what the reviewer wants is
// not "what is it waiting on" but "what did it just put on the board". So a board call's
// line survives its completion, and it reads in the past tense, which is what makes it a
// receipt rather than a status.
//
// ── What it reads, and why not the detail string ─────────────────────────────────
// T3 projects an `mcp_tool_call` activity's payload to `data.toolName`, `data.input` and a
// one-line summary of the result (`ActivityPayloadProjection.ts`), and the Claude adapter
// fills all three. That is the shape that ships, so this reads it — the `<toolName>:
// <json>` detail line is the LAST resort, used only when the projected fields are absent.
// The result line is Rennet's own `describeOutcome` output coming back, which is why
// "finish returned 1 pointer" is parseable at all: it is this daemon's sentence, not a
// guess at the provider's.

import { BOARD_TARGETS, boardToolsByName } from "@rennet/protocol";
import { BOARD_MCP_SERVER_NAME } from "../board/board-credentials";

/**
 * Every board tool name, over every target, mapped to the verb it runs.
 *
 * DERIVED from the same tables the served catalog is built from, never listed here: a kind
 * added to a lens's typed-kind row gets its verbs in `boardToolsByName` and therefore here,
 * with nothing edited. A name absent from this map is not a board tool.
 */
const BOARD_TOOL_VERBS: ReadonlyMap<string, { verb: string; kind?: string }> = (() => {
  const verbs = new Map<string, { verb: string; kind?: string }>();
  for (const target of BOARD_TARGETS) {
    for (const tool of boardToolsByName(target).values()) {
      verbs.set(tool.name, {
        verb: tool.verb,
        ...(tool.kind === undefined ? {} : { kind: tool.kind }),
      });
    }
  }
  return verbs;
})();

/** How many board tools exist across every target — the sweep's own count (task 4.2). */
export const BOARD_TOOL_COUNT: number = BOARD_TOOL_VERBS.size;

/** Is this a board tool's name? */
export function isBoardToolName(name: string): boolean {
  return BOARD_TOOL_VERBS.has(name);
}

/**
 * The board tool a namespaced provider tool name refers to, or `undefined`.
 *
 * Both providers prefix an MCP tool with the server it came from — Claude as
 * `mcp__<server>__<tool>`, Codex as `<server>__<tool>` or `<server>.<tool>` — and the
 * server name is LOAD-BEARING here rather than decorative. A seat inherits the user's own
 * settings and therefore the user's own MCP servers (a settled ruling), so a bare `finish`
 * from somebody else's server would otherwise read as this board settling. Nothing but
 * `rennet_board` is read as a board call, and the adapter refuses a same-named server as a
 * collision, so the name cannot be borrowed.
 */
export function boardToolFromProviderName(name: string): string | undefined {
  const at = name.lastIndexOf(BOARD_MCP_SERVER_NAME);
  if (at === -1) return undefined;
  const rest = name.slice(at + BOARD_MCP_SERVER_NAME.length);
  const tool = /^(?:__|\.)(.+)$/.exec(rest)?.[1];
  return tool !== undefined && BOARD_TOOL_VERBS.has(tool) ? tool : undefined;
}

/** One board call, as much of it as the activity carried. */
export interface BoardCall {
  /** The board tool's own name, with the provider's server prefix stripped. */
  readonly tool: string;
  /** The call's arguments, when the activity carried them. */
  readonly input?: Record<string, unknown>;
  /** The one-line result summary T3 projected, when the call has answered. */
  readonly result?: string;
  /** The call answered with a refusal (`isError`, which T3 records as a failed item). */
  readonly refused: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The result summary out of either projected shape: `data.item.result` or `data.result`. */
function resultText(data: Record<string, unknown> | undefined): string | undefined {
  const item = asRecord(data?.item);
  return (
    stringField(asRecord(item?.result), "content") ?? stringField(asRecord(data?.result), "content")
  );
}

/** What a tool activity's `payload` looks like to this module. */
export interface BoardCallSource {
  readonly summary: string;
  readonly payload: unknown;
}

/**
 * Read one activity as a board call, or `undefined` when it is not one.
 *
 * Three sources in preference order, each a real field of T3's projected payload rather
 * than a reconstruction: the MCP item's own `server`/`tool`, the adapter's `data.toolName`,
 * and — last — the `<toolName>: <input>` detail line, which is all a provider that fills
 * neither would leave behind.
 */
export function boardCallOf(activity: BoardCallSource): BoardCall | undefined {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const server = stringField(item, "server");
  const itemTool = stringField(item, "tool");
  const named = stringField(data, "toolName") ?? stringField(payload, "detail")?.split(": ")[0];
  const tool =
    server === BOARD_MCP_SERVER_NAME && itemTool !== undefined && BOARD_TOOL_VERBS.has(itemTool)
      ? itemTool
      : named === undefined
        ? undefined
        : boardToolFromProviderName(named);
  if (tool === undefined) return undefined;
  const input = asRecord(item?.arguments) ?? asRecord(data?.input);
  const result = resultText(data);
  const status = stringField(payload, "status") ?? stringField(item, "status");
  return {
    tool,
    ...(input === undefined ? {} : { input }),
    ...(result === undefined ? {} : { result }),
    refused: status === "failed" || status === "declined",
  };
}

/** `add_step` → `step`, `update_noise_verdict` → `noise verdict`. */
function nounOf(tool: string): string {
  return tool.replace(/^(?:add|update)_/, "").replace(/_/g, " ");
}

/** `src/foo.ts:41-58` from a citation's arguments, or nothing when they are not there. */
function citedSpan(input: Record<string, unknown> | undefined, repoRoot?: string): string {
  const path = stringField(input, "path");
  if (path === undefined) return "";
  const relative =
    repoRoot === undefined || repoRoot === ""
      ? path
      : path.startsWith(repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`)
        ? path.slice((repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`).length)
        : path;
  const start = input?.start_line;
  const end = input?.end_line;
  if (typeof start !== "number") return relative;
  return typeof end === "number" && end !== start
    ? `${relative}:${start}-${end}`
    : `${relative}:${start}`;
}

/**
 * How many pointers a `finish` came back with, read off Rennet's OWN result sentence.
 *
 * `describeOutcome` writes `not settled — N to fix, then call finish again:` when the
 * whole-board check has work outstanding, and T3's projection keeps that first line. So
 * this parses a string this daemon wrote; a shape it did not write is left alone rather
 * than guessed at.
 */
function pointerCount(result: string | undefined): number | undefined {
  const match = /^not settled — (\d+) to fix/.exec(result ?? "");
  const parsed = Number(match?.[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * One board call in plain words — the receipt.
 *
 * `ordinal` is the seat's own count of this tool within the turn (1 for the first
 * `add_step`, 2 for the next), which is where "added step 3" comes from: the board mints
 * ids and nothing in the call says which step it is, so the only honest number is the one
 * the thread itself shows. Omit it and the line simply names the thing without a number.
 */
export function boardReceipt(
  call: BoardCall,
  options: { readonly ordinal?: number; readonly repoRoot?: string } = {},
): string {
  const answered = call.result !== undefined || call.refused;
  const entry = BOARD_TOOL_VERBS.get(call.tool);
  const noun = nounOf(call.tool);
  const at = options.ordinal === undefined ? "" : ` ${options.ordinal}`;
  if (call.refused) {
    // A refusal is the seat's to answer inside the same turn (D6), and it is also the most
    // useful thing the line can say while it does: the refusal's own first sentence, which
    // the board wrote to be read.
    return call.result === undefined ? `\`${call.tool}\` was refused` : `refused: ${call.result}`;
  }
  if (call.tool === "write_board") {
    // Read off Rennet's OWN result sentence, exactly as the `finish` arm below does — the
    // payload is a whole board as JSON and is the one thing this line must never show
    // (#819's `StructuredOutput: {"elements":[…` is precisely this defect).
    const wrote = /^wrote (\d+)/.exec(call.result ?? "")?.[1];
    const refused = /^wrote \d+, refused (\d+)/.exec(call.result ?? "")?.[1];
    if (!answered || wrote === undefined) return "writing the whole board";
    if (refused !== undefined) return `wrote ${wrote}, ${refused} refused`;
    return `wrote the board — ${wrote} elements`;
  }
  if (call.tool === "finish") {
    const pointers = pointerCount(call.result);
    if (pointers !== undefined) {
      return `finish returned ${pointers} pointer${pointers === 1 ? "" : "s"}`;
    }
    return answered ? "finished the board" : "finishing the board";
  }
  if (call.tool === "settle_absent") {
    return answered ? "settled this lens absent" : "settling this lens absent";
  }
  if (call.tool === "set_document") {
    return answered ? "wrote the board's opening" : "writing the board's opening";
  }
  if (call.tool === "remove_element") {
    const target = stringField(call.input, "element_id");
    const named = target === undefined ? "an element" : `\`${target}\``;
    return answered ? `removed ${named}` : `removing ${named}`;
  }
  if (entry?.kind === "code_ref") {
    const span = citedSpan(call.input, options.repoRoot);
    const subject = span === "" ? "" : ` \`${span}\``;
    if (entry.verb === "update")
      return answered ? `revised a citation${subject}` : `revising a citation${subject}`;
    return answered ? `cited${subject}` : `citing${subject}`;
  }
  if (entry?.verb === "update") {
    const target = stringField(call.input, "element_id");
    const subject = target === undefined ? noun : `${noun} \`${target}\``;
    return answered ? `revised ${subject}` : `revising ${subject}`;
  }
  return answered ? `added ${noun}${at}` : `adding ${noun}${at}`;
}
