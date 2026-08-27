import type { ReattachResult, ReviewAskStreamEvent, TurnStatus } from "@rennet/protocol";
import type { LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { commandKey, useCommand, useCommandStream, useMutation } from "../data";
import { useBridgeContext } from "../data/bridge";

// ─────────────────────────────────────────────────────────────────────────────
// The chat dock's SINGLE data-resolution point (C07, proposal reconciliation 3),
// mirroring `shell/sidebar-data.ts` (the B9 gap) and `review/citations.ts` (the B3
// gap). The dock takes no transcript props; every row it renders, every stream it
// folds, and every send resolve HERE. Two lifetimes in one file:
//
//  • LIVE NOW (dispatch-bound #251): the reviewer's ask travels as `review.ask`
//    (useMutation); the persisted ask-thread transcript reloads via `review.reattach`
//    (useCommand); the live turn's tokens fold from `onAskStream` into that same read
//    (useCommandStream), reducing `ask-delta` (append, seq-guarded) / `ask-complete`
//    (settle) / `ask-interrupted`. Tests drive this through `MemoryBridge.emitAskStream`.
//
//  • B9-GATED (stubbed): the full historical SESSION transcript — the orchestrator's
//    coding turns (thought blocks, action steps, prose), the `compact_boundary` rows,
//    the harness-reported context figure, and the session trail — is B9's projection
//    (#466: the harness CLI owns transcript/compaction). Protocol carries no
//    `session.transcript` read yet. Until B9 lands the LIVE client shows an honest
//    EMPTY transcript (`EMPTY_TRANSCRIPT`, no invented turns, no fabricated number),
//    and tests supply it through the `SessionTranscriptProjection` CONTEXT below —
//    which also injects the `reviewId` the live half keys on (today the tests inject
//    it; cluster 7 resolves it from the real route). When B9 lands, this context read
//    becomes `useCommand("session.transcript")` and the context is deleted — THIS is
//    the only file that changes.
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

export type TranscriptRow = TurnRow | CompactBoundaryRow | AnchoredThreadRow;

/** The dock header's session trail (reconciliation: honest-minimal until B9). A live
 *  client shows just the title; the projection fills project/target when it lands. */
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

// ── The B9 session-transcript projection (stub context — reconciliation 3) ────

export interface SessionTranscriptProjection {
  /** The live session's review id — the `review.reattach` read + `onAskStream` key. Absent
   *  in the honest-empty live client (no session bound yet); tests inject it. Cluster 7
   *  resolves it from the real route instead. */
  readonly reviewId?: string;
  /** Historical session rows (coding turns + `compact_boundary` rows). Empty until B9. */
  readonly rows: readonly TranscriptRow[];
  /** The header trail. Honest-minimal (title only) until B9's projection carries the target. */
  readonly trail: ChatTrail;
  /** The harness-reported context figure, or absent (⇒ meter reads "unknown"). */
  readonly contextWindow?: ContextWindow;
}

/** The live client's projection: no session, no rows, no context figure (honest empty).
 *  Everything above works against this; only cluster 7 swaps it for the real read. */
export const EMPTY_TRANSCRIPT: SessionTranscriptProjection = {
  rows: [],
  trail: { title: "New review" },
};

const SessionTranscriptContext = createContext<SessionTranscriptProjection>(EMPTY_TRANSCRIPT);
/** Wraps a mount to supply the session transcript + reviewId (tests until B9; deleted when B9 lands). */
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

/** A live in-flight turn → a streaming orchestrator `TurnRow`. */
function inFlightToTurn(turn: ReattachResult["inFlight"][number]): TurnRow {
  return {
    kind: "turn",
    id: turn.turnId,
    speaker: "orchestrator",
    status: "streaming",
    paragraphs: splitParagraphs(turn.bodySoFar),
  };
}

/** The persisted ask-thread transcript → turn rows (settled threads, then live turns). */
export function reattachToRows(result: ReattachResult): TurnRow[] {
  const rows: TurnRow[] = [];
  const known = new Set<string>();
  for (const thread of result.threads) {
    known.add(thread.threadId);
    for (const message of thread.messages) {
      rows.push({
        kind: "turn",
        id: message.id,
        speaker: message.author === "you" ? "user" : "orchestrator",
        status: message.status ?? "complete",
        paragraphs: splitParagraphs(message.body),
      });
    }
    for (const turn of result.inFlight) {
      if (turn.threadId === thread.threadId) rows.push(inFlightToTurn(turn));
    }
  }
  // A brand-new live ask whose thread was not in the reattach snapshot yet.
  for (const turn of result.inFlight) {
    if (!known.has(turn.threadId)) rows.push(inFlightToTurn(turn));
  }
  return rows;
}

const EMPTY_REATTACH: ReattachResult = { threads: [], inFlight: [] };

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
    case "ask-complete": {
      seen.delete(event.turnId);
      const settled = base.inFlight.find((t) => t.turnId === event.turnId);
      if (!settled && threadHasTurn(base, event.threadId, event.turnId)) return base; // already settled
      return {
        inFlight: base.inFlight.filter((t) => t.turnId !== event.turnId),
        threads: appendMessage(base, event.threadId, {
          id: event.turnId,
          author: "harness",
          model: event.model,
          body: event.finalBody,
          status: "complete",
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
            id: event.turnId,
            author: "harness",
            model: "",
            body: inflight.bodySoFar,
            status: "interrupted",
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
                  m.id === event.turnId ? { ...m, status: "interrupted" as const } : m,
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
  /** The full ordered transcript: session rows (B9-stubbed) then the live ask turns. */
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
}

/**
 * Resolve the whole dock model. The session half comes from the projection context
 * (B9-stubbed); the live half is the real `review.reattach` read with the ask stream
 * folded into it. `send` fires `review.ask`; the daemon streams the reply back over
 * `onAskStream`, which the fold above grows into a streaming turn and settles.
 */
export function useChatDock(): ChatDockModel {
  const projection = useSessionTranscript();
  const reviewId = projection.reviewId;
  // chat-data is the dock's single data-resolution point (see this file's header). It folds
  // THREE things into the one `review.reattach` entry the transcript reads: live deltas
  // (useCommandStream, below), the reviewer's optimistic echo, and the buffered pre-settle
  // deltas. The latter two are time-shifted folds the event-driven `useCommandStream` cannot
  // express, so they go through the same `cache.setData` primitive it uses — not `.invoke`.
  const { cache } = useBridgeContext();

  // A deterministic, stable commandId per review — `review.reattach` is idempotent, so no
  // uuid churn is needed (unlike a progress-correlated command). A fresh review key remints it.
  const reattachInput = useMemo(
    () => ({ commandId: reviewId ? `reattach-${reviewId}` : "reattach", reviewId: reviewId ?? "" }),
    [reviewId],
  );
  const reattachKey = useMemo(() => commandKey("review.reattach", reattachInput), [reattachInput]);

  const { data, error } = useCommand("review.reattach", reattachInput, {
    enabled: reviewId !== undefined,
  });

  // Per-review live-fold state. `seenSeq` rejects replayed deltas by turn; `buffer` holds
  // stream events that arrive BEFORE the initial reattach settles; `optimistic` holds
  // reviewer echoes sent in that same pre-settle window. All reset when the review (hence the
  // reattach key) changes, so no seq/buffer/settle state leaks across reviews.
  const seenSeq = useRef(new Map<string, number>());
  const buffer = useRef<ReviewAskStreamEvent[]>([]);
  const optimistic = useRef<Array<{ threadId: string; id: string; body: string }>>([]);
  const settledRef = useRef(false);
  const keyRef = useRef(reattachKey);
  if (keyRef.current !== reattachKey) {
    keyRef.current = reattachKey;
    seenSeq.current = new Map();
    buffer.current = [];
    optimistic.current = [];
    settledRef.current = false;
  }

  // Fold one reviewer "you" turn into the reattach entry (the optimistic echo, Fix #1).
  const foldEcho = useCallback(
    (echo: { threadId: string; id: string; body: string }) => {
      cache.setData(reattachKey, (prev) => {
        const base = (prev as ReattachResult | undefined) ?? EMPTY_REATTACH;
        return {
          ...base,
          threads: appendMessage(base, echo.threadId, {
            id: echo.id,
            author: "you",
            body: echo.body,
            status: "complete",
          }),
        };
      });
    },
    [cache, reattachKey],
  );

  // Fix #2 (join-mid-reply): a delta that folds into the reattach entry BEFORE the initial
  // fetch resolves is overwritten when cache.ts installs the server snapshot, and its seq is
  // recorded — so a re-delivered delta is then rejected as a replay and the text is lost
  // forever. We BUFFER stream events until reattach settles (leaving the entry untouched so
  // `data` stays undefined and settle isn't tripped early), then flush them in order onto the
  // settled snapshot. The daemon streams only deltas newer than the snapshot's coalesced
  // bodies, so a flushed delta appends cleanly.
  useCommandStream({
    channel: "askStream",
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

  const reattachSettled = reviewId !== undefined && (data !== undefined || error !== undefined);
  useEffect(() => {
    if (!reattachSettled || settledRef.current) return;
    settledRef.current = true;
    const buffered = buffer.current;
    const echoes = optimistic.current;
    buffer.current = [];
    optimistic.current = [];
    // Buffered deltas first (in arrival order), then any pre-settle reviewer echo — so the
    // transcript order matches send/receive order. Both fold onto the settled snapshot.
    for (const event of buffered) {
      cache.setData(reattachKey, (prev) =>
        foldAskStream(prev as ReattachResult | undefined, event, seenSeq.current),
      );
    }
    for (const echo of echoes) foldEcho(echo);
  }, [reattachSettled, cache, reattachKey, foldEcho]);

  // No `invalidates`: a reattach refetch would overwrite the folded stream — cache.ts's
  // fetch-success installs the server snapshot, discarding live folds (the same clobber Fix #2
  // gates against). The turn settles via the `ask-complete` fold ON THE STREAM, not a server
  // read; the daemon persists it out-of-band.
  const ask = useMutation("review.ask");

  // Turns that were streaming at least once this mount animate on arrival; the initial
  // snapshot's turns are records. We accumulate live ids in a ref so a settled turn keeps
  // its arrival animation and a record never re-animates on a later re-render.
  const liveIds = useRef(new Set<string>());
  const reattach = data ?? EMPTY_REATTACH;
  const liveRows = useMemo(() => reattachToRows(reattach), [reattach]);
  for (const row of liveRows) {
    if (row.kind === "turn" && row.status === "streaming") liveIds.current.add(row.id);
  }

  const rows = useMemo(() => [...projection.rows, ...liveRows], [projection.rows, liveRows]);
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
      // "you" turn into the SAME reattach entry the transcript reads, under a distinct id (the
      // daemon persists the orchestrator turn under `turnId`), so it renders instantly and in
      // order — the user bubble ahead of the streaming reply. When the authoritative transcript
      // later supplies the persisted "you" message, `appendMessage`'s id-guard keeps it from
      // doubling. If reattach has not settled yet, the settle-flush applies the echo afterwards.
      const echo = { threadId, id: `you-${turnId}`, body: text };
      if (settledRef.current) foldEcho(echo);
      else optimistic.current.push(echo);
      // One ask, dispatch-bound (#251): the daemon persists the reviewer's turn under these
      // ids and streams the orchestrator reply over `onAskStream`. No staging (C8), no
      // command effects (B10). The stream fold above renders the growing turn.
      void ask.mutate({
        commandId: crypto.randomUUID(),
        reviewId,
        question: text,
        threadId,
        turnId,
        turnBody: text,
      });
    },
    [ask, foldEcho, reviewId],
  );

  return {
    rows,
    liveIds: liveIds.current,
    trail: projection.trail,
    contextWindow: projection.contextWindow,
    inFlight,
    send,
  };
}
