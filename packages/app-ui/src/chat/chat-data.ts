import type {
  AskProjection,
  ReattachResult,
  ReviewAskStreamEvent,
  SessionTranscriptRow,
  TurnStatus,
  ActivityStep as WireActivityStep,
  TranscriptBlock as WireTranscriptBlock,
} from "@rennet/protocol";
import type { LucideIcon } from "lucide-react";
import { Bot, FilePen, FileText, Plug, Search, TerminalSquare, Wrench } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useRoute, useSearch } from "wouter";
import { commandKey, readCommandId, useCommand, useCommandStream, useMutation } from "../data";
import { useBridgeContext } from "../data/bridge";
import type { CommandCache } from "../data/cache";
import { reviewIdOf, useSlugResolution } from "../routes/slug";
import { ROUTES, readSessionQuery } from "../routes/url";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The chat dock's SINGLE data-resolution point (C07, proposal reconciliation 3), the
// same one-file-per-surface shape as `shell/sidebar-data.ts` and `review/citations.ts`.
// The dock takes no transcript props; every row it renders, every stream it folds, and
// every send resolve HERE. Two lifetimes in one file:
//
//  • LIVE NOW (dispatch-bound #251): the reviewer's ask travels as `review.ask`
//    (useMutation); the persisted ask-thread transcript reloads via `review.reattach`
//    (useCommand); the live turn's tokens fold from `onAskStream` into that same read
//    (useCommandStream), reducing `ask-delta` (append, seq-guarded) / `ask-complete`
//    (settle) / `ask-interrupted`. Tests drive this through `MemoryBridge.emitAskStream`.
//
//  • The HISTORICAL session transcript — the orchestrator's coding turns (thought
//    blocks, action steps, prose), the compaction boundaries, the context-rebuilt
//    markers — reloads via `session.transcript` (useCommand), keyed on the SAME review
//    the live half is. The turn loop captures every round's harness events and persists
//    them; this read is what puts them in front of the reviewer. Until it existed the
//    daemon fsynced coding turns to disk that nothing could ever display.
//
//    #466 res. 3 does NOT forbid this. It makes the harness CLI canonical for RESUME —
//    Rennet persists a `HarnessCursor`, not a conversation — and in the same breath
//    requires compaction be surfaced honestly, as a boundary row in the turn stream.
//    A turn stream nobody renders cannot surface anything. The rows are a display
//    read-model layered over the cursor, not a second source of truth.
//
//    `SessionTranscriptProjection` stays as an OVERRIDE seam for a host or a test that
//    mounts the dock outside a session route: every field is optional, and a field it
//    does not supply falls through to this read. The live dock resolves its review from
//    the route (`useRouteReviewId`), never from that context.
//
// No filesystem access; imports only `@rennet/protocol` types and `../data`.
// ─────────────────────────────────────────────────────────────────────────────

export type Speaker = "user" | "orchestrator";
/** A turn / block's lifecycle, reused from the wire (`streaming`/`complete`/`interrupted`). */
export type { TurnStatus };

/** A collapsing "Thinking → Thought for Ns" block. Its live/settled look follows the
 *  turn's real `status` (reconciliation 2), never a self-timed `setTimeout`. */
export interface ThoughtBlockData {
  readonly kind: "thought";
  readonly id: string;
  readonly status: TurnStatus;
  readonly seconds?: number;
  readonly text: readonly string[];
}

/** A running-spinner → done-label action step. `status` drives running vs done. */
export interface ActionStepData {
  readonly kind: "action";
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly status: TurnStatus;
  /** Label to switch to once a `streaming` step settles. */
  readonly doneLabel?: string;
  /** Detail to switch to once a `streaming` step settles. */
  readonly doneDetail?: string;
  readonly icon: LucideIcon;
}

export type ActivityStep = ThoughtBlockData | ActionStepData;

export interface ProseBlock {
  readonly kind: "text";
  readonly text: string;
}

export interface CodeBlockData {
  readonly kind: "code";
  readonly path: string;
  readonly lang?: string;
  readonly code: string;
  readonly startLine?: number;
  readonly highlightLines?: readonly number[];
}

export type ContentBlock = ProseBlock | CodeBlockData;
export type TranscriptBlock = ActivityStep | ContentBlock;

/** One transcript turn — a user bubble or an orchestrator turn (lead prose, activity
 *  preface, body of prose/code blocks). */
export interface TurnRow {
  readonly kind: "turn";
  readonly id: string;
  readonly speaker: Speaker;
  readonly status: TurnStatus;
  readonly paragraphs: readonly string[];
  /** A muted timestamp, when the source carries one — never fabricated for a live turn. */
  readonly time?: string;
  readonly lead?: string;
  readonly preface?: readonly ActivityStep[];
  /** Richer reply content (prose interleaved with code blocks); takes precedence over `paragraphs`. */
  readonly body?: readonly ContentBlock[];
  /** Exact event order for current rows; legacy preface/body remain readable. */
  readonly blocks?: readonly TranscriptBlock[];
}

