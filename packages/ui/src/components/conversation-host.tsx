import type { PersistedThreadWire, RennetBridge } from "@rennet/protocol";
import { useEffect, useRef, useState } from "react";
import { type AskMode, DEFAULT_ASK_MODE } from "../canvas/ask";
import {
  addMessage,
  answerInThread,
  askInThread,
  buildConversationQuestion,
  type CoalescerBook,
  type ConversationAnchor,
  type ConversationThread,
  type DiscussRequest,
  emptyCoalescerBook,
  fragmentAnchorKey,
  openThread,
  type PromotionEvent,
  type PromotionKind,
  promoteMessage,
  pushDelta,
  THREAD_LANE,
} from "../canvas/conversation";
import { ConversationMargin, DiscussControl } from "./conversation-cluster";

/**
 * Reconstruct a live {@link ConversationThread} from a persisted one on re-attach (#251).
 * The wire message shape is identical to `ThreadMessage` (id/author/model?/body/status?),
 * so an interrupted turn's `status` carries straight through and renders honestly. A new
 * thread is always private (blue) and orchestrator-routed by default; `orphaned` rides
 * along when the persisted thread was flagged.
 */
function threadFromPersisted(wire: PersistedThreadWire): ConversationThread {
  return {
    id: wire.threadId,
    anchor: wire.anchor,
    lane: THREAD_LANE,
    route: DEFAULT_ASK_MODE,
    messages: wire.messages.map((message) => ({
      id: message.id,
      author: message.author,
      body: message.body,
      ...(message.model !== undefined ? { model: message.model } : {}),
      ...(message.status !== undefined ? { status: message.status } : {}),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE conversation host (issue #36): the wiring that finally lights the inline
// conversation cluster with the REAL orchestrator, replacing the fixture message
// source. It is the sibling of `AskPanel` (#139): a self-contained container that
// owns the thread state and drives every turn over the proven `review.ask` boundary.
//
// The gap it closes: `conversation-cluster.tsx` renders threads, but until now the
// ONLY source of a harness answer was `demoConversationThread()` — a canned string.
// This host makes the answer REAL: opening a thread on an anchor and asking a
// question invokes `bridge.invoke("review.ask", …)`, and the orchestrator's own
// answer populates the thread. A follow-up continues the SAME thread, its context
// carried into the stateless turn by `buildConversationQuestion` (anchor + the whole
// conversation so far). There is no fixture fallback anywhere on this path.
//
// The boundary is `review.ask` verbatim — the SAME command, router, and live ports
// `AskPanel` fires (`askReview`: orchestrator once, "both" adds Codex, never a
// synthesis). #251 now STREAMS the orchestrator's tokens live: the ask carries a
// `turnId` + `anchor`, and `bridge.onAskStream` deltas (filtered to this turn) drive a
// single live PREVIEW message that grows as the model types. The preview is a live
// ECHO only — the durable answer is always the AUTHORITATIVE invoke result, which
// replaces the preview on completion, so a missing/absent stream degrades cleanly to
// the whole-answer behaviour (no `onAskStream` ⇒ no preview, answer still lands).
// ⛔ Session persistence / re-attach / the interrupted-turn SURFACE / orphan reaping
// remain #251's later slices — only observable in the crash/kill failure case.
// ─────────────────────────────────────────────────────────────────────────────

/** The UI-side ceiling on a single turn before the thread unblocks with an honest
 *  timeout (the underlying turn is not aborted — this frees the composer so a thread
 *  is never permanently stuck). Mirrors `AskPanel`'s `DEFAULT_ASK_TIMEOUT_MS`. */
export const DEFAULT_CONVERSATION_TIMEOUT_MS = 180_000;

/** How often (ms) the live streaming preview repaints as tokens arrive (#251). The
 *  coalescer accumulates every token into the body regardless; this only bounds how
 *  often React repaints, so a fast token stream cannot thrash the DOM. */
export const STREAM_REPAINT_THROTTLE_MS = 33;

/** The message-id prefix of the live streaming PREVIEW (#251). One preview per turn;
 *  it is replaced by the durable answer(s) from the authoritative invoke result on
 *  completion, or removed on failure. Distinct prefix so it is never mistaken for a
 *  durable message id (which is a random UUID). */
export const STREAM_PREVIEW_ID_PREFIX = "stream-preview-";

export interface ConversationHostProps {
  /** The command bridge — every turn runs `review.ask` over it. */
  bridge: RennetBridge;
  /** The open review a conversation is ABOUT (each turn scopes to it). */
  reviewId: string;
  /**
   * The anchors a thread can be opened on from the MARGIN (a line / range / chunk /
   * fragment). The host renders a `DiscussControl` for each anchor that has no open
   * thread yet; pressing it opens the private thread the reviewer then converses in.
   */
  anchors: readonly ConversationAnchor[];
  /**
   * Discuss REQUESTS opened from ELSEWHERE — the diff surface's per-line / range /
   * chunk discuss glyphs (issue #36). Each is a request to OPEN a thread directly: the
   * diff is where the reviewer clicked, so the thread should already exist in the
   * margin by the time they look. The host opens one thread per request `id` it has
   * not seen, so re-passing the same list is idempotent — but a NEW request on the
   * same anchor key (a second discussion of the same line) opens its OWN thread rather
   * than being collapsed. `anchor.key` stays purely for alignment and grouping. Absent
   * ⇒ margin-driven opening only (the existing behaviour; unchanged for old callers).
   */
  autoOpenRequests?: readonly DiscussRequest[];
  /** UI timeout for a single turn; defaults to {@link DEFAULT_CONVERSATION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * A message was promoted (finding / draft-comment) — the ONLY thing that crosses
   * the private→published boundary (#109 owns where it lands). Optional: absent ⇒ the
   * promote affordances still fire, they just have nowhere to route yet.
   */
  onPromote?(event: PromotionEvent): void;
}

/**
 * The live conversation host: owns the threads, drives each turn over `review.ask`,
 * and renders the discuss affordances + the right-margin thread column. Mounting it
 * beside a diff needs nothing but the bridge, the review id, and the anchors a thread
 * can hang on. Asking a model is Rennet's whole job — a turn just runs, with no
 * consent step and no permission gate.
 */
export function ConversationHost({
  bridge,
  reviewId,
  anchors,
  autoOpenRequests = [],
  timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
  onPromote,
}: ConversationHostProps) {
  const [threads, setThreads] = useState<readonly ConversationThread[]>([]);
  // Thread ids with a live turn in flight, and the last failure per thread — the
  // honest live states the margin renders (never a fixture answer, never a silent
  // swallow). One turn at a time per thread: `pending` also holds that thread's composer.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  // Which anchors already have an open thread — a discuss control is shown ONLY for
  // anchors without one, so pressing discuss always opens a fresh thread (one per
  // anchor) and never silently no-ops on an already-open anchor.
  const openAnchorKeys = new Set(threads.map((thread) => thread.anchor.key));

  function openConversation(anchor: ConversationAnchor): void {
    if (openAnchorKeys.has(anchor.key)) return;
    setThreads((current) => [...current, openThread(crypto.randomUUID(), anchor)]);
  }

  // Open a thread for every diff-originated REQUEST we have not seen (issue #36). Dedup
  // is on the request `id` (the occurrence), never the anchor key: the `seen` ref makes
  // this react to NEW requests only, so a re-passed list is idempotent, while a second
  // request on the SAME anchor key opens its OWN thread (a real second discussion of a
  // line). `anchor.key` is left purely for margin alignment and grouping.
  const autoOpenedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = autoOpenRequests.filter((request) => !autoOpenedIds.current.has(request.id));
    if (fresh.length === 0) return;
    for (const request of fresh) autoOpenedIds.current.add(request.id);
    setThreads((current) => [
      ...current,
      ...fresh.map((request) => openThread(crypto.randomUUID(), request.anchor)),
    ]);
  }, [autoOpenRequests]);

  // Re-attach on mount (#251): reload the threads persisted for this review, so a
  // conversation survives the process that created it. A turn that was streaming when a
  // previous process died comes back INTERRUPTED (the store's crash-recovery transform),
  // and renders as such — never a silent completion, never dropped. Best-effort: a bridge
  // with no persisted threads returns an empty set, and a reattach that throws leaves the
  // (freshly-opened) threads alone. Seeds only threads not already present by id, so a
  // reattach can never clobber a thread the reviewer just opened in this session.
  const reattachedRef = useRef(false);
  useEffect(() => {
    if (reattachedRef.current) return;
    reattachedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const result = await bridge.invoke("review.reattach", {
          commandId: crypto.randomUUID(),
          reviewId,
        });
        if (cancelled || result.threads.length === 0) return;
        setThreads((current) => {
          const present = new Set(current.map((thread) => thread.id));
          const restored = result.threads
            .filter((wire) => !present.has(wire.threadId))
            .map(threadFromPersisted);
          return restored.length > 0 ? [...restored, ...current] : current;
        });
      } catch {
        // Re-attach is best-effort — a missing store or a failed call simply means
        // "nothing to reattach", never a crash of the review surface.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, reviewId]);

  // Open a FRAGMENT thread on a message inside an existing thread (issue #36): the
  // "discuss a fragment of the conversation itself" anchor. The new thread anchors to
  // the message id (so the margin keys it distinctly) and is private like any other —
  // a sub-thread never inherits ink, and the parent thread is not mutated.
  function openSubThread(threadId: string, messageId: string): void {
    const parent = threads.find((candidate) => candidate.id === threadId);
    if (!parent) return;
    // The fragment identity is the PARENT THREAD plus the message id (issue #36 F4),
    // never the bare message id: message ids are unique per thread, so a bare id could
    // collide across threads. AND — the load-bearing half (F2) — the fragment carries
    // the referenced message TEXT as `context`, so `buildConversationQuestion` tells the
    // orchestrator WHICH sentence the sub-thread hangs off. A key alone never reaches it.
    const key = fragmentAnchorKey(parent.id, messageId);
    if (openAnchorKeys.has(key)) return;
    const referenced = parent.messages.find((message) => message.id === messageId);
    const anchor: ConversationAnchor = {
      kind: "fragment",
      label: `${parent.anchor.label} · reply`,
      key,
      ...(referenced ? { context: referenced.body } : {}),
    };
    setThreads((current) => [...current, openThread(crypto.randomUUID(), anchor)]);
  }

  function markPending(threadId: string, on: boolean): void {
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }

  function setThreadError(threadId: string, message: string | undefined): void {
    setErrors((current) => {
      const next = { ...current };
      if (message === undefined) delete next[threadId];
      else next[threadId] = message;
      return next;
    });
  }

  async function ask(threadId: string, body: string, mode: AskMode): Promise<void> {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread || pending.has(threadId)) return;
    // Build the live question BEFORE appending the new "you" message, so the folded
    // transcript is the conversation SO FAR and `body` is the new turn (never doubled).
    const question = buildConversationQuestion(thread.anchor, thread.messages, body);
    // Append the reviewer's message immediately (optimistic), clear any prior error,
    // and hold the thread pending until the orchestrator answers.
    setThreads((current) =>
      current.map((candidate) =>
        candidate.id === threadId ? askInThread(candidate, crypto.randomUUID(), body) : candidate,
      ),
    );
    setThreadError(threadId, undefined);
    markPending(threadId, true);

    // #251: bind this turn to a stable id so the streamed tokens (keyed by reviewId,
    // filtered to this turnId) drive a single live PREVIEW message that grows as the
    // orchestrator types. The preview is a live ECHO; the durable answer is always the
    // authoritative invoke RESULT below, which replaces the preview on completion.
    const turnId = crypto.randomUUID();
    const previewId = `${STREAM_PREVIEW_ID_PREFIX}${turnId}`;
    let book: CoalescerBook = emptyCoalescerBook();
    const unsubscribe = bridge.onAskStream?.(reviewId, (event) => {
      if (event.turnId !== turnId) return; // only THIS turn's tokens
      if (event.kind !== "ask-delta" || event.channel !== "orchestrator") return;
      const pushed = pushDelta(
        book,
        event.turnId,
        event.channel,
        event.delta,
        performance.now(),
        STREAM_REPAINT_THROTTLE_MS,
      );
      book = pushed.book;
      const liveBody = pushed.body;
      setThreads((current) =>
        current.map((candidate) => {
          if (candidate.id !== threadId) return candidate;
          const hasPreview = candidate.messages.some((message) => message.id === previewId);
          if (hasPreview) {
            return {
              ...candidate,
              messages: candidate.messages.map((message) =>
                message.id === previewId ? { ...message, body: liveBody } : message,
              ),
            };
          }
          return addMessage(candidate, {
            id: previewId,
            author: "harness",
            body: liveBody,
            status: "streaming",
          });
        }),
      );
    });

    /** Drop the live preview from a thread (on completion or failure). */
    const dropPreview = (thread: ConversationThread): ConversationThread => ({
      ...thread,
      messages: thread.messages.filter((message) => message.id !== previewId),
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const invocation = bridge.invoke("review.ask", {
        commandId: crypto.randomUUID(),
        reviewId,
        // The per-turn routing the reviewer chose in the composer (#139): "orchestrator"
        // by default so a turn never fires a second model behind their back; "both" is
        // the explicit opt-in that ALSO asks Codex, its answer appended as a second card.
        mode,
        question,
        // #251: identify the thread + turn and carry the anchor, so main persists the
        // thread and streams the turn's tokens back under these ids.
        threadId,
        turnId,
        anchor: thread.anchor,
      });
      // Race a UI timeout so a turn that never settles cannot leave the thread stuck.
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The orchestrator did not answer in time. Try asking again.")),
          timeoutMs,
        );
      });
      const result = await Promise.race([invocation, timeout]);
      // The REAL answer(s) populate the thread — `primary` always, plus `secondOpinion`
      // when the thread asked both. Each is a durable harness card labelled by its own
      // model. No synthesis is possible: the result shape carries at most these two. The
      // live preview is dropped and REPLACED by the durable answer (never both).
      setThreads((current) =>
        current.map((candidate) => {
          if (candidate.id !== threadId) return candidate;
          let grown = answerInThread(
            dropPreview(candidate),
            crypto.randomUUID(),
            result.primary.model,
            result.primary.answer,
          );
          if (result.secondOpinion) {
            grown = answerInThread(
              grown,
              crypto.randomUUID(),
              result.secondOpinion.model,
              result.secondOpinion.answer,
            );
          }
          return grown;
        }),
      );
    } catch (reason) {
      // A failed turn is surfaced honestly on the thread — never swallowed, never
      // replaced by a fixture answer. The half-streamed preview is dropped (its
      // interrupted-surface persistence is #251's next slice, not this one).
      setThreads((current) =>
        current.map((candidate) =>
          candidate.id === threadId ? dropPreview(candidate) : candidate,
        ),
      );
      setThreadError(threadId, reason instanceof Error ? reason.message : String(reason));
    } finally {
      unsubscribe?.();
      if (timer !== undefined) clearTimeout(timer);
      markPending(threadId, false);
    }
  }

  function promote(threadId: string, messageId: string, kind: PromotionKind): void {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const event = promoteMessage(thread, messageId, kind);
    if (event && onPromote) onPromote(event);
  }

  const discussable = anchors.filter((anchor) => !openAnchorKeys.has(anchor.key));

  return (
    <div className="conversation-host">
      {discussable.length > 0 ? (
        <div className="conversation-host-discuss">
          {discussable.map((anchor) => (
            <DiscussControl key={anchor.key} anchor={anchor} onDiscuss={openConversation} />
          ))}
        </div>
      ) : null}
      <ConversationMargin
        threads={threads}
        onAsk={(threadId, body, mode) => void ask(threadId, body, mode)}
        onPromote={promote}
        onSubThread={openSubThread}
        pendingThreadIds={pending}
        errorByThread={errors}
      />
    </div>
  );
}
