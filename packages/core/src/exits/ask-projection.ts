// The pure durable-asks fold (B11 cluster 1). The event log is the sole source
// of truth; this collapses it to the current projection, and `receiptFor` builds
// the inverse of any event so a write's receipt IS its undo. No I/O, no clock,
// no Node — the adapters' `AskLogStore` persists the log and calls `foldAsks`;
// the server's `ask.*` handlers (the sole writers) call `receiptFor` to answer
// each write with its receipt.
//
// Receipt-is-undo is an EXACT property (verified in the tests): for any event `e`
// applied to a prior projection `p`, `applyAskEvent(applyAskEvent(p, e),
// receiptFor(e, p))` deep-equals `p`. It holds because every collection is a
// Record keyed by identity (object equality ignores insertion order) and every
// mutating kind's receipt restores the exact prior value.

import type { AskEventBody, AskProjection } from "@rennet/protocol";

/** The empty projection — a fresh review, before any ask event. */
export function emptyAskProjection(): AskProjection {
  return {
    stagedAsks: {},
    lineComments: {},
    quoteThreads: {},
    retired: {},
    verdictOverride: null,
  };
}

/** Drop one key from a Record, returning a new Record (never mutates the input). */
function without<V>(record: Record<string, V>, key: string): Record<string, V> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Apply ONE event to a projection, returning the next projection. Total and pure:
 * an event that references something absent (edit/retire an unstaged ask, reply
 * to a closed thread) is a no-op, never a throw — the log can outlive the thing it
 * names, and the fold must not crash on it.
 */
export function applyAskEvent(p: AskProjection, e: AskEventBody): AskProjection {
  switch (e.kind) {
    case "stage":
      return { ...p, stagedAsks: { ...p.stagedAsks, [e.ask.id]: e.ask } };
    case "unstage":
      return { ...p, stagedAsks: without(p.stagedAsks, e.id) };
    case "edit": {
      const ask = p.stagedAsks[e.id];
      if (!ask) return p;
      return { ...p, stagedAsks: { ...p.stagedAsks, [e.id]: { ...ask, body: e.body } } };
    }
    case "retire": {
      const ask = p.stagedAsks[e.id];
      if (!ask) return p;
      return {
        ...p,
        stagedAsks: without(p.stagedAsks, e.id),
        retired: { ...p.retired, [e.id]: { ask, reason: e.reason } },
      };
    }
    case "restore": {
      const entry = p.retired[e.id];
      if (!entry) return p;
      return {
        ...p,
        stagedAsks: { ...p.stagedAsks, [e.id]: entry.ask },
        retired: without(p.retired, e.id),
      };
    }
    case "quote-open":
      return { ...p, quoteThreads: { ...p.quoteThreads, [e.threadId]: e.thread } };
    case "quote-reply": {
      const thread = p.quoteThreads[e.threadId];
      if (!thread) return p;
      return {
        ...p,
        quoteThreads: { ...p.quoteThreads, [e.threadId]: { ...thread, messages: e.messages } },
      };
    }
    case "quote-close":
      return { ...p, quoteThreads: without(p.quoteThreads, e.threadId) };
    case "verdict-override-set":
      return { ...p, verdictOverride: e.verdict };
    case "verdict-override-clear":
      return { ...p, verdictOverride: null };
    case "line-comment-set": {
      const line = String(e.line);
      return {
        ...p,
        lineComments: {
          ...p.lineComments,
          [e.path]: { ...p.lineComments[e.path], [line]: e.body },
        },
      };
    }
    case "line-comment-clear": {
      const forPath = p.lineComments[e.path];
      if (!forPath) return p;
      const restLines = without(forPath, String(e.line));
      // Drop the path entirely once its last comment is cleared, so setting a
      // comment on a fresh path and clearing it returns to the exact prior state
      // (an empty `{}` left behind would break receipt-is-undo).
      const lineComments =
        Object.keys(restLines).length === 0
          ? without(p.lineComments, e.path)
          : { ...p.lineComments, [e.path]: restLines };
      return { ...p, lineComments };
    }
  }
}

