// The live line a lens lane shows while its seat thread runs (t3-lens-threads 2.2).
//
// PURE. Input is a T3 thread projection (the shape `subscribeThread` yields); output is
// the protocol's `LaneLatest` — a tool call in flight, the last sentence the seat said,
// or `idle` when the thread has been quiet. No Effect and no `@t3tools` import: the
// structural interfaces below are what `OrchestrationThread` already satisfies, so this
// module stays outside the one-seam rule and stays testable on plain objects.
//
// It never invents freshness: `at` is the timestamp of the thing it read (or `now` for
// idle), so a surface can tell a stale line from a fresh one.
//
// Docs: docs/developing/concepts/t3code-sidecar.md

import type { LaneLatest } from "@rennet/protocol";
import { boardCallOf, boardReceipt } from "./board-receipt";

/** The honest cap on every projected line, including the `…` marker. */
export const LATEST_EVENT_MAX_CHARS = 120;

/** Nothing new for this long and the line says so instead of freezing on a stale one. */
export const LATEST_EVENT_IDLE_AFTER_MS = 20_000;

/**
 * How coarsely the idle line counts (review finding 7).
 *
 * "quiet for N s" at one-second resolution is a DIFFERENT STRING every second, and a lane's
 * live line is republished by re-sending the whole `SessionPreparation` snapshot. Five idle
 * lanes therefore pushed five whole snapshots a second for as long as a generation ran, to
 * tell a reviewer a number they cannot read that fast. Ten-second steps say the same thing.
 */
export const LATEST_EVENT_IDLE_STEP_MS = 10_000;

/** The fields this projector reads from `OrchestrationThreadActivity`. */
export interface ThreadActivityLike {
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly turnId: string | null;
  readonly createdAt: string;
  /** The activity's own event id. Only used to group tool rows when `toolCallId` is absent. */
  readonly id?: string;
}

/**
 * A tool call that has finished, whatever it finished as.
 *
 * T3 emits started, updated and completed tool activities with the SAME `tool` tone
 * (`ProviderRuntimeIngestion.ts`), so tone alone cannot tell "reading src/foo.ts" from
 * "read src/foo.ts, done" — and a lane that says a finished call is in flight is a lie in
 * the UI (review finding 5). The lifecycle is in `kind` and in the runtime's own item
 * status (`inProgress | completed | failed | declined`).
 */
const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "declined"]);

function toolPayloadField(activity: ThreadActivityLike, key: string): string | undefined {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isTerminalTool(activity: ThreadActivityLike): boolean {
  if (activity.kind === "tool.completed") return true;
  const status = toolPayloadField(activity, "status");
  return status !== undefined && TERMINAL_TOOL_STATUSES.has(status);
}

/** The fields this projector reads from `OrchestrationMessage`. */
export interface ThreadMessageLike {
  readonly role: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly updatedAt: string;
}

/** The fields this projector reads from `OrchestrationThread`. */
export interface ThreadLike {
  readonly latestTurn: { readonly turnId: string } | null;
  readonly activities: readonly ThreadActivityLike[];
  readonly messages: readonly ThreadMessageLike[];
}

export interface LatestEventOptions {
  /** Stripped from an absolute path so the line reads `src/foo.ts`, not `/Users/…/src/foo.ts`. */
  readonly repoRoot?: string;
  readonly idleAfterMs?: number;
  /** Resolution of the idle count; see {@link LATEST_EVENT_IDLE_STEP_MS}. */
  readonly idleStepMs?: number;
}

/**
 * Tool name → the plain word for what it is doing. A tool not in this table keeps T3's
 * own summary rather than being given an invented verb — a wrong verb is a lie in the UI.
 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  read: "reading",
  view: "reading",
  notebookread: "reading",
  bash: "running",
  bashoutput: "running",
  shell: "running",
  edit: "editing",
  write: "editing",
  multiedit: "editing",
  notebookedit: "editing",
  applypatch: "editing",
  grep: "searching",
  glob: "searching",
  search: "searching",
  websearch: "searching",
};

/** The first string field of a tool's parsed input that names what it is acting on. */
const TOOL_SUBJECT_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "pattern",
  "query",
  "url",
] as const;

/** Collapse whitespace and cap at {@link LATEST_EVENT_MAX_CHARS} with an honest marker. */
export function capLine(text: string, max: number = LATEST_EVENT_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The last sentence of a block of prose, or the whole of it when it has only one. */
export function lastSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const parts = flat.split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== "");
  return parts.at(-1) ?? flat;
}

