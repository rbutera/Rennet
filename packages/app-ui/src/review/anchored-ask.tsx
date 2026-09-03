import type { ReactNode } from "react";
import { createContext, useCallback, useContext } from "react";
import { useMutation } from "../data";
import { useRennetStore } from "../store";

// "Ask about this span" (t3-lens-threads 4.2). The question used to run on Rennet's own
// orchestrator through `review.ask`, whose answer was reconciled back into the quote
// thread. That session is retired: the ask now starts a turn on the review's T3 thread
// (`chat.t3Send`) and OPENS THE CHAT, where T3's own view streams the answer. The quote
// thread keeps the reviewer's own question as its record of what was asked; nothing here
// fabricates an orchestrator reply it can no longer see.

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

/** The cited excerpt's byte bound. The turn text is the question plus one quoted line;
 *  a long selection is cut with an honest marker rather than sent whole. */
const EXCERPT_CEILING = 600;

/** The turn text: the question, then the span it was asked about, as one quoted line. */
export function anchoredAskText(input: Pick<AnchoredAskInput, "question" | "excerpt">): string {
  const excerpt =
    input.excerpt.length > EXCERPT_CEILING
      ? `${input.excerpt.slice(0, EXCERPT_CEILING)}… (truncated)`
      : input.excerpt;
  return excerpt === "" ? input.question : `${input.question}\n\nAbout this: ${excerpt}`;
}

/** Bind anchored board exchanges to the review's T3 thread. */
export function ReviewAnchoredAskProvider({
  reviewId,
  children,
}: {
  readonly reviewId: string;
  readonly children: ReactNode;
}) {
  const send = useMutation("chat.t3Send");
  const setChatOpen = useRennetStore((state) => state.uiActions.setChatOpen);

  const ask = useCallback<AnchoredAsk>(
    async ({ question, excerpt }) => {
      // Open the dock FIRST: the answer arrives in T3's view, so a reviewer who asked and
      // saw nothing open would think the ask was dropped.
      setChatOpen(true);
      try {
        await send.mutate({ reviewId, text: anchoredAskText({ question, excerpt }) });
      } catch {
        // useMutation retains the command error; callers fire anchored asks in place.
      }
    },
    [reviewId, send, setChatOpen],
  );

  return <AnchoredAskProvider value={ask}>{children}</AnchoredAskProvider>;
}
