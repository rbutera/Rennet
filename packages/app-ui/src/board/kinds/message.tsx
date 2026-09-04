import { cn } from "@rennet/ui";
import type { ElementOf } from "../registry";
import { BoardAnchorReveal } from "./board-anchor-reveal";
import { useCodeRefOf } from "./element-context";

// `message` (C05 3.5) — the conversational / ask kind. Surfaces the `role`, the ask
// `lifecycle` (a `detached` message is read DISTINCTLY and never dropped, #462 R34),
// the quoted span it replies to (`quote_target`/`quote`, surfaced here for cluster 5's
// durable highlight), and any cited `code_ref` anchor. The exchange TEXT lives
// transcript-side (the `review` slice, Reconciliation 5) — cluster 5 renders the
// thread; here the board element carries only its anchors and lifecycle.
//
// Shape is the prototype's in-board exchange (`lens-board.tsx:359-377`): a left rail,
// and the human's contribution as a chat bubble rather than a bordered card with a
// ROLE pill. What the rail can show is bounded by the wire: `messageData`
// (`protocol/src/board/schema.ts:214-227`) carries no message body, so the bubble
// holds the QUOTED SPAN — the only text the element has — and the prototype's
// model-side reply paragraphs have nothing to bind to. The role and lifecycle stay
// (they are the app's own, and `detached` must remain legible, R34), demoted to a
// caption line so the quoted words lead.

const ROLE_LABEL: Record<ElementOf<"message">["data"]["role"], string> = {
  finding: "Finding",
  question: "Question",
  discuss: "Discuss",
  "request-change": "Request change",
};

export function MessageElement({ element }: { readonly element: ElementOf<"message"> }) {
  const { role, code_ref, quote, lifecycle, author } = element.data;
  const ref = useCodeRefOf(code_ref);
  const detached = lifecycle === "detached";
  const human = author.kind === "human";
  return (
    <div
      data-kind="message"
      data-role={role}
      data-lifecycle={lifecycle ?? "none"}
      className={cn(
        "flex flex-col gap-2 border-l-2 pl-3",
        detached ? "border-dashed border-border opacity-70" : "border-border",
      )}
    >
      {ref && <BoardAnchorReveal citations={[ref]} />}
      {quote &&
        // Still a `blockquote`: the words are literally quoted from the board, and the
        // bubble is the human side of the exchange, not a new utterance.
        (human ? (
          <div className="flex justify-start">
            <blockquote
              data-kind="message-bubble"
              className="max-w-[480px] rounded-lg bg-secondary px-2.5 py-1.5 text-13 text-foreground/95 leading-relaxed"
            >
              {quote.quote}
            </blockquote>
          </div>
        ) : (
          <blockquote
            data-kind="message-bubble"
            className="max-w-[560px] text-13 text-foreground/85 leading-relaxed"
          >
            {quote.quote}
          </blockquote>
        ))}
      <p className="flex items-center gap-1.5 text-10 text-muted-foreground uppercase tracking-wide">
        <span>{ROLE_LABEL[role]}</span>
        {lifecycle && (
          <>
            <span aria-hidden="true">·</span>
            <span className={cn(detached && "font-medium text-danger")}>{lifecycle}</span>
          </>
        )}
      </p>
    </div>
  );
}
