import type { QuoteMessage, ReattachResult } from "@rennet/protocol";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { enqueueReviewerEcho, reviewReattachInput, reviewReattachKey } from "../chat/chat-data";
import { useCommand, useInvoke, useMutation } from "../data";
import { useBridgeContext } from "../data/bridge";
import { type QuoteThread, useRennetStore } from "../store";

export interface AnchoredAskInput {
  readonly threadId: string;
  readonly question: string;
  readonly excerpt: string;
  readonly target?: string;
  readonly generation?: string;
}

export type AnchoredAsk = (input: AnchoredAskInput) => Promise<void>;

const AnchoredAskContext = createContext<AnchoredAsk | null>(null);

/** Injectable provider used by the live review provider and focused component tests. */
export const AnchoredAskProvider = AnchoredAskContext.Provider;

export function useAnchoredAsk(): AnchoredAsk | null {
  return useContext(AnchoredAskContext);
}

interface DurableReply {
  readonly id: string;
  readonly text: string;
}

type ReplyReconciliation =
  | { readonly kind: "append"; readonly replies: readonly DurableReply[] }
  | {
      readonly kind: "replace";
      readonly replies: readonly DurableReply[];
      readonly messages: readonly QuoteMessage[];
    };

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((value, index) => right[index] === value);
}

function reconcileCompletedReplies(
  thread: ReattachResult["threads"][number],
  quoteThread: QuoteThread,
): ReplyReconciliation {
  const durable = thread.messages.flatMap((message) =>
    message.author === "harness" &&
    (message.status === undefined || message.status === "complete") &&
    message.body.length > 0
      ? [{ id: message.id, text: message.body }]
      : [],
  );
  const projected = quoteThread.messages.flatMap((message) =>
    message.author === "orchestrator" ? [message.text] : [],
  );
  const durableTexts = durable.map((reply) => reply.text);
  if (isPrefix(projected, durableTexts)) {
    return { kind: "append", replies: durable.slice(projected.length) };
  }
  if (isPrefix(durableTexts, projected) || durable.length < projected.length) {
    return { kind: "append", replies: [] };
  }
  const messages: QuoteMessage[] = [];
  for (const message of thread.messages) {
    if (message.author === "you") {
      messages.push({ author: "user", text: message.body });
    } else if (
      (message.status === undefined || message.status === "complete") &&
      message.body.length > 0
    ) {
      messages.push({ author: "orchestrator", text: message.body });
    }
  }
  return { kind: "replace", replies: durable, messages };
}

/** Bind anchored board exchanges to the review's one durable `review.ask` path. */
export function ReviewAnchoredAskProvider({
  reviewId,
  children,
}: {
  readonly reviewId: string;
  readonly children: ReactNode;
}) {
  const ask = useMutation("review.ask");
  const invoke = useInvoke();
  const { cache } = useBridgeContext();
  const quoteThreads = useRennetStore((state) => state.review.quoteThreads);
  const { data: reattach } = useCommand("review.reattach", reviewReattachInput(reviewId));
  const claimedReplies = useRef(new Set<string>());
  const claimedRepairs = useRef(new Set<string>());
  const persistReply = useCallback(
    async (threadId: string, reply: DurableReply): Promise<void> => {
      const key = `${reviewId}\u0000${threadId}\u0000${reply.id}`;
      if (claimedReplies.current.has(key)) return;
      claimedReplies.current.add(key);
      try {
        await invoke("ask.quoteReply", {
          sessionId: reviewId,
          threadId,
          author: "orchestrator",
          text: reply.text,
        });
      } catch {
        claimedReplies.current.delete(key);
      }
    },
    [invoke, reviewId],
  );
  const replaceReplies = useCallback(
    async (
      threadId: string,
      quoteThread: QuoteThread,
      reconciliation: Extract<ReplyReconciliation, { kind: "replace" }>,
    ): Promise<void> => {
      const repairKey = `${reviewId}\u0000${threadId}\u0000${reconciliation.replies
        .map((reply) => reply.id)
        .join("\u0000")}`;
      if (claimedRepairs.current.has(repairKey)) return;
      claimedRepairs.current.add(repairKey);
      const newlyClaimed: string[] = [];
      for (const reply of reconciliation.replies) {
        const key = `${reviewId}\u0000${threadId}\u0000${reply.id}`;
        if (claimedReplies.current.has(key)) continue;
        claimedReplies.current.add(key);
        newlyClaimed.push(key);
      }
      try {
        await invoke("ask.quoteOpen", {
          sessionId: reviewId,
          threadId,
          thread: { ...quoteThread, messages: [...reconciliation.messages] },
        });
      } catch {
        claimedRepairs.current.delete(repairKey);
        for (const key of newlyClaimed) claimedReplies.current.delete(key);
      }
    },
    [invoke, reviewId],
  );

  useEffect(() => {
    if (!reattach) return;
    for (const thread of reattach.threads) {
      const quoteThread = quoteThreads[thread.threadId];
      if (!quoteThread) continue;
      const reconciliation = reconcileCompletedReplies(thread, quoteThread);
      if (reconciliation.kind === "replace") {
        void replaceReplies(thread.threadId, quoteThread, reconciliation);
        continue;
      }
      for (const reply of reconciliation.replies) {
        void persistReply(thread.threadId, reply);
      }
    }
  }, [persistReply, quoteThreads, reattach, replaceReplies]);

  const send = useCallback<AnchoredAsk>(
    async ({ threadId, question, excerpt, target, generation }) => {
      const turnId = crypto.randomUUID();
      enqueueReviewerEcho(cache, reviewReattachKey(reviewId), {
        threadId,
        id: `${turnId}::you`,
        body: question,
      });
      try {
        const answer = await ask.mutate({
          commandId: crypto.randomUUID(),
          reviewId,
          question,
          threadId,
          turnId,
          turnBody: question,
          anchor: {
            kind: "fragment",
            label: excerpt.slice(0, 120),
            key: threadId,
            context: excerpt,
          },
          selection: {
            anchor:
              target === undefined
                ? `quote:${threadId}`
                : `board:${generation ?? "unknown"}:${target}`,
            excerpt,
            ...(target === undefined ? {} : { target }),
            ...(generation === undefined ? {} : { generation }),
          },
        });
        await persistReply(threadId, {
          id: `${turnId}::orchestrator`,
          text: answer.primary.answer,
        });
      } catch {
        // useMutation retains the command error; callers intentionally fire anchored asks in-place.
      }
    },
    [ask, cache, persistReply, reviewId],
  );

  return <AnchoredAskProvider value={send}>{children}</AnchoredAskProvider>;
}
