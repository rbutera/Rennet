// The live-turn timeline reducer (issue #382 M2, task 1.1). Folds a review's persisted thread
// state (from `review.reattach`) and its live ask-stream events (from `onAskStream`) into ONE
// ordered, typed timeline the turn screen virtualizes. Pure and framework-free — no React, no
// socket — so the reattach + live-fold discipline unit-tests directly.
//
// Reattach is the NORMAL case, not recovery (wireframe 22): entering the screen paints persisted
// state, then the live stream appends. A mid-turn reconnect RE-issues reattach (the supervisor
// does this) and re-binds the stream, so the reducer must be idempotent under a repeated reattach
// and a re-delivered event: every entry is keyed, and folding the same event twice updates the
// same entry in place rather than rendering it twice.
//
// Keying is the whole trick. A harness turn's live key is `${turnId}::${channel}`; the daemon
// persists that same turn's message under the id `${turnId}::orchestrator` / `${turnId}::codex`
// (dispatch), and the reviewer's own message under `${turnId}::you`. So a turn that streamed live
// and was then persisted+reattached lands on ONE entry, never two.

import type {
  InFlightTurn,
  PersistedThreadWire,
  ReattachResult,
  ReviewAskStreamEvent,
  StreamChannel,
} from "@rennet/protocol";

/** One row of the typed timeline: a message from the reviewer or a harness turn. */
export interface TimelineEntry {
  /** Stable identity — a persisted message id, or `${turnId}::${channel}` for a live turn. */
  readonly id: string;
  readonly author: "you" | "harness";
  /** The harness/model label, when known (a harness turn). */
  readonly model?: string;
  /** The channel a harness turn streamed on (orchestrator / codex). */
  readonly channel?: StreamChannel;
  /** The coalesced body so far (grows as deltas arrive). */
  readonly body: string;
  /** streaming ⇒ still running; complete ⇒ settled; interrupted ⇒ stopped truthfully. */
  readonly status: "streaming" | "complete" | "interrupted";
}

/** The timeline state: the ordered entries. Order is insertion order (reading order). */
export interface TimelineState {
  readonly entries: readonly TimelineEntry[];
}

export const emptyTimeline: TimelineState = { entries: [] };

/** The live channel `orchestrator`/`codex` mapped to a persisted-message id suffix. */
function channelKey(turnId: string, channel: StreamChannel): string {
  return `${turnId}::${channel}`;
}

/** Upsert an entry by id: replace in place if present (idempotent fold), else append. */
function upsert(entries: readonly TimelineEntry[], entry: TimelineEntry): readonly TimelineEntry[] {
  const index = entries.findIndex((e) => e.id === entry.id);
  if (index === -1) return [...entries, entry];
  const next = entries.slice();
  next[index] = entry;
  return next;
}

/** The entry for an id, or undefined. */
function entryOf(state: TimelineState, id: string): TimelineEntry | undefined {
  return state.entries.find((e) => e.id === id);
}

/**
 * Paint persisted state (reattach). Idempotent: re-issuing reattach after a reconnect MERGES —
 * a persisted message updates its same-id entry (a completed turn stays complete), and an
 * in-flight turn resumes its coalesced body WITHOUT clobbering a live delta that already grew it
 * past the daemon's snapshot. The merge rule for an in-flight turn: keep the longer body (the
 * live stream may already be ahead of the reattach snapshot), never shrink it.
 */
export function reattach(state: TimelineState, result: ReattachResult): TimelineState {
  let entries = state.entries;
  for (const thread of result.threads) entries = foldThread(entries, thread);
  for (const turn of result.inFlight) entries = foldInFlight(entries, turn);
  return { entries };
}

function foldThread(
  entries: readonly TimelineEntry[],
  thread: PersistedThreadWire,
): readonly TimelineEntry[] {
  let next = entries;
  for (const message of thread.messages) {
    const status = message.status ?? "complete";
    next = upsert(next, {
      id: message.id,
      author: message.author,
      ...(message.model === undefined ? {} : { model: message.model }),
      body: message.body,
      status,
    });
  }
  return next;
}

function foldInFlight(
  entries: readonly TimelineEntry[],
  turn: InFlightTurn,
): readonly TimelineEntry[] {
  const id = channelKey(turn.turnId, turn.channel);
  const existing = entries.find((e) => e.id === id);
  // Never shrink: a live delta may already have grown the body past this reattach snapshot.
  const body =
    existing && existing.body.length > turn.bodySoFar.length ? existing.body : turn.bodySoFar;
  // A turn already marked complete/interrupted by a live terminal stays settled — reattach of an
  // in-flight snapshot must not resurrect it to streaming.
  const status = existing && existing.status !== "streaming" ? existing.status : "streaming";
  return upsert(entries, {
    id,
    author: "harness",
    model: turn.model,
    channel: turn.channel,
    body,
    status,
  });
}

/**
 * Fold one live ask-stream event. `ask-focus` carries no body (a focus hint) and leaves the
 * timeline unchanged. `ask-delta` appends to the turn's coalesced body; `ask-complete` sets the
 * final body + marks complete; `ask-interrupted` marks the turn interrupted (its body stays).
 * Every arm keys by `${turnId}::${channel}`, so a re-delivered event after a reconnect updates the
 * same entry — the caught-up event never renders twice.
 */
export function foldStreamEvent(state: TimelineState, event: ReviewAskStreamEvent): TimelineState {
  switch (event.kind) {
    case "ask-focus":
      return state;
    case "ask-delta": {
      const id = channelKey(event.turnId, event.channel);
      const existing = entryOf(state, id);
      return {
        entries: upsert(state.entries, {
          id,
          author: "harness",
          channel: event.channel,
          ...(existing?.model === undefined ? {} : { model: existing.model }),
          body: (existing?.body ?? "") + event.delta,
          status: "streaming",
        }),
      };
    }
    case "ask-complete": {
      const id = channelKey(event.turnId, event.channel);
      return {
        entries: upsert(state.entries, {
          id,
          author: "harness",
          channel: event.channel,
          model: event.model,
          body: event.finalBody,
          status: "complete",
        }),
      };
    }
    case "ask-interrupted": {
      const id = channelKey(event.turnId, event.channel);
      const existing = entryOf(state, id);
      return {
        entries: upsert(state.entries, {
          id,
          author: "harness",
          channel: event.channel,
          ...(existing?.model === undefined ? {} : { model: existing.model }),
          body: existing?.body ?? "",
          status: "interrupted",
        }),
      };
    }
  }
}

/** True while any harness entry is still streaming (drives the Stop control's enabled state). */
export function isTurnRunning(state: TimelineState): boolean {
  return state.entries.some((e) => e.author === "harness" && e.status === "streaming");
}
