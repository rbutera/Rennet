import type { RennetBridge } from "@rennet/protocol";
import { useEffect, useRef, useState } from "react";
import type { AskMode } from "../canvas/ask";
import {
  answerInThread,
  askInThread,
  buildConversationQuestion,
  type ConversationAnchor,
  type ConversationThread,
  type DiscussRequest,
  fragmentAnchorKey,
  openThread,
  type PromotionEvent,
  type PromotionKind,
  promoteMessage,
} from "../canvas/conversation";
import { ConversationMargin, DiscussControl } from "./conversation-cluster";

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
// synthesis). No new protocol command and no streaming transport are invented: the
// answer arrives whole (the orchestrator turn resolves to its final text), exactly
// as it does for `AskPanel`. ⛔ Live token STREAMING and server-side session RESUME /
// orphan reaping are DEFERRED as issue #251 (split from #36, criteria 3+4) — a
// separate branch, only observable in the crash/kill failure case; a working,
// contextual, multi-turn-LIVE conversation lands here first. The streaming seam is
// the `answerInThread` call below (where whole answers land, tokens would stream).
// ─────────────────────────────────────────────────────────────────────────────

/** The UI-side ceiling on a single turn before the thread unblocks with an honest
 *  timeout (the underlying turn is not aborted — this frees the composer so a thread
 *  is never permanently stuck). Mirrors `AskPanel`'s `DEFAULT_ASK_TIMEOUT_MS`. */
export const DEFAULT_CONVERSATION_TIMEOUT_MS = 180_000;

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
      // model. No synthesis is possible: the result shape carries at most these two.
      setThreads((current) =>
        current.map((candidate) => {
          if (candidate.id !== threadId) return candidate;
          let grown = answerInThread(
            candidate,
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
      // replaced by a fixture answer.
      setThreadError(threadId, reason instanceof Error ? reason.message : String(reason));
    } finally {
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
