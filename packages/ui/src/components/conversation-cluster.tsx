import { useState } from "react";
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
  return (
    <article className="thread-message" data-author={message.author} data-message-id={message.id}>
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
      <p className="thread-message-body">{message.body}</p>
      {/* Promotion — a deliberate act, only on a harness answer. Behind the publish
          boundary: pressing one lifts THIS message into a finding / draft comment. */}
      {isHarness && (onPromote || onSubThread) ? (
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
   * Ask about these lines. The host owns the send (deferred: the live token stream
   * appends the reply). Fired with the trimmed question; the composer clears itself.
   */
  onAsk?(body: string): void;
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
}: ConversationClusterProps) {
  const [draft, setDraft] = useState("");
  const canSend = draft.trim().length > 0;
  const pill = anchorPill ?? thread.anchor.label;

  function send(): void {
    if (!canSend || !onAsk) return;
    onAsk(draft.trim());
    setDraft("");
  }

  return (
    <aside
      className="conversation-cluster is-private"
      data-lane={thread.lane}
      data-anchor-kind={thread.anchor.kind}
      data-anchor-key={thread.anchor.key}
      data-route={thread.route}
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

      <div className="conversation-messages">
        {thread.messages.map((message) => (
          <MessageCard
            key={message.id}
            message={message}
            onPromote={onPromote}
            onSubThread={onSubThread}
          />
        ))}
      </div>

      {onAsk ? (
        <div className="conversation-composer">
          <textarea
            className="conversation-composer-input"
            placeholder="Ask about these lines"
            aria-label={`Ask about ${thread.anchor.label}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            className="conversation-composer-send"
            aria-label="Ask the orchestrator about these lines"
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
  onAsk?(threadId: string, body: string): void;
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
}: ConversationMarginProps) {
  return (
    <section className="conversation-margin" aria-label="Conversation threads">
      {threads.map((thread) => (
        <ConversationCluster
          key={thread.id}
          thread={thread}
          onPromote={
            onPromote ? (messageId, kind) => onPromote(thread.id, messageId, kind) : undefined
          }
          onSubThread={onSubThread ? (messageId) => onSubThread(thread.id, messageId) : undefined}
          onAsk={onAsk ? (body) => onAsk(thread.id, body) : undefined}
        />
      ))}
    </section>
  );
}
