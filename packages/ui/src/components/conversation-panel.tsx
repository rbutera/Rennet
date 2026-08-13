import type { RennetBridge } from "@rennet/protocol";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_ASK_MODE } from "../canvas/ask";
import type {
  ConversationAnchor,
  ConversationThread,
  DiscussRequest,
  PromotionEvent,
  ThreadMessage,
} from "../canvas/conversation";
import { DiscussControl } from "./conversation-cluster";
import {
  ConversationHost,
  type ConversationHostRenderState,
  DEFAULT_CONVERSATION_TIMEOUT_MS,
} from "./conversation-host";
import { CommentIcon, FileDiffIcon, QuestionIcon, SparkleIcon, TriangleIcon } from "./icons";

export interface ConversationPanelProps {
  bridge: RennetBridge;
  reviewId: string;
  anchors: readonly ConversationAnchor[];
  autoOpenRequests?: readonly DiscussRequest[];
  timeoutMs?: number;
  onPromote?(event: PromotionEvent): void;
}

type AskType = "comment" | "request-change" | "question" | "discuss" | "general-ask" | "finding";

interface GeneralMessage extends ThreadMessage {
  readonly askType: "general-ask";
}

interface StreamMessage {
  readonly message: ThreadMessage;
  readonly thread?: ConversationThread;
  readonly askType: AskType;
}

function streamMessageKey(entry: StreamMessage): string {
  return `${entry.thread?.id ?? "general"}:${entry.message.id}`;
}

function TypeIcon({ type }: { type: AskType }) {
  const Icon =
    type === "request-change"
      ? TriangleIcon
      : type === "question"
        ? QuestionIcon
        : type === "general-ask"
          ? SparkleIcon
          : type === "finding"
            ? FileDiffIcon
            : CommentIcon;
  return <Icon size={13} />;
}

function anchorReply(anchor: ConversationAnchor): { reference: string; context: string } | null {
  if (anchor.kind !== "line" && anchor.kind !== "range") return null;
  const label = /^(.*?):L?(\d+)(?:-L?(\d+))?$/.exec(anchor.label);
  const keyed = /^(?:line|range)\|(.*)\|(?:additions|deletions|context)\|(\d+)(?:\|(\d+))?$/.exec(
    anchor.key,
  );
  const path = anchor.path ?? label?.[1] ?? keyed?.[1] ?? anchor.label;
  const start = label?.[2] ?? keyed?.[2];
  const end = label?.[3] ?? keyed?.[3];
  const lines = start ? `L${start}${end && end !== start ? `-L${end}` : ""}` : anchor.label;
  return {
    reference: `${path} · ${lines}`,
    context: anchor.context?.trim() || "Line text unavailable",
  };
}

function messageType(thread: ConversationThread, message: ThreadMessage): AskType {
  if (message.author === "harness") return "discuss";
  return thread.anchor.kind === "fragment" ? "discuss" : "question";
}

