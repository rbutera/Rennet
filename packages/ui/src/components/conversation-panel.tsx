import type { CommandInput, RennetBridge } from "@rennet/protocol";
import { useEffect, useRef, useState } from "react";
import { type AskMode, type AskReviewResult, DEFAULT_ASK_MODE } from "../canvas/ask";
import type {
  ConversationAnchor,
  ConversationThread,
  DiscussRequest,
  PromotionEvent,
  ThreadMessage,
} from "../canvas/conversation";
import { AskAnswers, AskButton } from "./ask";
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
  selection?: NonNullable<CommandInput<"review.ask">["selection"]>;
  timeoutMs?: number;
  onPromote?(event: PromotionEvent): void;
}

type AskType = "comment" | "request-change" | "question" | "discuss" | "general-ask" | "finding";

interface GeneralMessage extends ThreadMessage {
  readonly askType: "general-ask";
  readonly comparison?: {
    readonly question: string;
    readonly result: AskReviewResult;
  };
}

interface StreamMessage {
  readonly message: ThreadMessage & Pick<GeneralMessage, "comparison">;
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

function anchorReply(anchor: ConversationAnchor): { reference: string; context?: string } | null {
  if (anchor.kind !== "line" && anchor.kind !== "range") return null;
  const label = /^(.*?):L?(\d+)(?:-L?(\d+))?$/.exec(anchor.label);
  const keyed = /^(?:line|range)\|(.*)\|(?:additions|deletions|context)\|(\d+)(?:\|(\d+))?$/.exec(
    anchor.key,
  );
  const path = anchor.path ?? label?.[1] ?? keyed?.[1] ?? anchor.label;
  const start = label?.[2] ?? keyed?.[2];
  const end = label?.[3] ?? keyed?.[3];
  const lines = start ? `L${start}${end && end !== start ? `-L${end}` : ""}` : anchor.label;
  const context = anchor.context;
  return {
    reference: `${path} · ${lines}`,
    ...(context && context.trim().length > 0 ? { context } : {}),
  };
}

function messageType(thread: ConversationThread, message: ThreadMessage): AskType {
  if (message.author === "harness") return "discuss";
  return thread.anchor.kind === "fragment" ? "discuss" : "question";
}

function ChatRow({
  entry,
  showOrphanedMarker,
  onReply,
  onPromote,
  onSubThread,
}: {
  entry: StreamMessage;
  showOrphanedMarker?: boolean;
  onReply?(): void;
  onPromote?(kind: "finding" | "draft-comment"): void;
  onSubThread?(): void;
}) {
  const { message, thread, askType } = entry;
  const orphaned = thread?.orphaned === true;
  const reply = thread && !orphaned ? anchorReply(thread.anchor) : null;
  const name = message.comparison
    ? "Both models"
    : message.author === "you"
      ? "You"
      : (message.model ?? "Orchestrator");
  const status = message.status ?? "complete";
  const hasActions =
    message.author === "harness" &&
    status === "complete" &&
    (onPromote !== undefined || onSubThread !== undefined);
  return (
    <article
      className={`chat-row msg${message.author === "you" ? " self" : ""}${thread ? " is-private" : ""}${orphaned ? " is-orphaned" : ""}`}
      data-author={message.author}
      data-ask-type={askType}
      data-lane={thread?.lane}
      data-orphaned={orphaned || undefined}
      data-status={status}
    >
      <span className={`chat-type-icon tico tico--${askType}`} title={askType}>
        <TypeIcon type={askType} />
      </span>
      <div className="chat-message mb">
        {showOrphanedMarker ? (
          <p className="conversation-orphaned" role="note">
            The code this thread was about is no longer in the diff. It is kept here, but not moved
            onto other code.
          </p>
        ) : null}
        <header className="chat-message-head mh">
          <span className="chat-message-name nm">{name}</span>
          <span className="chat-message-type ty">{askType}</span>
        </header>
        {reply ? (
          <button type="button" className="replychip" onClick={onReply}>
            <span className="replychip-reference rl">{reply.reference}</span>
            {reply.context !== undefined ? (
              <span className="replychip-context rc">{reply.context}</span>
            ) : null}
          </button>
        ) : null}
        {status === "interrupted" ? (
          <p className="chat-message-interrupted">
            This answer was interrupted before it finished.
          </p>
        ) : message.comparison ? (
          <AskAnswers
            question={message.comparison.question}
            result={message.comparison.result}
            showQuestion={false}
          />
        ) : (
          <p className="chat-message-text mt">{message.body}</p>
        )}
        {hasActions ? (
          <div className="chat-message-actions mfrag">
            {onPromote ? (
              <>
                <button
                  type="button"
                  className="thread-promote-btn"
                  onClick={() => onPromote("finding")}
                >
                  finding
                </button>
                <button
                  type="button"
                  className="thread-promote-btn"
                  onClick={() => onPromote("draft-comment")}
                >
                  draft comment
                </button>
              </>
            ) : null}
            {onSubThread ? (
              <button
                type="button"
                className="thread-promote-btn is-subthread"
                onClick={onSubThread}
              >
                discuss reply
              </button>
            ) : null}
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
  selection,
}: {
  state: ConversationHostRenderState;
  bridge: RennetBridge;
  reviewId: string;
  timeoutMs: number;
  anchors: readonly ConversationAnchor[];
  selection?: NonNullable<CommandInput<"review.ask">["selection"]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<AskMode>(DEFAULT_ASK_MODE);
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
  const activeReply =
    activeThread && !activeThread.orphaned ? anchorReply(activeThread.anchor) : null;
  const activeReference = activeThread
    ? activeThread.orphaned
      ? "Orphaned thread"
      : (activeReply?.reference ?? activeThread.anchor.label)
    : undefined;
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
        mode,
        question: body,
        ...(selection === undefined ? {} : { selection }),
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The AI did not answer in time. Try asking again.")),
          timeoutMs,
        );
      });
      const result = await Promise.race([invocation, timeout]);
      const comparison = result.secondOpinion ? { question: body, result } : undefined;
      setGeneralMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          author: "harness",
          model: result.primary.model,
          body: result.primary.answer,
          askType: "general-ask",
          ...(comparison ? { comparison } : {}),
        },
      ]);
      setDraft("");
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
      setDraft("");
    } else {
      if (generalPending) return;
      void askGeneral(body);
    }
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
              showOrphanedMarker={
                entry.thread?.orphaned === true && entry.thread.messages[0]?.id === entry.message.id
              }
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
              const orphaned = thread.orphaned === true;
              const reply = orphaned ? null : anchorReply(thread.anchor);
              const active = thread.id === activeThreadId;
              return (
                <article
                  className={`chat-row chat-row--anchor-context msg is-private${orphaned ? " is-orphaned" : ""}`}
                  data-ask-type="discuss"
                  data-active={active}
                  data-anchor-kind={thread.anchor.kind}
                  data-anchor-key={thread.anchor.key}
                  data-lane={thread.lane}
                  data-orphaned={orphaned || undefined}
                  key={`context:${thread.id}`}
                >
                  <span className="chat-type-icon tico tico--discuss" title="discuss">
                    <CommentIcon size={13} />
                  </span>
                  <div className="chat-message mb">
                    {orphaned ? (
                      <p className="conversation-orphaned" role="note">
                        The code this thread was about is no longer in the diff. It is kept here,
                        but not moved onto other code.
                      </p>
                    ) : null}
                    {reply ? (
                      <button
                        type="button"
                        className="replychip"
                        onClick={() => setActiveThreadId(thread.id)}
                      >
                        <span className="replychip-reference rl">{reply.reference}</span>
                        {reply.context !== undefined ? (
                          <span className="replychip-context rc">{reply.context}</span>
                        ) : null}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="conversation-anchor-context"
                        onClick={() => setActiveThreadId(thread.id)}
                      >
                        {orphaned ? "Orphaned thread" : thread.anchor.label}
                      </button>
                    )}
                    <p className="chat-message-text mt">Reply to this {thread.anchor.kind}…</p>
                  </div>
                </article>
              );
            })}
        </div>

        {activeThread ? (
          <div className="conversation-composer-context">
            <span>{activeReference}</span>
            <button
              type="button"
              aria-label="Clear thread reply"
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
          data-ask-mode={activeThread ? DEFAULT_ASK_MODE : mode}
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
          {activeThread ? (
            <button
              type="button"
              className="conversation-panel-send"
              disabled={draft.trim().length === 0 || activePending}
              onClick={submit}
            >
              Ask
            </button>
          ) : (
            <AskButton
              mode={mode}
              disabled={draft.trim().length === 0 || activePending}
              pending={activePending}
              primaryClassName="conversation-panel-send"
              onModeChange={setMode}
              onAsk={submit}
            />
          )}
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
  selection,
  timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
  onPromote,
}: ConversationPanelProps) {
  return (
    <ConversationHost
      bridge={bridge}
      reviewId={reviewId}
      anchors={anchors}
      autoOpenRequests={autoOpenRequests}
      selection={selection}
      timeoutMs={timeoutMs}
      onPromote={onPromote}
      render={(state) => (
        <PanelSurface
          state={state}
          bridge={bridge}
          reviewId={reviewId}
          timeoutMs={timeoutMs}
          anchors={anchors}
          selection={selection}
        />
      )}
    />
  );
}