/**
 * The tools a seat calls to HAND BACK its board rather than to act on the change. Their
 * input is the board, so the detail line is a document, not a sentence.
 */
const STRUCTURED_OUTPUT_TOOLS: ReadonlySet<string> = new Set([
  "structuredoutput",
  "structured_output",
  "structured-output",
]);

/**
 * Is this text a JSON object — the call's own input — rather than something a reviewer can
 * read? A payload still streaming its `input_json_delta` counts too: half an object on the
 * bench is the same defect as a whole one (#819, where Noise's live line read
 * `{"document":null,"elements":[]}` and Decisions' read `StructuredOutput: {"elements":[…`).
 */
function isJsonPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return true;
  }
}

/** T3 writes a tool activity's detail as `<toolName>: <command or JSON input>`. */
function splitToolDetail(detail: string): { readonly tool: string; readonly rest: string } {
  const at = detail.indexOf(": ");
  if (at === -1) return { tool: detail.trim(), rest: "" };
  return { tool: detail.slice(0, at).trim(), rest: detail.slice(at + 2) };
}

function relativize(value: string, repoRoot: string | undefined): string {
  if (repoRoot === undefined || repoRoot === "") return value;
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** What the tool is acting on: a command verbatim, or the first naming field of its input. */
function toolSubject(rest: string, repoRoot: string | undefined): string {
  const trimmed = rest.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of TOOL_SUBJECT_KEYS) {
          const value = record[key];
          if (typeof value === "string" && value.trim() !== "") {
            return relativize(value.trim(), repoRoot);
          }
        }
      }
    } catch {
      // A tool call still streaming its `input_json_delta` has partial JSON. The raw
      // fragment is more honest than a guess at what it will become.
    }
  }
  return relativize(trimmed, repoRoot);
}