/** A `compact_boundary` timeline row — the harness compacted the session here. The
 *  context figures are the harness's own; absent ⇒ rendered honestly as "unknown". */
export interface CompactBoundaryRow {
  readonly kind: "compact-boundary";
  readonly id: string;
  /** Tokens held before the compaction, as the harness reported them (or absent). */
  readonly tokensBefore?: number;
  /** Tokens held after the compaction (or absent). */
  readonly tokensAfter?: number;
  readonly time?: string;
}

/** An anchored-thread row — a `review.quoteThreads` thread rendered transcript-side,
 *  keyed by the board ref that points at it (#466, reconciliation 6). The content is
 *  read from the store by the component; the board marker is C5's. */
export interface AnchoredThreadRow {
  readonly kind: "anchored-thread";
  /** The quote-thread id in `review.quoteThreads`. */
  readonly threadId: string;
  /** The board ref that anchors the thread (a stable id the board owns). */
  readonly boardRef: string;
}

export interface DetachedThreadRef {
  readonly threadId: string;
  /** The last real board target retained by the detached durable thread. */
  readonly boardRef: string;
}

/** One transcript group for every durable thread whose exact quote no longer re-anchors. */
export interface DetachedThreadsRow {
  readonly kind: "detached-threads";
  readonly threads: readonly DetachedThreadRef[];
}

/** A `context-rebuilt` marker — the harness no longer had the conversation Rennet's cursor
 *  pointed at, so the turn ran on a fresh session. Dropping it would let the transcript read
 *  as one unbroken conversation across a real discontinuity. */
export interface ContextRebuiltRow {
  readonly kind: "context-rebuilt";
  readonly id: string;
  readonly reason: string;
}

export type TranscriptRow =
  | TurnRow
  | CompactBoundaryRow
  | AnchoredThreadRow
  | DetachedThreadsRow
  | ContextRebuiltRow;

// ── The wire transcript → the dock's rows ─────────────────────────────────────

/** The wire's serializable `toolKind` → the icon the dock draws. Protocol never carries a
 *  component (`ActionStepSchema.toolKind` is the selector), so the mapping lands here. */
const TOOL_ICONS: Record<Extract<WireActivityStep, { kind: "action" }>["toolKind"], LucideIcon> = {
  read: FileText,
  write: FilePen,
  exec: TerminalSquare,
  search: Search,
  mcp: Plug,
  subagent: Bot,
  other: Wrench,
};

function activityStepOf(step: WireActivityStep): ActivityStep {
  return step.kind === "thought" ? step : { ...step, icon: TOOL_ICONS[step.toolKind] };
}

function transcriptBlockOf(block: WireTranscriptBlock): TranscriptBlock {
  return block.kind === "action" ? activityStepOf(block) : block;
}

/** Project the persisted `session.transcript` rows onto the dock's rows. The only real
 *  difference is the action step's icon; everything else is the same shape by construction. */
export function transcriptRowsOf(rows: readonly SessionTranscriptRow[]): TranscriptRow[] {
  return rows.map((row) => {
    if (row.kind !== "turn") return row;
    const { preface, blocks, ...rest } = row;
    return {
      ...rest,
      ...(preface === undefined ? {} : { preface: preface.map(activityStepOf) }),
      ...(blocks === undefined ? {} : { blocks: blocks.map(transcriptBlockOf) }),
    };
  });
}

/** The dock header's session trail. Honest-minimal: with no projection supplied the
 *  header shows the title alone; a host or test that supplies one fills project/target. */
export interface ChatTrail {
  readonly title: string;
  readonly projectName?: string;
  readonly target?: "your-branch" | "your-pr" | "teammate-pr";
  readonly targetState?: "needs-you" | "merged" | "reviewed";
}

/** The harness-reported context window — the ask-don't-estimate meter reads this. Absent
 *  ⇒ the meter shows "unknown" (Rennet NEVER estimates a token budget, reconciliation 7). */
export interface ContextWindow {
  readonly used: number;
  readonly limit: number;
}

// ── The session-transcript OVERRIDE context (reconciliation 3) ────────────────

export interface SessionTranscriptProjection {
  /** A review-id OVERRIDE for a host or a test that mounts the dock outside a session
   *  route. Absent in normal use: the dock resolves the live review from the route itself
   *  (`useRouteReviewId`), so this is a deliberate injection point, not the live path. */
  readonly reviewId?: string;
  /** Historical session rows, REPLACING the `session.transcript` read. Absent (the live
   *  app) ⇒ the dock reads the persisted coding turns from the daemon. */
  readonly rows?: readonly TranscriptRow[];
  /** The header trail, replacing the served one. Absent ⇒ the daemon's identity trail. */
  readonly trail?: ChatTrail;
  /** The harness-reported context figure, replacing the served one. Absent on BOTH ⇒ the
   *  meter reads "unknown" — Rennet never estimates a token budget. */
  readonly contextWindow?: ContextWindow;
}

