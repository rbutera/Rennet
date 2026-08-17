import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { ASK_OPTIONS, type AskMode, DEFAULT_ASK_MODE } from "../canvas/ask";
import type {
  ConversationAnchor,
  ConversationThread,
  PromotionKind,
  ThreadMessage,
} from "../canvas/conversation";
import { CommentIcon, LockIcon, SparkleIcon } from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// The INLINE CONVERSATION CLUSTER UI (issue #36 — the review heart). The private
// research conversation, anchored on any anchor, rendered in the RIGHT MARGIN.
//
// Three components, one law each:
//   • DiscussControl    — the "discuss / ask-the-harness" verb. Opens a thread on
//                         an anchor (a line, a range, a chunk, a fragment). This is
//                         the affordance criterion #1 needs: a thread can be OPENED.
//   • ConversationCluster — the thread panel itself. Private/blue by default (the
//                         `--private*` backlight), header + messages + promote
//                         affordances + composer.
//   • ConversationMargin — the right-margin column. It groups panels by anchor and
//                         is a SIBLING of the diff column, so opening or growing a
//                         thread changes only the margin: the diff never reflows.
//
// The material law (issue #36, "ink vs blue"): a research conversation is PRIVATE.
// The panel renders in the private backlight (`is-private`, `data-lane="blue"`) and
// carries a lock in its header. It never publishes. Promotion — a deliberate press
// of "finding" or "draft comment" on a harness message — is the ONLY path out, and
// it fires a host callback with a promotion event; the thread stays private.
//
// SCOPE (this slice): the UI + thread model, driven by FIXTURE messages behind the
// real typed boundary. The composer fires `onAsk` (the host owns the send); the LIVE
// token streaming from the harness is the DEFERRED follow-up. The panel renders
// identically whether messages arrive from a fixture or (later) a live stream.
//
// Styling uses existing `var(--private*)` / `var(--surface*)` tokens only — no new
// hues (the hex-lint discipline). The UI stays pure: no core/adapter/Node imports.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The "discuss / ask-the-harness" verb — opens a private thread on an anchor.
 * Fires `onDiscuss(anchor)`; the host mints the thread (`openThread`) and hands it
 * to a `ConversationCluster`. Anchorable on a line, a range, a chunk, or a fragment.
 */
export function DiscussControl({
  anchor,
  labelled = true,
  onDiscuss,
}: {
  anchor: ConversationAnchor;
  /** Whether the word "Discuss" shows beside the glyph (off ⇒ icon-only line rows). */
  labelled?: boolean;
  onDiscuss(anchor: ConversationAnchor): void;
}) {
  return (
    <button
      type="button"
      className="discuss-control"
      data-anchor-kind={anchor.kind}
      data-lane="blue"
      title={`Discuss ${anchor.kind} ${anchor.label}`}
      aria-label={`Discuss ${anchor.kind} ${anchor.label}`}
      onClick={() => onDiscuss(anchor)}
    >
      <CommentIcon size={13} />
      {labelled ? <span className="discuss-control-label">Discuss</span> : null}
    </button>
  );
}

/** The trailing chip on a diff line that already carries a thread ("thread · N"). */
export function ThreadChip({
  count,
  anchor,
  onOpen,
}: {
  count: number;
  anchor: ConversationAnchor;
  onOpen(anchor: ConversationAnchor): void;
}) {
  return (
    <button
      type="button"
      className="thread-chip"
      data-anchor-kind={anchor.kind}
      title={`${count} thread${count === 1 ? "" : "s"} on ${anchor.label}`}
      aria-label={`Open ${count} thread${count === 1 ? "" : "s"} on ${anchor.kind} ${anchor.label}`}
      onClick={() => onOpen(anchor)}
    >
      <CommentIcon size={12} />
      <span className="thread-chip-count">thread · {count}</span>
    </button>
  );
}