/** Fold an event log to its current projection. Left fold from empty. */
export function foldAsks(events: readonly AskEventBody[]): AskProjection {
  return events.reduce(applyAskEvent, emptyAskProjection());
}

/**
 * The inverse of `event`, given the projection it was applied to. Appending this
 * receipt after the event returns the projection to `prior` exactly. `prior` is
 * the state BEFORE `event` — the caller (the sole-writer handler) has it in hand,
 * and the inverse needs it: `edit`'s receipt is `edit(prior body)`, a verdict
 * set's receipt is `set(prior verdict)` or `clear`, and so on.
 */
export function receiptFor(event: AskEventBody, prior: AskProjection): AskEventBody {
  switch (event.kind) {
    case "stage": {
      // `stage` OVERWRITES an existing id (the fold is a Record set), so its inverse is
      // not always a plain removal: if an ask already lived at this id, undoing the
      // overwrite must RESTORE the prior ask, not delete it (else applying the receipt
      // after a duplicate stage would remove the original — receipt-is-undo would lie).
      // Mirrors line-comment-set's "restore the prior value" inverse.
      const prev = prior.stagedAsks[event.ask.id];
      return prev ? { kind: "stage", ask: prev } : { kind: "unstage", id: event.ask.id };
    }
    case "unstage": {
      // Re-stage the exact ask that was removed. If it was not staged, the unstage
      // was a no-op; a stage of the same id is harmless (nothing to restore, so
      // re-stage from the receipt's own carried ask is impossible — fall back to
      // clearing, i.e. an unstage that is itself a no-op).
      const ask = prior.stagedAsks[event.id];
      return ask ? { kind: "stage", ask } : { kind: "unstage", id: event.id };
    }
    case "edit": {
      const ask = prior.stagedAsks[event.id];
      return { kind: "edit", id: event.id, body: ask ? ask.body : event.body };
    }
    case "retire":
      return { kind: "restore", id: event.id };
    case "restore": {
      const entry = prior.retired[event.id];
      return entry
        ? { kind: "retire", id: event.id, reason: entry.reason }
        : { kind: "restore", id: event.id };
    }
    case "quote-open": {
      // Same as `stage`: quote-open OVERWRITES an existing thread id, so restore the
      // prior thread if one existed rather than always closing (receipt-is-undo).
      const prev = prior.quoteThreads[event.threadId];
      return prev
        ? { kind: "quote-open", threadId: event.threadId, thread: prev }
        : { kind: "quote-close", threadId: event.threadId };
    }
    case "quote-reply": {
      const thread = prior.quoteThreads[event.threadId];
      return {
        kind: "quote-reply",
        threadId: event.threadId,
        messages: thread ? thread.messages : event.messages,
      };
    }
    case "quote-close": {
      const thread = prior.quoteThreads[event.threadId];
      return thread
        ? { kind: "quote-open", threadId: event.threadId, thread }
        : { kind: "quote-close", threadId: event.threadId };
    }
    case "verdict-override-set":
      return prior.verdictOverride === null
        ? { kind: "verdict-override-clear" }
        : { kind: "verdict-override-set", verdict: prior.verdictOverride };
    case "verdict-override-clear":
      return prior.verdictOverride === null
        ? { kind: "verdict-override-clear" }
        : { kind: "verdict-override-set", verdict: prior.verdictOverride };
    case "line-comment-set": {
      const priorBody = prior.lineComments[event.path]?.[String(event.line)];
      return priorBody === undefined
        ? { kind: "line-comment-clear", path: event.path, line: event.line }
        : { kind: "line-comment-set", path: event.path, line: event.line, body: priorBody };
    }
    case "line-comment-clear": {
      const priorBody = prior.lineComments[event.path]?.[String(event.line)];
      return priorBody === undefined
        ? { kind: "line-comment-clear", path: event.path, line: event.line }
        : { kind: "line-comment-set", path: event.path, line: event.line, body: priorBody };
    }
  }
}