/** The default projection: NO override at all. The dock resolves its review from the route
 *  and its history from `session.transcript`. */
export const EMPTY_TRANSCRIPT: SessionTranscriptProjection = {};

const SessionTranscriptContext = createContext<SessionTranscriptProjection>(EMPTY_TRANSCRIPT);
/** Wraps a mount to OVERRIDE the session transcript + review id (hosts and tests that mount
 *  the dock outside a session route). The live app mounts the dock bare and resolves the
 *  review from the route. */
export const SessionTranscriptProvider = SessionTranscriptContext.Provider;
export function useSessionTranscript(): SessionTranscriptProjection {
  return useContext(SessionTranscriptContext);
}

// ── The live ask-stream fold (reconciliation 3, dispatch-bound #251) ──────────

/** Split a message body into display paragraphs; a streaming body stays one growing
 *  paragraph until it settles. Empty ⇒ no paragraphs (an activity-only turn). */
function splitParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trimEnd())
    .filter((p) => p.length > 0);
}

type ReattachThread = ReattachResult["threads"][number];
type InFlightTurn = ReattachResult["inFlight"][number];

// `foldAskStream` returns a FRESH `ReattachResult` per `ask-delta`, but it rebuilds only what
// the event touched: `{ ...base, inFlight: … }` keeps the `threads` array and every settled
// thread object by reference, and the `inFlight.map` keeps every turn but the one streaming.
// Keying the derivation on those object identities is therefore enough to make a delta cost
// O(the live turn) instead of re-splitting every paragraph in the transcript (perf audit §3
// H2 — the "long sessions melt" quadratic). WeakMaps, so a superseded snapshot is collectable
// with its rows and nothing has to be invalidated by hand.
const threadRows = new WeakMap<ReattachThread, TranscriptRow[]>();
const inFlightRows = new WeakMap<InFlightTurn, TranscriptRow[]>();

/** A live in-flight turn → a streaming orchestrator `TurnRow`. Memoized on the turn object:
 *  a delta mints a new one, every other in-flight turn keeps its rows. */
function inFlightToRows(turn: InFlightTurn): TranscriptRow[] {
  const cached = inFlightRows.get(turn);
  if (cached) return cached;
  const rows: TranscriptRow[] =
    turn.rows && turn.rows.length > 0
      ? transcriptRowsOf(turn.rows)
      : [
          {
            kind: "turn",
            id: `${turn.turnId}::${turn.channel}`,
            speaker: "orchestrator",
            status: "streaming",
            paragraphs: splitParagraphs(turn.bodySoFar),
            ...(turn.time === undefined ? {} : { time: turn.time }),
          },
        ];
  inFlightRows.set(turn, rows);
  return rows;
}

/** One settled thread's messages → turn rows. Memoized on the thread object, which
 *  `foldAskStream` only replaces for the thread an event actually changed. */
function threadToRows(thread: ReattachThread): TranscriptRow[] {
  const cached = threadRows.get(thread);
  if (cached) return cached;
  const rows: TranscriptRow[] = [];
  for (const message of thread.messages) {
    if (message.rows && message.rows.length > 0) appendAll(rows, transcriptRowsOf(message.rows));
    else
      rows.push({
        kind: "turn",
        id: message.id,
        speaker: message.author === "you" ? "user" : "orchestrator",
        status: message.status ?? "complete",
        paragraphs: splitParagraphs(message.body),
        ...(message.time === undefined ? {} : { time: message.time }),
      });
  }
  threadRows.set(thread, rows);
  return rows;
}

/** `push(...rows)` spreads a whole transcript through the argument list; a long session is
 *  exactly where that blows the stack. Copy by loop. */
function appendAll(into: TranscriptRow[], from: readonly TranscriptRow[]): void {
  for (const row of from) into.push(row);
}

/** The persisted ask-thread transcript → turn rows (settled threads, then live turns). */
export function reattachToRows(result: ReattachResult): TranscriptRow[] {
  // Index the live turns by thread ONCE: the pair of nested loops this replaces was
  // O(threads × inFlight) per delta.
  const inFlightByThread = new Map<string, InFlightTurn[]>();
  for (const turn of result.inFlight) {
    const queued = inFlightByThread.get(turn.threadId);
    if (queued) queued.push(turn);
    else inFlightByThread.set(turn.threadId, [turn]);
  }
  const rows: TranscriptRow[] = [];
  const known = new Set<string>();
  for (const thread of result.threads) {
    known.add(thread.threadId);
    appendAll(rows, threadToRows(thread));
    for (const turn of inFlightByThread.get(thread.threadId) ?? []) {
      appendAll(rows, inFlightToRows(turn));
    }
  }
  // A brand-new live ask whose thread was not in the reattach snapshot yet.
  for (const turn of result.inFlight) {
    if (!known.has(turn.threadId)) appendAll(rows, inFlightToRows(turn));
  }
  return rows;
}

