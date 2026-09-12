import type { CodeRef } from "@rennet/protocol";
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
  readonly codeRef?: CodeRef;
  readonly question: string;
  readonly excerpt: string;
  readonly target?: string;
  readonly generation?: string;
  /**
   * The board the span was highlighted on — `design`, `flagged`, and so on
   * (session-thread-briefing 4.3). A `CodeRef` carries the patchset, the path, the side and
   * the lines; it carries NO board and no lens, which is why the reference has to be
   * labelled by the caller that knows. A selection made outside a board (the diff itself)
   * has none, and the labelled line then names only what it can.
   */
  readonly lens?: string;
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

/** Byte bounds on the labelled anchor line's own interpolations. A board id, a lens name
 *  and an element id are short; a path is a path. Each is cut rather than sent whole. */
const LENS_CEILING = 32;
const TARGET_CEILING = 96;
const GENERATION_CEILING = 96;
const PATH_CEILING = 240;

const cut = (text: string, ceiling: number): string =>
  text.length > ceiling ? `${text.slice(0, ceiling)}…` : text;

/**
 * The sentence that says what the reference below it IS (session-thread-briefing 4.3).
 *
 * `Code reference: {"patchsetId":…}` on its own is an opaque blob: a `CodeRef`
 * (`protocol/delta/citations.ts`) carries the patchset, the path, the diff side and the
 * line range, and NOTHING about where the reviewer was looking when they highlighted it.
 * The thread's briefing tells it that the line before the reference names where the span
 * came from — so this is the line that makes that true.
 *
 * Rendered only WITH a reference, because that is the thing it labels. What it can name
 * varies by where the selection was made: a board selection knows its lens, its element and
 * its generation; a selection on the diff knows only the file and the lines.
 */
function anchorLabel(
  input: Pick<AnchoredAskInput, "codeRef" | "lens" | "target" | "generation">,
): string {
  const ref = input.codeRef;
  if (ref === undefined) return "";
  const where: string[] = [];
  if (input.lens) where.push(`the ${cut(input.lens, LENS_CEILING)} board`);
  if (input.target) where.push(`element ${cut(input.target, TARGET_CEILING)}`);
  if (input.generation) where.push(`generation ${cut(input.generation, GENERATION_CEILING)}`);
  const lines =
    ref.startLine === ref.endLine
      ? `line ${ref.startLine}`
      : `lines ${ref.startLine}–${ref.endLine}`;
  const span = `${cut(ref.path, PATH_CEILING)} ${lines} (${ref.side} side)`;
  return `Anchor: ${where.length === 0 ? "" : `${where.join(", ")} — `}${span}.`;
}

/** The turn text: the question, the span it was asked about, then the labelled reference. */
export function anchoredAskText(
  input: Pick<
    AnchoredAskInput,
    "question" | "excerpt" | "codeRef" | "lens" | "target" | "generation"
  >,
): string {
  const excerpt =
    input.excerpt.length > EXCERPT_CEILING
      ? `${input.excerpt.slice(0, EXCERPT_CEILING)}… (truncated)`
      : input.excerpt;
  const identity = input.codeRef === undefined ? "" : JSON.stringify(input.codeRef);
  const boundedIdentity =
    identity.length > 2048 ? `${identity.slice(0, 2048)}… (truncated)` : identity;
  const reference = boundedIdentity
    ? `\n\n${anchorLabel(input)}\nCode reference: ${boundedIdentity}`
    : "";
  return (
    (excerpt === "" ? input.question : `${input.question}\n\nAbout this: ${excerpt}`) + reference
  );
}

/**
 * A thrown transport failure as a sentence the reviewer can act on.
 *
 * `ConnectionError` is matched STRUCTURALLY on `name`, not with `instanceof`: app-ui may not
 * import `@rennet/client`, and the two failures deserve different sentences — a daemon that
 * died is worth retrying once it is back, a command that failed is not.
 */
export function describeAskFailure(reason: unknown): string {
  const named = reason as { name?: unknown; message?: unknown } | null;
  if (named !== null && typeof named === "object" && named.name === "ConnectionError") {
    return "Lost the connection to the daemon before the question went out.";
  }
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  const text = String(reason);
  return text.length > 0 ? text : "The question could not be sent.";
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
  const setQuoteAskFailure = useRennetStore((state) => state.reviewActions.setQuoteAskFailure);

  const ask = useCallback<AnchoredAsk>(
    async ({ threadId, question, excerpt, codeRef, lens, target, generation }) => {
      // Open the dock FIRST: the answer arrives in T3's view, so a reviewer who asked and
      // saw nothing open would think the ask was dropped.
      setChatOpen(true);
      // Clear the previous attempt's failure before this one has an outcome, so a retry does
      // not read as still-failed while it is in flight.
      setQuoteAskFailure(threadId, undefined);
      try {
        const result = await send.mutate({
          reviewId,
          text: anchoredAskText({ question, excerpt, codeRef, lens, target, generation }),
        });
        // A SETTLED ABSENCE, not a rejection: the daemon reached a verdict and it was "this
        // did not go out" (#872's shape, extended to the send in #888). The reason is the
        // daemon's own sentence and reaches the reviewer verbatim.
        if (result.status === "unavailable") setQuoteAskFailure(threadId, result.reason);
      } catch (reason) {
        // The rejection that CANNOT be a state: the transport itself failed, so no daemon
        // verdict exists. `ws-bridge` fails an in-flight invoke fast on a dropped connection
        // with no offline queue, which is exactly what a daemon that just died looks like.
        //
        // This is read HERE and not from `send.error`, which is real but unusable: the
        // provider renders no DOM of its own, and `useMutation` runs `setError(undefined)` at
        // the start of every call, so a second ask erases the first failure's evidence while
        // the reviewer is still reading it.
        setQuoteAskFailure(threadId, describeAskFailure(reason));
      }
    },
    [reviewId, send, setChatOpen, setQuoteAskFailure],
  );

  return <AnchoredAskProvider value={ask}>{children}</AnchoredAskProvider>;
}
