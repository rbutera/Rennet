import type { CommandInput, PersistedThreadWire, RennetBridge } from "@rennet/protocol";
import { Lock } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
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
  orphanUnresolvedThreads,
  type PromotionEvent,
  type PromotionKind,
  promoteMessage,
  pushDelta,
  THREAD_LANE,
  type ThreadMessage,
} from "../canvas/conversation";
import {
  AskComposer,
  ConversationMargin,
  DiscussControl,
  MessageCard,
} from "./conversation-cluster";
import { Icon } from "./icon";

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
// source. It is a self-contained container that owns the anchored-thread state and
// drives every turn over the proven `review.ask` boundary.
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
// the unified panel fires (`askReview`: orchestrator once, "both" adds Codex, never
// a synthesis). #251 now STREAMS the orchestrator's tokens live: the ask carries a
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
 *  is never permanently stuck). */
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
  selection?: NonNullable<CommandInput<"review.ask">["selection"]>;
  /** UI timeout for a single turn; defaults to {@link DEFAULT_CONVERSATION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * A message was promoted (finding / draft-comment) — the ONLY thing that crosses
   * the private→published boundary (#109 owns where it lands). Optional: absent ⇒ the
   * promote affordances still fire, they just have nowhere to route yet.
   */
  onPromote?(event: PromotionEvent): void;
  /**
   * The diff column the margin rail aligns against (issue #356). Forwarded straight to
   * `ConversationMargin`: each thread whose anchor row is rendered in the windowed diff is
   * offset to meet that row; an off-window or unmatched anchor stacks. Absent ⇒ every panel
   * stacks (the honest default).
   */
  diffRef?: RefObject<HTMLElement | null>;
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
  selection,
  timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
  onPromote,
  diffRef,
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
  // The reattach reads the LATEST anchors for orphan resolution WITHOUT making `anchors` an
  // effect dependency. This is load-bearing: `anchors` is a fresh array on every render (the
  // app builds it as `patchset.files.map(...)`), so if it were a dep, any re-render landing
  // during the async reattach IPC would tear the effect down and the one-shot ref would then
  // block the re-run from re-invoking — discarding the restored threads entirely (they would
  // never paint). Keyed on `[bridge, reviewId]` (stable within a review) and reading anchors
  // via this ref, the reattach fires once and always applies its result.
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const reattachedRef = useRef(false);
  useEffect(() => {
    // ONE-SHOT reattach guarded by reattachedRef. The result is applied UNCONDITIONALLY (no
    // cancel-on-cleanup discard): `setThreads` seeds only threads not already present by id,
    // so a StrictMode double-mount applies at most once, and a setState after a real unmount
    // is a harmless no-op. Discarding on cleanup was the bug — a fake (StrictMode) or a
    // dep-triggered unmount threw the reattach away and the surfaces went dark.
    if (reattachedRef.current) return;
    reattachedRef.current = true;
    void (async () => {
      try {
        const result = await bridge.invoke("review.reattach", {
          commandId: crypto.randomUUID(),
          reviewId,
        });
        if (result.threads.length === 0) return;
        const anchors = anchorsRef.current;
        // Orphan resolution has THREE outcomes, not two (#251 slice 3): a thread is PLACED
        // (its file is in the current diff), ORPHANED (its file is confirmed GONE), or
        // COULD-NOT-DETERMINE (we have no authoritative file list to check against — the
        // diff has not loaded). The alarming failure is painting COULD-NOT-DETERMINE as
        // ORPHANED: telling the reviewer their conversation is detached when it is merely
        // not-loaded-yet, which asserts something false (worse than the silence it fixes).
        // So orphaning runs ONLY with an authoritative basis. An empty file list is
        // COULD-NOT-DETERMINE, NEVER "checked and found nothing" — that conflation is the
        // fan-in collapse in a third costume. `anchors` is the review's COMPLETE current
        // file list by the prop's contract, so a non-empty value is authoritative; an empty
        // one means the diff is not yet loaded and every thread stays PLACED.
        const currentPaths = new Set(
          anchors.map((anchor) => anchor.path).filter((path): path is string => path !== undefined),
        );
        const canResolvePlacement = currentPaths.size > 0;
        setThreads((current) => {
          const present = new Set(current.map((thread) => thread.id));
          const mapped = result.threads
            .filter((wire) => !present.has(wire.threadId))
            .map(threadFromPersisted);
          // COULD-NOT-DETERMINE ⇒ leave every thread PLACED, never falsely orphaned.
          const restored = canResolvePlacement
            ? orphanUnresolvedThreads(mapped, currentPaths)
            : mapped;
          return restored.length > 0 ? [...restored, ...current] : current;
        });
      } catch {
        // Re-attach is best-effort — a missing store or a failed call simply means
        // "nothing to reattach", never a crash of the review surface.
      }
    })();
  }, [bridge, reviewId]);

  // Placement RE-RESOLUTION (#251 slice 3). The one-shot reattach above seeds threads with
  // placement resolved against whatever file list existed WHEN IT LANDED — which may be none,
  // if reattach resolves before the diff loads (could-not-determine ⇒ every thread PLACED).
  // That state is TEMPORARY: the moment an authoritative file list arrives, a genuinely-gone
  // thread must resolve to ORPHANED, or "orphaned threads never paint their banner" becomes a
  // dark surface one door along from the one the one-shot fix closed. This IS reachable: a
  // zero-file patchset is a real rendered state (app.tsx renders "No changes" for it), so the
  // host can mount with anchors=[] and the patchset later GAINS files (a recapture, a branch
  // advance). So placement re-runs whenever the SET of current file paths changes. It only
  // orphans against an authoritative (non-empty) list, never re-anchors, is idempotent, and
  // returns the SAME threads reference when nothing changed so it can never loop.
  //
  // `pathsKey` is the change-detection signal: a stable string that changes iff the SET of
  // current file paths changes, so the effect fires on a real file-list change and NOT on a
  // fresh-identity `anchors` array from an unrelated render. It is a JSON array so no path
  // character (a space, a `|`) can make two different sets collide.
  const pathsKey = JSON.stringify([...new Set(anchors.map((anchor) => anchor.path))].sort());
  useEffect(() => {
    const paths = (JSON.parse(pathsKey) as (string | null)[]).filter(
      (path): path is string => typeof path === "string",
    );
    if (paths.length === 0) return; // could-not-determine ⇒ leave placement unchanged
    const currentPaths = new Set(paths);
    setThreads((current) => {
      const resolved = orphanUnresolvedThreads(current, currentPaths);
      // orphanUnresolvedThreads returns each thread unchanged (===) unless it newly orphans it,
      // so if nothing changed, return `current` and React skips the update (no render loop).
      return resolved.some((thread, index) => thread !== current[index]) ? resolved : current;
    });
  }, [pathsKey]);

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

    /** Drop the live preview from a thread (on completion or failure). */
    const dropPreview = (thread: ConversationThread): ConversationThread => ({
      ...thread,
      messages: thread.messages.filter((message) => message.id !== previewId),
    });

    // A turn settles EXACTLY ONCE: via the invoke RESULT on the happy path, or — when the
    // socket drops mid-turn and the invoke rejects with a ConnectionError — via the stream's
    // `ask-complete`. `settled` makes whichever loses that race a no-op; `connectionLost`
    // gates the stream-completion path, so a normal turn's answer still comes from the richer
    // invoke result (it can carry a second opinion) and never from a single-channel complete.
    let settled = false;
    let connectionLost = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Held in an object so `finishTurn` (defined before the subscription, which the
    // ask-complete branch inside the listener calls) reads the disposer at call time.
    const stream: { unsubscribe?: () => void } = {};
    const finishTurn = (): void => {
      stream.unsubscribe?.();
      if (timer !== undefined) clearTimeout(timer);
      markPending(threadId, false);
    };

    stream.unsubscribe = bridge.onAskStream?.(reviewId, (event) => {
      if (event.turnId !== turnId) return; // only THIS turn's tokens
      // Completion from the STREAM closes the turn only on the reconnect path: the invoke
      // promise died with the dropped socket, so ask-complete is what lands the answer. On
      // the happy path the invoke result already settled it and this is a no-op.
      if (event.kind === "ask-complete" && event.channel === "orchestrator") {
        if (connectionLost && !settled) {
          settled = true;
          setThreads((current) =>
            current.map((candidate) =>
              candidate.id === threadId
                ? answerInThread(
                    dropPreview(candidate),
                    crypto.randomUUID(),
                    event.model,
                    event.finalBody,
                  )
                : candidate,
            ),
          );
          finishTurn();
        }
        return;
      }
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
        // thread and streams the turn's tokens back under these ids. `turnBody` is the
        // raw question (not the folded transcript), persisted as the "you" message.
        threadId,
        turnId,
        anchor: thread.anchor,
        turnBody: body,
        ...(selection === undefined ? {} : { selection }),
      });
      // Race a UI timeout so a turn that never settles cannot leave the thread stuck.
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The orchestrator did not answer in time. Try asking again.")),
          timeoutMs,
        );
      });
      const result = await Promise.race([invocation, timeout]);
      if (settled) return; // the stream already closed it (reconnect path won the race)
      settled = true;
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
      finishTurn();
    } catch (reason) {
      // A mid-turn CONNECTION loss is not a turn failure. Keep the live preview and the
      // pending (reconnecting) state, and KEEP the ask-stream subscription alive so the
      // supervisor's resubscribe replays it onto the new socket — its post-reconnect deltas
      // keep the preview growing and `ask-complete` finalizes the turn (issue #389, the
      // product seam). A genuine turn failure (below) still tears down honestly.
      // ponytail: a turn that completes ENTIRELY during a full outage (ask-complete fired
      // while disconnected) is recovered by review.reattach, not here — this host's reattach
      // is one-shot, so that edge repaints on the next mount, not instantly. Widen if it bites.
      if (!settled && reason instanceof Error && reason.name === "ConnectionError") {
        connectionLost = true;
        if (timer !== undefined) clearTimeout(timer); // don't let the UI timeout cry "no answer"
        return;
      }
      if (settled) return;
      settled = true;
      // A failed turn is surfaced honestly on the thread — never swallowed, never
      // replaced by a fixture answer. The half-streamed preview is dropped (its
      // interrupted-surface persistence is #251's next slice, not this one).
      setThreads((current) =>
        current.map((candidate) =>
          candidate.id === threadId ? dropPreview(candidate) : candidate,
        ),
      );
      setThreadError(threadId, reason instanceof Error ? reason.message : String(reason));
      finishTurn();
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
    <div className="conversation-host flex flex-col gap-3">
      {discussable.length > 0 ? (
        <div className="conversation-host-discuss flex flex-wrap gap-2">
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
        diffRef={diffRef}
        railFooter={
          <GeneralAskPanel
            bridge={bridge}
            reviewId={reviewId}
            timeoutMs={timeoutMs}
            selection={selection}
          />
        }
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The anchorless GENERAL ASK (#356). Not every question hangs off a diff line: the
// reviewer must be able to ask the orchestrator about the change as a whole. This is
// the affordance the retired flat `PanelSurface` carried and #356's margin adoption
// must NOT drop — restored here as a STACKED panel pinned at the rail's end (never
// aligned, since it has no diff row), the remedy the design's risk section names
// ("keep it in the margin rail as a stacked panel rather than resurrecting the flat
// stream"). It fires the SAME `review.ask` boundary as a thread turn — orchestrator by
// default, "both" the per-turn opt-in that appends Codex as a second labelled card,
// never a synthesis. It carries NO anchor and NO threadId: a general ask is scoped to
// the review, not to a line, so the question travels verbatim (no `buildConversation
// Question` anchor scope). A failed turn is surfaced honestly AND KEEPS the reviewer's
// typed draft — losing a question to a transient error is a UI lie by omission.
// ─────────────────────────────────────────────────────────────────────────────

function GeneralAskPanel({
  bridge,
  reviewId,
  timeoutMs,
  selection,
}: {
  bridge: RennetBridge;
  reviewId: string;
  timeoutMs: number;
  selection?: NonNullable<CommandInput<"review.ask">["selection"]>;
}) {
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  /** Run one general turn. Resolves `false` on failure so the composer KEEPS the draft. */
  async function ask(body: string, mode: AskMode): Promise<boolean> {
    setMessages((current) => {
      const youCard: ThreadMessage = { id: crypto.randomUUID(), author: "you", body };
      // A failed turn keeps its draft and leaves its "you" card trailing (a turn is never
      // pending here, so a trailing "you" means the last turn failed). Resending REPLACES that
      // dangling card instead of stacking a duplicate optimistic copy of the same question.
      const last = current[current.length - 1];
      if (last && last.author === "you") return [...current.slice(0, -1), youCard];
      return [...current, youCard];
    });
    setPending(true);
    setError(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const invocation = bridge.invoke("review.ask", {
        commandId: crypto.randomUUID(),
        reviewId,
        mode,
        question: body,
        ...(selection === undefined ? {} : { selection }),
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The orchestrator did not answer in time. Try asking again.")),
          timeoutMs,
        );
      });
      const result = await Promise.race([invocation, timeout]);
      // The real answer(s): the orchestrator's `primary` always, plus Codex's
      // `secondOpinion` when the reviewer asked both — each a durable labelled card, no
      // synthesis (the same two-card contract the anchored clusters render).
      setMessages((current) => {
        const grown: ThreadMessage[] = [
          ...current,
          {
            id: crypto.randomUUID(),
            author: "harness",
            model: result.primary.model,
            body: result.primary.answer,
          },
        ];
        if (result.secondOpinion) {
          grown.push({
            id: crypto.randomUUID(),
            author: "harness",
            model: result.secondOpinion.model,
            body: result.secondOpinion.answer,
          });
        }
        return grown;
      });
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      setPending(false);
    }
  }

  return (
    <aside
      className="conversation-general is-private flex flex-col overflow-hidden rounded-surface border border-line bg-surface shadow-[inset_0_0_18px_var(--rn-accent-soft)]"
      data-lane="blue"
      aria-label="Ask the orchestrator"
    >
      <header className="conversation-head flex items-baseline gap-2 px-4 py-3 border-b border-line">
        <span
          className="conversation-head-lock inline-flex self-center text-accent"
          aria-hidden="true"
        >
          <Icon icon={Lock} className="size-3" />
        </span>
        <span className="conversation-head-title font-sans text-2xs font-semibold uppercase tracking-wide text-ink-soft">
          Ask the orchestrator
        </span>
      </header>
      <div className="conversation-messages flex flex-col gap-3 p-4">
        {messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
        {pending ? (
          <p
            className="conversation-pending m-0 font-sans text-sm text-ink-soft"
            role="status"
            aria-live="polite"
          >
            Asking the orchestrator…
          </p>
        ) : null}
        {error ? (
          <p className="conversation-error m-0 font-sans text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <AskComposer
        placeholder="Ask the orchestrator about this review"
        inputLabel="Ask the orchestrator"
        sendLabel={(mode) => (mode === "both" ? "Ask both models" : "Ask the orchestrator")}
        pending={pending}
        clearOnSend={false}
        onSend={ask}
      />
    </aside>
  );
}