/** Project the durable ask log's detached quote threads into one visible transcript group. */
export function detachedThreadRowsOf(threads: AskProjection["quoteThreads"]): DetachedThreadsRow[] {
  const detached = Object.entries(threads).flatMap(([threadId, thread]) =>
    thread.lifecycle === "detached" && thread.target !== undefined
      ? [{ threadId, boardRef: thread.target } satisfies DetachedThreadRef]
      : [],
  );
  return detached.length === 0 ? [] : [{ kind: "detached-threads", threads: detached }];
}

function transcriptRowKey(row: TranscriptRow): string {
  if (row.kind === "anchored-thread") return `anchored:${row.threadId}`;
  if (row.kind === "detached-threads") return row.kind;
  return `${row.kind}:${row.id}`;
}

function transcriptRowTime(row: TranscriptRow): number | undefined {
  if (
    row.kind === "anchored-thread" ||
    row.kind === "detached-threads" ||
    row.kind === "context-rebuilt" ||
    !row.time
  ) {
    return undefined;
  }
  const value = Date.parse(row.time);
  return Number.isFinite(value) ? value : undefined;
}

function transcriptRowDetail(row: TranscriptRow): number {
  if (row.kind !== "turn") return 0;
  return (
    (row.blocks?.length ?? 0) * 1000 +
    (row.preface?.length ?? 0) * 100 +
    (row.body?.length ?? 0) * 10 +
    row.paragraphs.length
  );
}

/**
 * Merge the durable harness log with persisted/live thread rows. Stable ids collapse the
 * two representations; the richer ordered row wins, while source timestamps put the
 * reviewer's question before the harness activity that answered it. Legacy rows without
 * timestamps retain their source order.
 */
export function mergeTranscriptRows(
  history: readonly TranscriptRow[],
  live: readonly TranscriptRow[],
): TranscriptRow[] {
  const merged = new Map<
    string,
    { row: TranscriptRow; firstIndex: number; time: number | undefined }
  >();
  for (const [index, row] of [...history, ...live].entries()) {
    const key = transcriptRowKey(row);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, { row, firstIndex: index, time: transcriptRowTime(row) });
      continue;
    }
    if (transcriptRowDetail(row) > transcriptRowDetail(prior.row)) prior.row = row;
    prior.time ??= transcriptRowTime(row);
  }
  const sourceOrdered = [...merged.values()].sort(
    (left, right) => left.firstIndex - right.firstIndex,
  );
  const nextTimed: Array<number | undefined> = new Array(sourceOrdered.length);
  let next: number | undefined;
  for (let index = sourceOrdered.length - 1; index >= 0; index--) {
    nextTimed[index] = next;
    const time = sourceOrdered[index]?.time;
    if (time !== undefined) next = time;
  }
  let previous: number | undefined;
  const chronological = sourceOrdered.map((entry, index) => {
    if (entry.time !== undefined) {
      previous = entry.time;
      return { ...entry, chronology: entry.time, phase: 0 };
    }
    if (previous !== undefined) return { ...entry, chronology: previous, phase: 1 };
    const following = nextTimed[index];
    return following === undefined
      ? { ...entry, chronology: Number.POSITIVE_INFINITY, phase: 0 }
      : { ...entry, chronology: following, phase: -1 };
  });
  return chronological
    .sort((left, right) => {
      if (left.chronology !== right.chronology) return left.chronology - right.chronology;
      if (left.phase !== right.phase) return left.phase - right.phase;
      return left.firstIndex - right.firstIndex;
    })
    .map(({ row }) => row);
}

const EMPTY_REATTACH: ReattachResult = { threads: [], inFlight: [] };

/** How much of the question is carried as the anchor's label. The anchor exists to key
 *  persistence, not to duplicate the message, so a long question is clipped rather than
 *  stored twice — the full text is the turn body. */
const ANCHOR_LABEL_CEILING = 120;

export interface ReviewerEcho {
  readonly threadId: string;
  readonly id: string;
  readonly body: string;
}

const pendingReviewerEchoes = new WeakMap<CommandCache, Map<string, ReviewerEcho[]>>();

/** The one optimistic reviewer-message fold used by the dock composer and anchored board asks. */
export function foldReviewerEcho(
  prev: ReattachResult | undefined,
  echo: ReviewerEcho,
): ReattachResult {
  const base = prev ?? EMPTY_REATTACH;
  return {
    ...base,
    threads: appendMessage(base, echo.threadId, {
      id: echo.id,
      author: "you",
      body: echo.body,
      status: "complete",
    }),
  };
}

function queueReviewerEcho(cache: CommandCache, key: string, echo: ReviewerEcho): void {
  let byKey = pendingReviewerEchoes.get(cache);
  if (!byKey) {
    byKey = new Map();
    pendingReviewerEchoes.set(cache, byKey);
  }
  const queued = byKey.get(key) ?? [];
  if (queued.some((candidate) => candidate.id === echo.id)) return;
  byKey.set(key, [...queued, echo]);
}