/** One message card: "you" plain, a harness card labelled + carrying promote verbs. */
function MessageCard({
  message,
  onPromote,
  onSubThread,
}: {
  message: ThreadMessage;
  onPromote?: (messageId: string, kind: PromotionKind) => void;
  onSubThread?: (messageId: string) => void;
}) {
  const isHarness = message.author === "harness";
  // #251: a message carries a turn STATUS — absent = a durable complete answer, but a
  // live-streaming preview or an interrupted turn are surfaced honestly here (never a
  // silent completion). `data-status` is the DOM-observable hook the user's view and
  // the tests read; a streaming preview also gets `is-streaming` for its live cue.
  const isStreaming = message.status === "streaming";
  // An INTERRUPTED turn (#251): a previous process died mid-answer. Surfaced honestly
  // with its own note — never a silent completion, and there is no fabricated body to
  // show. This is the render half of criterion 3: the state reaches the person.
  const isInterrupted = message.status === "interrupted";
  return (
    <article
      className={`thread-message${isStreaming ? " is-streaming" : ""}${isInterrupted ? " is-interrupted" : ""}`}
      data-author={message.author}
      data-message-id={message.id}
      {...(message.status ? { "data-status": message.status } : {})}
    >
      <header className="thread-message-head">
        {isHarness ? (
          <span className="thread-message-model">
            <SparkleIcon size={12} />
            <span>{message.model ?? "Harness"}</span>
          </span>
        ) : (
          <span className="thread-message-you">You</span>
        )}
      </header>
      {isInterrupted ? (
        <p className="thread-message-interrupted" role="note">
          This answer was interrupted before it finished. Ask again to retry.
        </p>
      ) : (
        <p className="thread-message-body">{message.body}</p>
      )}
      {/* Promotion — a deliberate act, only on a COMPLETE harness answer. A still-
          streaming preview or an interrupted turn cannot be promoted (no durable answer). */}
      {isHarness && !isStreaming && !isInterrupted && (onPromote || onSubThread) ? (
        <footer className="thread-message-promote">
          {onPromote ? (
            <>
              <button
                type="button"
                className="thread-promote-btn"
                data-kind="finding"
                onClick={() => onPromote(message.id, "finding")}
              >
                finding
              </button>
              <button
                type="button"
                className="thread-promote-btn"
                data-kind="draft-comment"
                onClick={() => onPromote(message.id, "draft-comment")}
              >
                draft comment
              </button>
            </>
          ) : null}
          {onSubThread ? (
            <button
              type="button"
              className="thread-promote-btn is-subthread"
              data-kind="sub-thread"
              onClick={() => onSubThread(message.id)}
            >
              sub-thread
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export interface ConversationClusterProps {
  /** The private thread this panel renders (its anchor, route, and messages). */
  thread: ConversationThread;
  /** The anchor range pill shown top-right ("L44-47"). Defaults to the anchor label. */
  anchorPill?: string;
  /** Promote a harness message (deliberate act) — the host builds the promotion event. */
  onPromote?(messageId: string, kind: PromotionKind): void;
  /** Open a sub-thread on a message fragment. */
  onSubThread?(messageId: string): void;
  /**
   * Ask about these lines. The host owns the send — it invokes the LIVE `review.ask`
   * boundary and appends the real answer. Fired with the trimmed question AND the
   * chosen routing (orchestrator by default, "both" the per-turn opt-in from the
   * composer's caret); the composer clears itself.
   */
  onAsk?(body: string, mode: AskMode): void;
  /**
   * A live turn is in flight for this thread: render an honest "thinking" row and
   * disable the composer, so a pending ask is never mistaken for a finished answer.
   */
  pending?: boolean;
  /**
   * The last live turn on this thread FAILED (no harness, a turn error, a transport
   * reject). Surfaced honestly in the panel — never swallowed, never replaced by a
   * fixture answer.
   */
  error?: string;
  /**
   * In-rail alignment offset in px (#36 → #85): the panel top is translated to meet
   * its anchor row in the diff window. Undefined ⇒ the panel stacks in document order
   * (the honest fallback when the anchor row is off-window). The offset is applied as
   * a transform, so it never affects the diff column or the panel's own layout box.
   */
  alignOffset?: number;
}

/**
 * The right-margin thread panel: a PRIVATE research conversation on an anchor. Blue
 * backlight, a lock in the header, the you/harness messages, promote affordances on
 * harness answers, and an "Ask about these lines" composer. The panel is a fixed-width
 * margin citizen — it never sits in the diff column, so it cannot push the code around.
 */
export function ConversationCluster({
  thread,
  anchorPill,
  onPromote,
  onSubThread,
  onAsk,
  pending = false,
  error,
  alignOffset,
}: ConversationClusterProps) {
  const [draft, setDraft] = useState("");
  // The per-turn routing (#139): a thread starts at its own route (orchestrator by
  // default) and the caret opts THIS turn into "both". Held here, not globally, so a
  // choice never leaks past the thread it was made in.
  const [mode, setMode] = useState<AskMode>(thread.route ?? DEFAULT_ASK_MODE);
  const [menuOpen, setMenuOpen] = useState(false);
  // A pending turn holds the composer: one live ask at a time per thread, so the
  // reviewer cannot queue a second question over an in-flight orchestrator turn.
  const canSend = draft.trim().length > 0 && !pending;
  const pill = anchorPill ?? thread.anchor.label;

  function send(): void {
    if (!canSend || !onAsk) return;
    onAsk(draft.trim(), mode);
    setDraft("");
  }

  function pickMode(next: AskMode): void {
    setMode(next);
    setMenuOpen(false);
  }

  // #251 slice 3: an ORPHANED thread — the code it was anchored to has left the diff.
  // Surfaced honestly (a banner + `data-orphaned`), its content preserved, and it is NOT
  // re-anchored onto whatever now occupies its old location. The refusal is structural
  // (there is no re-anchor); this makes it VISIBLE to the reviewer.
  const orphaned = thread.orphaned === true;
  return (
    <aside
      className={`conversation-cluster is-private${orphaned ? " is-orphaned" : ""}`}
      data-lane={thread.lane}
      data-anchor-kind={thread.anchor.kind}
      data-anchor-key={thread.anchor.key}
      data-route={thread.route}
      {...(orphaned ? { "data-orphaned": "true" } : {})}
      {...(alignOffset != null ? { "data-align-offset": String(alignOffset) } : {})}
      style={alignOffset != null ? { transform: `translateY(${alignOffset}px)` } : undefined}
      aria-label={`Private thread on ${thread.anchor.kind} ${thread.anchor.label}`}
    >
      <header className="conversation-head">
        <span className="conversation-head-lock" aria-hidden="true">
          <LockIcon size={12} />
        </span>
        <span className="conversation-head-title">Thread</span>
        <span className="conversation-head-anchor">{thread.anchor.label}</span>
        <span className="conversation-head-pill">{pill}</span>
      </header>
      {orphaned ? (
        <p className="conversation-orphaned" role="note">
          The code this thread was about is no longer in the diff. It is kept here, but not moved
          onto other code.
        </p>
      ) : null}

      <div className="conversation-messages">
        {thread.messages.map((message) => (
          <MessageCard
            key={message.id}
            message={message}
            onPromote={onPromote}
            onSubThread={onSubThread}
          />
        ))}
        {/* Honest live states — never a fixture fallback. A turn in flight shows a
            "thinking" row; a failed turn shows the reason. Both sit AFTER the real
            messages so a pending/failed ask is never read as an answer. */}
        {pending ? (
          <p className="conversation-pending" role="status" aria-live="polite">
            Asking the orchestrator…
          </p>
        ) : null}
        {error ? (
          <p className="conversation-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {onAsk ? (
        <div className="conversation-composer" data-ask-mode={mode}>
          <textarea
            className="conversation-composer-input"
            placeholder="Ask about these lines"
            aria-label={`Ask about ${thread.anchor.label}`}
            value={draft}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
          />
          {/* The per-turn routing caret (#139): "Ask the orchestrator" is the default,
              "Ask both models" the opt-in. Picking a routing changes only THIS turn's
              mode; there is no synthesis — "both" yields two labelled answers. */}
          <div className="conversation-composer-route">
            <button
              type="button"
              className="conversation-composer-caret"
              aria-label="ask options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={pending}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span aria-hidden="true">⌄</span>
            </button>
            {menuOpen ? (
              <div className="conversation-route-menu" role="menu">
                {ASK_OPTIONS.map((option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.mode === mode}
                    className="conversation-route-item"
                    data-mode={option.mode}
                    key={option.mode}
                    onClick={() => pickMode(option.mode)}
                  >
                    <span className="conversation-route-label">{option.label}</span>
                    <span className="conversation-route-hint">{option.hint}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="conversation-composer-send"
            data-ask-mode={mode}
            aria-label={
              mode === "both"
                ? "Ask both models about these lines"
                : "Ask the orchestrator about these lines"
            }
            disabled={!canSend}
            onClick={send}
          >
            <CommentIcon size={13} />
          </button>
        </div>
      ) : null}
    </aside>
  );
}

export interface ConversationMarginProps {
  /** The open threads to lay out in the right margin, keyed to their anchors. */
  threads: readonly ConversationThread[];
  onPromote?(threadId: string, messageId: string, kind: PromotionKind): void;
  onSubThread?(threadId: string, messageId: string): void;
  onAsk?(threadId: string, body: string, mode: AskMode): void;
  /** Thread ids with a live turn in flight — each renders its honest "thinking" row. */
  pendingThreadIds?: ReadonlySet<string>;
  /** The last failure per thread id, surfaced honestly in that thread's panel. */
  errorByThread?: Readonly<Record<string, string>>;
  /**
   * The diff column this rail aligns against (#36 → #85). When provided, each thread
   * whose anchor row (a `[data-anchor-key]` element in the diff) is rendered in the
   * windowed diff is offset so its panel top meets that row; a thread whose row is
   * outside the window falls back to stacked document order. Absent ⇒ every panel
   * stacks (the honest default, and the only behaviour when no diff is measured). The
   * offset is read from the rendered row and applied within the rail only — the diff
   * column is never touched, so it cannot reflow.
   */
  diffRef?: RefObject<HTMLElement | null>;
}

/**
 * The right-margin column: one `ConversationCluster` per open thread, keyed to its
 * anchor. This is a SIBLING of the diff column, never nested in it — that is the
 * whole "the diff never reflows" guarantee: the diff's DOM is a function of the
 * changeset alone, and adding or growing threads only changes THIS column. Threads
 * carry `data-anchor-key` so a host can position each panel against its diff row.
 */
export function ConversationMargin({
  threads,
  onPromote,
  onSubThread,
  onAsk,
  pendingThreadIds,
  errorByThread,
  diffRef,
}: ConversationMarginProps) {
  const railRef = useRef<HTMLElement>(null);
  const alignments = useRailAlignments(railRef, diffRef, threads);
  return (
    <section className="conversation-margin" aria-label="Conversation threads" ref={railRef}>
      {threads.map((thread) => (
        <ConversationCluster
          key={thread.id}
          thread={thread}
          onPromote={
            onPromote ? (messageId, kind) => onPromote(thread.id, messageId, kind) : undefined
          }
          onSubThread={onSubThread ? (messageId) => onSubThread(thread.id, messageId) : undefined}
          onAsk={onAsk ? (body, mode) => onAsk(thread.id, body, mode) : undefined}
          pending={pendingThreadIds?.has(thread.id) ?? false}
          error={errorByThread?.[thread.id]}
          alignOffset={alignments[thread.id]}
        />
      ))}
    </section>
  );
}

/**
 * Measure each thread's in-rail alignment offset from the rendered diff window
 * (#36 → #85). For every thread whose anchor row (`[data-anchor-key]`) is painted in
 * the windowed diff, the offset is the row top minus that panel's natural top in the
 * rail. A thread whose row is off-window is omitted, so its panel stacks. Recomputed
 * on diff scroll and on resize, since the windowed renderer swaps which rows exist.
 * Returns `{}` (all stacked) when no diff is measured — the honest default. The
 * offset is read-only against the diff DOM, never a write, so alignment cannot reflow
 * the diff.
 */
function useRailAlignments(
  railRef: RefObject<HTMLElement | null>,
  diffRef: RefObject<HTMLElement | null> | undefined,
  threads: readonly ConversationThread[],
): Readonly<Record<string, number>> {
  const [alignments, setAlignments] = useState<Readonly<Record<string, number>>>({});
  useLayoutEffect(() => {
    const diff = diffRef?.current;
    const rail = railRef.current;
    if (!diff || !rail) {
      setAlignments((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const measure = (): void => {
      const rows = new Map<string, Element>();
      for (const el of diff.querySelectorAll("[data-anchor-key]")) {
        const key = el.getAttribute("data-anchor-key");
        if (key && !rows.has(key)) rows.set(key, el); // the topmost row for a key wins
      }
      const panels = rail.querySelectorAll<HTMLElement>(".conversation-cluster");
      const next: Record<string, number> = {};
      for (const [index, thread] of threads.entries()) {
        const row = rows.get(thread.anchor.key);
        const panel = panels[index];
        if (!row || !panel) continue; // off-window ⇒ stacked fallback, never a synthetic offset
        const appliedOffset = Number(panel.dataset.alignOffset ?? 0);
        const panelNaturalTop = panel.getBoundingClientRect().top - appliedOffset;
        next[thread.id] = Math.round(row.getBoundingClientRect().top - panelNaturalTop);
      }
      setAlignments((prev) => (sameOffsets(prev, next) ? prev : next));
    };
    measure();
    diff.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // The windowed diff re-lays-out as rows enter/leave; a ResizeObserver catches the
    // height churn a scroll listener alone would miss. Guarded — not every host DOM
    // (older happy-dom) defines it, and its absence just means fewer re-measures.
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : undefined;
    observer?.observe(diff);
    return () => {
      diff.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [railRef, diffRef, threads]);
  return alignments;
}

function sameOffsets(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
