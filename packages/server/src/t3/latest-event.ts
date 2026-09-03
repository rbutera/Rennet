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

/** The honest cap on every projected line, including the `…` marker. */
export const LATEST_EVENT_MAX_CHARS = 120;

/** Nothing new for this long and the line says so instead of freezing on a stale one. */
export const LATEST_EVENT_IDLE_AFTER_MS = 20_000;

/** The fields this projector reads from `OrchestrationThreadActivity`. */
export interface ThreadActivityLike {
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly turnId: string | null;
  readonly createdAt: string;
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

/** A tool activity in plain words: "reading src/foo.ts", "running git diff --stat". */
export function toolLine(activity: ThreadActivityLike, repoRoot?: string): string {
  const detail = detailOf(activity);
  if (detail === undefined) return capLine(activity.summary);
  const { tool, rest } = splitToolDetail(detail);
  const verb = TOOL_VERBS[tool.toLowerCase()];
  const subject = toolSubject(rest, repoRoot);
  // No verb for this tool: show T3's own detail rather than invent one.
  if (verb === undefined) return capLine(detail);
  return capLine(subject === "" ? verb : `${verb} ${subject}`);
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

  let best: { readonly at: number; readonly line: string; readonly kind: "tool" | "text" } | null =
    null;
  const consider = (at: number, kind: "tool" | "text", line: string): void => {
    if (line === "") return;
    if (best === null || at >= best.at) best = { at, kind, line };
  };

  for (const activity of thread.activities) {
    if (activity.tone !== "tool" || !inTurn(activity.turnId)) continue;
    consider(timeOf(activity.createdAt), "tool", toolLine(activity, options.repoRoot));
  }
  for (const message of thread.messages) {
    if (message.role !== "assistant" || !inTurn(message.turnId)) continue;
    consider(timeOf(message.updatedAt), "text", capLine(lastSentence(message.text)));
  }

  if (best === null) return undefined;
  const found: { readonly at: number; readonly line: string; readonly kind: "tool" | "text" } =
    best;
  const idleAfterMs = options.idleAfterMs ?? LATEST_EVENT_IDLE_AFTER_MS;
  const quietMs = now - found.at;
  if (quietMs >= idleAfterMs) {
    return { kind: "idle", text: `quiet for ${Math.floor(quietMs / 1000)} s`, at: now };
  }
  return { kind: found.kind, text: found.line, at: found.at };
}
