import type { ReattachResult } from "@rennet/protocol";
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

function missingCompletedReplies(
  thread: ReattachResult["threads"][number],
  quoteThread: QuoteThread,
): DurableReply[] {
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
  if (projected.some((text, index) => durable[index]?.text !== text)) return [];
  return durable.slice(projected.length);
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

  useEffect(() => {
    if (!reattach) return;
    for (const thread of reattach.threads) {
      const quoteThread = quoteThreads[thread.threadId];
      if (!quoteThread) continue;
      for (const reply of missingCompletedReplies(thread, quoteThread)) {
        void persistReply(thread.threadId, reply);
      }
    }
  }, [persistReply, quoteThreads, reattach]);

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