/** Fold immediately when the authoritative reattach read is settled; otherwise queue a replay
 * across that in-flight read, whose completion replaces the cache snapshot wholesale. */
export function enqueueReviewerEcho(cache: CommandCache, key: string, echo: ReviewerEcho): void {
  const snapshot = cache.getSnapshot(key);
  if (snapshot.data !== undefined) {
    cache.setData(key, (prev) => foldReviewerEcho(prev as ReattachResult | undefined, echo));
  }
  if (snapshot.fetching || snapshot.data === undefined) queueReviewerEcho(cache, key, echo);
}

/** Replay and clear echoes queued while `review.reattach` was fetching. Idempotent by message id. */
export function flushReviewerEchoes(cache: CommandCache, key: string): void {
  const byKey = pendingReviewerEchoes.get(cache);
  const queued = byKey?.get(key) ?? [];
  if (queued.length === 0) return;
  byKey?.delete(key);
  for (const echo of queued) {
    cache.setData(key, (prev) => foldReviewerEcho(prev as ReattachResult | undefined, echo));
  }
}

/** Deterministic cache identity shared by every producer that feeds `review.reattach`. */
export function reviewReattachInput(reviewId: string) {
  return {
    commandId: readCommandId(`review.reattach:${reviewId}`),
    reviewId,
  };
}

export function reviewReattachKey(reviewId: string): string {
  return commandKey("review.reattach", reviewReattachInput(reviewId));
}

/**
 * Fold one ask-stream event into the `review.reattach` read (reconciliation 3). The
 * reducer honours the monotonic `seq` on the one event that APPENDS (`ask-delta`) —
 * a replayed delta (a reconnect, a doubled broadcast) is rejected, matching the wire
 * contract; `ask-complete`/`ask-interrupted` are idempotent set-events keyed by turnId.
 * `seen` tracks the last applied seq per turn (the hook supplies a stable ref map).
 */
export function foldAskStream(
  prev: ReattachResult | undefined,
  event: ReviewAskStreamEvent,
  seen: Map<string, number>,
): ReattachResult {
  const base = prev ?? EMPTY_REATTACH;
  switch (event.kind) {
    case "ask-focus":
      // Focus is a scroll/highlight intent (the store owns `focusedThreadId`); it
      // carries no transcript content, so the read is unchanged.
      return base;
    case "ask-delta": {
      if (event.seq !== undefined) {
        const last = seen.get(event.turnId);
        if (last !== undefined && event.seq <= last) return base; // replay — reject
        seen.set(event.turnId, event.seq);
      }
      const existing = base.inFlight.find((t) => t.turnId === event.turnId);
      if (existing) {
        return {
          ...base,
          inFlight: base.inFlight.map((t) =>
            t.turnId === event.turnId ? { ...t, bodySoFar: t.bodySoFar + event.delta } : t,
          ),
        };
      }
      return {
        ...base,
        inFlight: [
          ...base.inFlight,
          {
            threadId: event.threadId,
            turnId: event.turnId,
            channel: event.channel,
            model: "",
            bodySoFar: event.delta,
          },
        ],
      };
    }
    case "ask-state": {
      if (event.seq !== undefined) {
        const last = seen.get(event.turnId);
        if (last !== undefined && event.seq <= last) return base;
        seen.set(event.turnId, event.seq);
      }
      const existing = base.inFlight.find((turn) => turn.turnId === event.turnId);
      if (existing) {
        return {
          ...base,
          inFlight: base.inFlight.map((turn) =>
            turn.turnId === event.turnId ? { ...turn, rows: event.rows } : turn,
          ),
        };
      }
      return {
        ...base,
        inFlight: [
          ...base.inFlight,
          {
            threadId: event.threadId,
            turnId: event.turnId,
            channel: event.channel,
            model: "",
            bodySoFar: "",
            rows: event.rows,
          },
        ],
      };
    }
    case "ask-complete": {
      seen.delete(event.turnId);
      const settled = base.inFlight.find((t) => t.turnId === event.turnId);
      const messageId = `${event.turnId}::${event.channel}`;
      if (!settled && threadHasTurn(base, event.threadId, messageId)) return base; // already settled
      return {
        inFlight: base.inFlight.filter((t) => t.turnId !== event.turnId),
        threads: appendMessage(base, event.threadId, {
          id: messageId,
          author: "harness",
          model: event.model,
          body: event.finalBody,
          status: "complete",
          ...(settled?.rows === undefined ? {} : { rows: settled.rows }),
        }),
      };
    }
    case "ask-interrupted": {
      seen.delete(event.turnId);
      const inflight = base.inFlight.find((t) => t.turnId === event.turnId);
      if (inflight) {
        return {
          inFlight: base.inFlight.filter((t) => t.turnId !== event.turnId),
          threads: appendMessage(base, event.threadId, {
            id: `${event.turnId}::${event.channel}`,
            author: "harness",
            model: "",
            body: inflight.bodySoFar,
            status: "interrupted",
            ...(inflight.rows === undefined ? {} : { rows: inflight.rows }),
          }),
        };
      }
      // No live turn to settle: mark an existing message interrupted, if present.
      return {
        ...base,
        threads: base.threads.map((thread) =>
          thread.threadId === event.threadId
            ? {
                ...thread,
                messages: thread.messages.map((m) =>
                  m.id === `${event.turnId}::${event.channel}`
                    ? { ...m, status: "interrupted" as const }
                    : m,
                ),
              }
            : thread,
        ),
      };
    }
  }
}