function detailOf(activity: ThreadActivityLike): string | undefined {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object") return undefined;
  const detail = (payload as { readonly detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim() !== "" ? detail : undefined;
}

/**
 * A tool activity in plain words: "reading src/foo.ts", "running git diff --stat".
 *
 * NEVER the call's JSON input. A seat's line is its SPEECH, and a serialized board dropped
 * into that slot is not speech — it is the payload the seat is handing over, rendered where
 * the reviewer expects a sentence (#819). So a structured-output call reads as the receipt
 * it is, an unknown tool whose input is JSON reads as its own name, and a payload with no
 * tool name in front of it contributes NO line at all, leaving the seat's prose to speak.
 */
export function toolLine(
  activity: ThreadActivityLike,
  repoRoot?: string,
  /** This tool's own count within the turn, for the receipt's "added step 3" (task 4.2). */
  ordinal?: number,
): string {
  // The BOARD ARM, ahead of everything below it (D11, task 4.2). A board call's input is
  // the element the seat is writing, so every path further down this function would render
  // it as `<toolName>: <json>` — the payload in the slot the reviewer reads as speech,
  // which is #819 arriving one call at a time. See `board-receipt.ts`.
  const call = boardCallOf(activity);
  if (call !== undefined) {
    return capLine(
      boardReceipt(call, {
        ...(ordinal === undefined ? {} : { ordinal }),
        ...(repoRoot === undefined ? {} : { repoRoot }),
      }),
    );
  }
  const detail = detailOf(activity);
  if (detail === undefined) return capLine(activity.summary);
  const { tool, rest } = splitToolDetail(detail);
  if (STRUCTURED_OUTPUT_TOOLS.has(tool.toLowerCase())) return "returning the board";
  const verb = TOOL_VERBS[tool.toLowerCase()];
  const subject = toolSubject(rest, repoRoot);
  if (verb === undefined) {
    // No verb for this tool: show T3's own detail rather than invent one — unless that
    // detail is the input itself. Then the tool's NAME is the most this line can honestly
    // say, and a detail that is nothing but the payload leaves T3's summary to say it (or,
    // when the summary is a payload too, says nothing and yields to the seat's own words).
    if (isJsonPayload(rest)) return capLine(tool);
    if (isJsonPayload(detail)) {
      const summary = capLine(activity.summary);
      return isJsonPayload(summary) ? "" : summary;
    }
    return capLine(detail);
  }
  // A known verb with a JSON blob for a subject keeps the verb alone: "editing" says more
  // than "editing {"old_string":…}" and says nothing false.
  return capLine(subject === "" || isJsonPayload(subject) ? verb : `${verb} ${subject}`);
}

const timeOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * The newest thing this thread's latest turn is doing, in plain words.
 *
 * Returns `undefined` when the thread has produced nothing at all yet — a lane with no
 * line is honest; a lane with an invented one is not.
 */
export function projectLatestEvent(
  thread: ThreadLike,
  now: number,
  options: LatestEventOptions = {},
): LaneLatest | undefined {
  const turnId = thread.latestTurn?.turnId;
  // Scoped to the latest turn when there is one, so a repair turn never shows the
  // drafting turn's last line. A thread with no turn yet reads everything it has.
  const inTurn = (candidateTurnId: string | null): boolean =>
    turnId === undefined || candidateTurnId === turnId;

  // Which tool CALLS have finished. Grouped by the runtime's own item id, because the
  // finishing activity is a separate row from the one that said the call started: without
  // the grouping, "reading src/foo.ts" outlives the read it describes.
  const finishedCalls = new Set<string>();
  for (const activity of thread.activities) {
    if (activity.tone !== "tool" || !isTerminalTool(activity)) continue;
    finishedCalls.add(toolPayloadField(activity, "toolCallId") ?? activity.id ?? "");
  }
  const inFlight = (activity: ThreadActivityLike): boolean =>
    !isTerminalTool(activity) &&
    !finishedCalls.has(toolPayloadField(activity, "toolCallId") ?? activity.id ?? "");

  let best: { readonly at: number; readonly line: string; readonly kind: "tool" | "text" } | null =
    null;
  // The newest thing the turn did AT ALL, finished calls included. Idleness is a fact about
  // the thread, not about the line on screen: a seat whose last act was a completed tool is
  // working, not quiet, even though that tool is no longer what it is doing.
  let newestAt: number | null = null;
  const consider = (at: number, kind: "tool" | "text", line: string): void => {
    if (line === "") return;
    if (best === null || at >= best.at) best = { at, kind, line };
  };
  const witness = (at: number): void => {
    if (newestAt === null || at > newestAt) newestAt = at;
  };

  // A board call's ordinal within the turn — the "3" in "added step 3". Keyed on the
  // runtime's own call id, so the started/updated/completed rows of ONE call share one
  // number instead of counting to three. An activity with no call id gets no ordinal at
  // all: the line then names the thing without a number, which is the honest degrade —
  // a number derived from rows rather than calls would be wrong and would look right.
  const boardOrdinal = new Map<string, number>();
  const boardCalls = new Map<string, number>();

  for (const activity of thread.activities) {
    if (activity.tone !== "tool" || !inTurn(activity.turnId)) continue;
    const at = timeOf(activity.createdAt);
    witness(at);
    // A BOARD call speaks whether or not it has finished (D11, task 4.2). The daemon
    // answers one in microseconds, so its in-flight window is invisible to a reviewer, and
    // what they want from the line is not what the seat is waiting on but what it just put
    // on the board. Every other tool keeps the in-flight rule: a finished `Read` is no
    // longer what the seat is doing, and saying it is would be a lie in the UI.
    const call = boardCallOf(activity);
    if (call !== undefined) {
      const callId = toolPayloadField(activity, "toolCallId");
      let ordinal: number | undefined;
      if (callId !== undefined) {
        ordinal = boardOrdinal.get(callId);
        if (ordinal === undefined) {
          ordinal = (boardCalls.get(call.tool) ?? 0) + 1;
          boardCalls.set(call.tool, ordinal);
          boardOrdinal.set(callId, ordinal);
        }
      }
      consider(at, "tool", toolLine(activity, options.repoRoot, ordinal));
      continue;
    }
    // A completed or denied call falls back to whatever the seat is saying instead.
    if (!inFlight(activity)) continue;
    consider(at, "tool", toolLine(activity, options.repoRoot));
  }
  for (const message of thread.messages) {
    if (message.role !== "assistant" || !inTurn(message.turnId)) continue;
    const at = timeOf(message.updatedAt);
    witness(at);
    consider(at, "text", capLine(lastSentence(message.text)));
  }

  const idleAfterMs = options.idleAfterMs ?? LATEST_EVENT_IDLE_AFTER_MS;
  if (newestAt !== null && now - newestAt >= idleAfterMs) {
    // Counted in coarse steps so an idle lane does not republish its whole snapshot once a
    // second to change one digit (review finding 7).
    const step = options.idleStepMs ?? LATEST_EVENT_IDLE_STEP_MS;
    const quiet = Math.floor((now - newestAt) / step) * Math.floor(step / 1000);
    return { kind: "idle", text: `quiet for ${quiet} s`, at: now };
  }
  if (best === null) return undefined;
  const found: { readonly at: number; readonly line: string; readonly kind: "tool" | "text" } =
    best;
  return { kind: found.kind, text: found.line, at: found.at };
}