function ChatRow({
  entry,
  onReply,
  onPromote,
  onSubThread,
}: {
  entry: StreamMessage;
  onReply?(): void;
  onPromote?(kind: "finding" | "draft-comment"): void;
  onSubThread?(): void;
}) {
  const { message, thread, askType } = entry;
  const reply = thread ? anchorReply(thread.anchor) : null;
  const name = message.author === "you" ? "You" : (message.model ?? "Orchestrator");
  const status = message.status ?? "complete";
  return (
    <article
      className={`chat-row msg${message.author === "you" ? " self" : ""}`}
      data-author={message.author}
      data-ask-type={askType}
      data-status={status}
    >
      <span className={`chat-type-icon tico tico--${askType}`} title={askType}>
        <TypeIcon type={askType} />
      </span>
      <div className="chat-message mb">
        <header className="chat-message-head mh">
          <span className="chat-message-name nm">{name}</span>
          <span className="chat-message-type ty">{askType}</span>
        </header>
        {reply ? (
          <button type="button" className="replychip" onClick={onReply}>
            <span className="replychip-reference rl">{reply.reference}</span>
            <span className="replychip-context rc">{reply.context}</span>
          </button>
        ) : null}
        {status === "interrupted" ? (
          <p className="chat-message-interrupted">
            This answer was interrupted before it finished.
          </p>
        ) : (
          <p className="chat-message-text mt">{message.body}</p>
        )}
        {message.author === "harness" && status === "complete" ? (
          <div className="chat-message-actions mfrag">
            <button
              type="button"
              className="thread-promote-btn"
              onClick={() => onPromote?.("finding")}
            >
              finding
            </button>
            <button
              type="button"
              className="thread-promote-btn"
              onClick={() => onPromote?.("draft-comment")}
            >
              draft comment
            </button>
            <button type="button" className="thread-promote-btn is-subthread" onClick={onSubThread}>
              discuss reply
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function PanelSurface({
  state,
  bridge,
  reviewId,
  timeoutMs,
  anchors,
}: {
  state: ConversationHostRenderState;
  bridge: RennetBridge;
  reviewId: string;
  timeoutMs: number;
  anchors: readonly ConversationAnchor[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [generalMessages, setGeneralMessages] = useState<readonly GeneralMessage[]>([]);
  const [generalPending, setGeneralPending] = useState(false);
  const [generalError, setGeneralError] = useState<string | undefined>(undefined);
  const autoSelected = useRef(new Set<string>());
  const messageOrder = useRef(new Map<string, number>());
  const nextMessageOrder = useRef(0);

  useEffect(() => {
    const fresh = [...state.threads]
      .reverse()
      .find((thread) => thread.messages.length === 0 && !autoSelected.current.has(thread.id));
    if (!fresh) return;
    autoSelected.current.add(fresh.id);
    setActiveThreadId(fresh.id);
  }, [state.threads]);

  const activeThread = state.threads.find((thread) => thread.id === activeThreadId);
  const activeReply = activeThread ? anchorReply(activeThread.anchor) : null;
  const openAnchorKeys = new Set(state.threads.map((thread) => thread.anchor.key));
  const discussable = anchors.filter((anchor) => !openAnchorKeys.has(anchor.key));
  const stream: StreamMessage[] = state.threads.flatMap((thread) =>
    thread.messages.map((message) => ({ message, thread, askType: messageType(thread, message) })),
  );
  stream.push(...generalMessages.map((message) => ({ message, askType: message.askType })));
  for (const entry of stream) {
    const key = streamMessageKey(entry);
    if (!messageOrder.current.has(key)) {
      messageOrder.current.set(key, nextMessageOrder.current);
      nextMessageOrder.current += 1;
    }
  }
  stream.sort(
    (left, right) =>
      (messageOrder.current.get(streamMessageKey(left)) ?? 0) -
      (messageOrder.current.get(streamMessageKey(right)) ?? 0),
  );

  async function askGeneral(body: string): Promise<void> {
    const userMessage: GeneralMessage = {
      id: crypto.randomUUID(),
      author: "you",
      body,
      askType: "general-ask",
    };
    setGeneralMessages((current) => [...current, userMessage]);
    setGeneralPending(true);
    setGeneralError(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const invocation = bridge.invoke("review.ask", {
        commandId: crypto.randomUUID(),
        reviewId,
        mode: DEFAULT_ASK_MODE,
        question: body,
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The orchestrator did not answer in time. Try asking again.")),
          timeoutMs,
        );
      });
      const result = await Promise.race([invocation, timeout]);
      setGeneralMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          author: "harness",
          model: result.primary.model,
          body: result.primary.answer,
          askType: "general-ask",
        },
      ]);
    } catch (reason) {
      setGeneralError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      setGeneralPending(false);
    }
  }

  function submit(): void {
    const body = draft.trim();
    if (body.length === 0) return;
    if (activeThread) {
      if (state.pendingThreadIds.has(activeThread.id)) return;
      state.ask(activeThread.id, body, DEFAULT_ASK_MODE);
    } else {
      if (generalPending) return;
      void askGeneral(body);
    }
    setDraft("");
  }

  const activePending = activeThread ? state.pendingThreadIds.has(activeThread.id) : generalPending;

  return (
    <aside className="conversation-panel-shell">
      <section
        className={`conversation-panel chat${expanded ? " conversation-panel--expanded" : ""}`}
        aria-label="Conversation"
        data-expanded={expanded}
      >
        <header className="conversation-panel-header chat-h">
          <CommentIcon size={13} />
          <span>Conversation</span>
          <button
            type="button"
            className="conversation-panel-expand exp"
            aria-pressed={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <FileDiffIcon size={13} />
            {expanded ? "collapse" : "expand"}
          </button>
        </header>

        {discussable.length > 0 ? (
          <div className="conversation-panel-discuss">
            {discussable.map((anchor) => (
              <DiscussControl key={anchor.key} anchor={anchor} onDiscuss={state.openConversation} />
            ))}
          </div>
        ) : null}

        <div
          className="conversation-panel-stream stream"
          role="log"
          aria-label="Conversation stream"
        >
          {stream.map((entry) => (
            <ChatRow
              key={streamMessageKey(entry)}
              entry={entry}
              onReply={entry.thread ? () => setActiveThreadId(entry.thread?.id) : undefined}
              onPromote={
                entry.thread
                  ? (kind) => state.promote(entry.thread?.id ?? "", entry.message.id, kind)
                  : undefined
              }
              onSubThread={
                entry.thread
                  ? () => state.openSubThread(entry.thread?.id ?? "", entry.message.id)
                  : undefined
              }
            />
          ))}
          {state.threads
            .filter((thread) => thread.messages.length === 0)
            .map((thread) => {
              const reply = anchorReply(thread.anchor);
              if (!reply) return null;
              return (
                <article
                  className="chat-row chat-row--anchor-context msg"
                  data-ask-type="discuss"
                  data-anchor-key={thread.anchor.key}
                  key={`context:${thread.id}`}
                >
                  <span className="chat-type-icon tico tico--discuss" title="discuss">
                    <CommentIcon size={13} />
                  </span>
                  <div className="chat-message mb">
                    <button
                      type="button"
                      className="replychip"
                      onClick={() => setActiveThreadId(thread.id)}
                    >
                      <span className="replychip-reference rl">{reply.reference}</span>
                      <span className="replychip-context rc">{reply.context}</span>
                    </button>
                    <p className="chat-message-text mt">Reply to this line…</p>
                  </div>
                </article>
              );
            })}
        </div>

        {activeReply ? (
          <div className="conversation-composer-context">
            <span>{activeReply.reference}</span>
            <button
              type="button"
              aria-label="Clear line reply"
              onClick={() => setActiveThreadId(undefined)}
            >
              ×
            </button>
          </div>
        ) : null}
        {activeThread && state.errorByThread[activeThread.id] ? (
          <p className="conversation-panel-error" role="alert">
            {state.errorByThread[activeThread.id]}
          </p>
        ) : null}
        {generalError ? (
          <p className="conversation-panel-error" role="alert">
            {generalError}
          </p>
        ) : null}
        <div
          className="conversation-panel-composer composer"
          data-anchor-kind={activeThread?.anchor.kind ?? "general"}
          data-thread-id={activeThread?.id}
        >
          <SparkleIcon size={14} />
          <textarea
            className="conversation-panel-input"
            placeholder="Ask the orchestrator, or reply to a line…"
            value={draft}
            disabled={activePending}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            className="conversation-panel-send"
            disabled={draft.trim().length === 0 || activePending}
            onClick={submit}
          >
            Ask
          </button>
        </div>
      </section>
    </aside>
  );
}

export function ConversationPanel({
  bridge,
  reviewId,
  anchors,
  autoOpenRequests = [],
  timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
  onPromote,
}: ConversationPanelProps) {
  return (
    <ConversationHost
      bridge={bridge}
      reviewId={reviewId}
      anchors={anchors}
      autoOpenRequests={autoOpenRequests}
      timeoutMs={timeoutMs}
      onPromote={onPromote}
      render={(state) => (
        <PanelSurface
          state={state}
          bridge={bridge}
          reviewId={reviewId}
          timeoutMs={timeoutMs}
          anchors={anchors}
        />
      )}
    />
  );
}