function threadHasTurn(result: ReattachResult, threadId: string, turnId: string): boolean {
  const thread = result.threads.find((t) => t.threadId === threadId);
  return thread?.messages.some((m) => m.id === turnId) ?? false;
}

/** Append a message to a thread, minting the thread with a conversation-fragment anchor
 *  when a live ask completed before its thread was ever reattached (an honest anchor —
 *  the wire's `fragment` kind, path-less, for a message-anchored fragment). */
function appendMessage(
  result: ReattachResult,
  threadId: string,
  message: ReattachResult["threads"][number]["messages"][number],
): ReattachResult["threads"] {
  const existing = result.threads.find((t) => t.threadId === threadId);
  if (existing) {
    // Idempotent by message id: a re-applied optimistic echo (settle-flush) or a doubled
    // settle never appends the same message twice.
    if (existing.messages.some((m) => m.id === message.id)) return result.threads;
    return result.threads.map((thread) =>
      thread.threadId === threadId
        ? { ...thread, messages: [...thread.messages, message] }
        : thread,
    );
  }
  return [
    ...result.threads,
    {
      threadId,
      anchor: { kind: "fragment" as const, label: "conversation", key: threadId },
      messages: [message],
    },
  ];
}

// ── The dock's resolved model (the single hook the dock reads) ────────────────

export interface ChatDockModel {
  /** The full ordered transcript: session rows then the live ask turns. */
  readonly rows: readonly TranscriptRow[];
  /** Turn ids that arrived live this mount — they animate; records replay instantly. */
  readonly liveIds: ReadonlySet<string>;
  readonly trail: ChatTrail;
  /** The harness context figure, or undefined (⇒ the meter reads "unknown"). */
  readonly contextWindow?: ContextWindow;
  /** True while an orchestrator turn is streaming — the presence affordance follows this. */
  readonly inFlight: boolean;
  /** Send the reviewer's question — fires `review.ask` and folds its stream (no staging: C8). */
  send(message: string): void;
  /**
   * Why the dock cannot send right now, or absent when it can. `review.ask` is keyed on a
   * review, so a session with none (a freshly minted chat-only session) has nothing to ask
   * ABOUT. The composer must say so rather than accept a question and drop it — an enabled
   * box that silently eats input is the exact failure this dock is being repaired for.
   */
  readonly unavailable?: string;
  /**
   * The opening ask handed over on the mint (`/s/:slug?ask=…`, C21). New Chat's composer
   * cannot send — the session does not exist until the click mints it — so the typed
   * question rides the URL instead of being swallowed. The composer seeds itself from
   * this so the reviewer lands looking at their own words, ready to send. Absent when the
   * route carries no ask.
   */
  readonly draft?: string;
}

/**
 * The review the dock is looking at, resolved from the ROUTE — the fix for a dock that
 * accepted a question and did nothing with it.
 *
 * The dock is mounted once by the layout, outside the outlet, so it cannot be handed a
 * review as a prop; it has to ask where it is. `/s/:slug` and `/s/:slug/run` are the two
 * routes that name a session (the same pair the layout gates the dock's visibility on).
 * Off both, there is no review and the dock is honestly empty.
 *
 * `useSlugResolution` — not the raw slug — is what answers, because the slug is a SESSION
 * id and a session may have no review attached. Guessing `reviewId = slug` would point
 * every read at a review that does not exist on a chat-only session and turn silence into
 * a "Review not found" error. `reviewIdOf` returns a review id only when one really
 * resolved. The read is shared: `useSlugResolution` keys `review.load` on a slug-derived
 * commandId, so the route screen and this hook hit ONE cache entry, not two fetches.
 */
export function useRouteReviewId(): string | undefined {
  const [onSession, sessionParams] = useRoute(ROUTES.session);
  const [, runParams] = useRoute(ROUTES.sessionRun);
  const raw = (onSession ? sessionParams?.slug : runParams?.slug) ?? "";
  const slug = raw === "" ? "" : decodeURIComponent(raw);
  return reviewIdOf(useSlugResolution(slug));
}

/**
 * Resolve the whole dock model. The review is resolved from the route (above); the live
 * half is the real `review.reattach` read with the ask stream folded into it. `send`
 * fires `review.ask`; the daemon streams the reply back over `onAskStream`, which the
 * fold above grows into a streaming turn and settles.
 */
export function useChatDock(): ChatDockModel {
  const projection = useSessionTranscript();
  const quoteThreads = useRennetStore((state) => state.review.quoteThreads);
  // The LIVE review id comes from the route: `/s/:slug` resolves the slug to a review
  // (or to a review-less chat-only session, which yields `undefined` — the dock then
  // stays honestly empty rather than reading a review that does not exist). The context
  // value stays an OVERRIDE so existing host/test mounts keep working unchanged.
  const routeReviewId = useRouteReviewId();
  const reviewId = projection.reviewId ?? routeReviewId;
  // The mint's opening ask (`?ask=`), read through the same query grammar the rest of
  // the session route uses — never re-parsed by hand here.
  const draft = readSessionQuery(new URLSearchParams(useSearch())).ask;
  // chat-data is the dock's single data-resolution point (see this file's header). It folds
  // THREE things into the one `review.reattach` entry the transcript reads: live deltas
  // (useCommandStream, below), the reviewer's optimistic echo, and the buffered pre-settle
  // deltas. The latter two are time-shifted folds the event-driven `useCommandStream` cannot
  // express, so they go through the same `cache.setData` primitive it uses — not `.invoke`.
  const { cache } = useBridgeContext();

  // A deterministic, stable commandId per review — `review.reattach` is idempotent, so no
  // uuid churn is needed (unlike a progress-correlated command). A fresh review key remints
  // it. It must nonetheless be a UUID: the wire's `commandIdSchema` is `z.uuid()`, so the
  // readable `reattach-${reviewId}` this used to send was rejected by the daemon and the
  // dock's own read came back an error on the real app — the transcript was empty because
  // it was never served, not because nothing was persisted.
  const reattachInput = useMemo(() => reviewReattachInput(reviewId ?? ""), [reviewId]);
  const reattachKey = useMemo(() => reviewReattachKey(reviewId ?? ""), [reviewId]);

  const { data, error, fetching } = useCommand("review.reattach", reattachInput, {
    enabled: reviewId !== undefined,
  });

  // The HISTORICAL half: the coding turns the session turn loop captured and persisted.
  // Same review id, separate read — `review.reattach` carries only the ask threads, so
  // without this the dock renders a conversation with every round the agent actually ran
  // missing from it. Read-only and idempotent, so no commandId and no invalidation: the
  // rows are appended by the daemon out of band, and a refetch here would clobber nothing
  // because it lands in its own cache entry, not reattach's.
  const transcriptInput = useMemo(() => ({ reviewId: reviewId ?? "" }), [reviewId]);
  const { data: session } = useCommand("session.transcript", transcriptInput, {
    enabled: reviewId !== undefined,
  });

  // Per-review live-fold state. `seenSeq` rejects replayed deltas by turn; `buffer` holds
  // stream events that arrive BEFORE the initial reattach settles; `optimistic` holds
  // reviewer echoes sent in that same pre-settle window. All reset when the review (hence the
  // reattach key) changes, so no seq/buffer/settle state leaks across reviews.
  const seenSeq = useRef(new Map<string, number>());
  const buffer = useRef<ReviewAskStreamEvent[]>([]);
  const settledRef = useRef(false);
  const liveIds = useRef(new Set<string>());
  const keyRef = useRef(reattachKey);
  if (keyRef.current !== reattachKey) {
    keyRef.current = reattachKey;
    seenSeq.current = new Map();
    buffer.current = [];
    settledRef.current = false;
    liveIds.current = new Set();
  }

  // Fix #2 (join-mid-reply): a delta that folds into the reattach entry BEFORE the initial
  // fetch resolves is overwritten when cache.ts installs the server snapshot, and its seq is
  // recorded — so a re-delivered delta is then rejected as a replay and the text is lost
  // forever. We BUFFER stream events until reattach settles (leaving the entry untouched so
  // `data` stays undefined and settle isn't tripped early), then flush them in order onto the
  // settled snapshot. The daemon streams only deltas newer than the snapshot's coalesced
  // bodies, so a flushed delta appends cleanly.
  useCommandStream({
    channel: "askStream",
    delivery: "delta",
    subscriptionKey: reviewId,
    command: { name: "review.reattach", input: reattachInput },
    fold: (prev, event) => {
      if (!settledRef.current) {
        buffer.current.push(event);
        return prev as ReattachResult; // undefined until the real fetch lands — don't clobber
      }
      return foldAskStream(prev, event, seenSeq.current);
    },
  });

  const reattachSettled =
    reviewId !== undefined && !fetching && (data !== undefined || error !== undefined);
  useEffect(() => {
    if (!reattachSettled || settledRef.current) return;
    settledRef.current = true;
    const buffered = buffer.current;
    buffer.current = [];
    // The reviewer spoke before any reply event arrived, so replay the queued echo first; then
    // fold buffered stream events in arrival order onto that authoritative snapshot.
    flushReviewerEchoes(cache, reattachKey);
    for (const event of buffered) {
      cache.setData(reattachKey, (prev) =>
        foldAskStream(prev as ReattachResult | undefined, event, seenSeq.current),
      );
    }
  }, [reattachSettled, cache, reattachKey]);

  // A background reattach refetch can also replace a live-folded entry. Anchored sends enqueue a
  // replay whenever any fetch is active; apply it as soon as that fetch settles.
  useEffect(() => {
    if (fetching || (!data && !error)) return;
    flushReviewerEchoes(cache, reattachKey);
  }, [cache, data, error, fetching, reattachKey]);

  // No `invalidates`: a reattach refetch would overwrite the folded stream — cache.ts's
  // fetch-success installs the server snapshot, discarding live folds (the same clobber Fix #2
  // gates against). The turn settles via the `ask-complete` fold ON THE STREAM, not a server
  // read; the daemon persists it out-of-band.
  const ask = useMutation("review.ask");

  // Turns that were streaming at least once this mount animate on arrival; the initial
  // snapshot's turns are records. We accumulate live ids in a ref so a settled turn keeps
  // its arrival animation and a record never re-animates on a later re-render.
  const reattach = data ?? EMPTY_REATTACH;
  const liveRows = useMemo(() => reattachToRows(reattach), [reattach]);
  for (const row of liveRows) {
    if (row.kind === "turn" && row.status === "streaming") liveIds.current.add(row.id);
  }

  // The served coding turns, unless a host/test override supplied its own rows.
  const historyRows = useMemo(
    () => projection.rows ?? transcriptRowsOf(session?.rows ?? []),
    [projection.rows, session],
  );
  const detachedRows = useMemo(
    () => (reviewId === undefined ? [] : detachedThreadRowsOf(quoteThreads)),
    [quoteThreads, reviewId],
  );
  const rows = useMemo(
    () => [...mergeTranscriptRows(historyRows, liveRows), ...detachedRows],
    [detachedRows, historyRows, liveRows],
  );
  const inFlight = liveRows.some((row) => row.kind === "turn" && row.status === "streaming");

  const send = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text || reviewId === undefined) return;
      const threadId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      // Fix #1: optimistic user-turn echo. The ask stream yields ONLY orchestrator turns and
      // send() deliberately does not refetch reattach (that would clobber folded deltas), so
      // without this the reviewer's own message would never render this mount. We append the
      // "you" turn into the SAME reattach entry the transcript reads, so it renders instantly
      // and in order — the user bubble ahead of the streaming reply. If reattach has not
      // settled yet, the settle-flush applies the echo afterwards.
      //
      // The id is the DAEMON'S id for this same message, byte for byte (`dispatch/review.ts`
      // persists the reviewer's turn as `${turnId}::you`) — not a client-side `you-${turnId}`.
      // `appendMessage`'s guard dedupes by id, and two ids for one message defeat it: when the
      // reattach snapshot already carries the persisted turn (an ask sent while the initial
      // read is still in flight, then flushed onto it), the reviewer's own message rendered
      // TWICE. Agreeing on the id is what makes the guard able to do its job.
      const echo = { threadId, id: `${turnId}::you`, body: text };
      enqueueReviewerEcho(cache, reattachKey, echo);
      // One ask, dispatch-bound (#251): the daemon persists the reviewer's turn under these
      // ids and streams the orchestrator reply over `onAskStream`. Sending alone records no
      // review act; when the reviewer explicitly asks Rennet to act, the harness can call a
      // registry-exposed app tool and the same stream records its durable receipt.
      void ask.mutate({
        commandId: crypto.randomUUID(),
        reviewId,
        question: text,
        threadId,
        turnId,
        turnBody: text,
        // Dispatch persists a turn ONLY when the ask carries an anchor
        // (`dispatch/review.ts`), so without this the answer is lost on reload and
        // `review.reattach` — this hook's own read — comes back empty. A chat turn
        // hangs on the message, not on code, which is exactly what the wire schema's
        // `fragment` kind is for: no `path`, keyed by the thread. No protocol change.
        anchor: {
          kind: "fragment",
          label: text.slice(0, ANCHOR_LABEL_CEILING),
          key: threadId,
        },
      });
    },
    [ask, cache, reattachKey, reviewId],
  );

  return {
    rows,
    liveIds: liveIds.current,
    // The override wins, then the daemon's identity trail, then the honest placeholder for
    // a dock sitting off a session route (where there is no review to name).
    trail: projection.trail ?? session?.trail ?? { title: "New review" },
    contextWindow: projection.contextWindow ?? session?.contextWindow,
    inFlight,
    send,
    ...(draft === null || draft === "" ? {} : { draft }),
    ...(reviewId === undefined
      ? {
          unavailable:
            "No review is captured for this session yet, so there is no change to ask about.",
        }
      : {}),
  };
}
