import { GitCommitHorizontal } from "lucide-react";
import { Icon } from "../../components/icon";
import { CodeTabs } from "../../review";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefs } from "./element-context";

// `decision` (C05 3.4) — a recovered design decision: the statement, the why, the
// alternatives weighed, and the evidence. Evidence is a list of `code_ref` ids shown
// as tabbed sites through C4's `CodeTabs`; alternatives are free text.
//
// A decision is a BORDERED CARD, not loose prose (prototype `lens-board.tsx:381-414`):
// the commit glyph and the box are what separate one weighed judgement from the next
// when several sit in a column. The reasoning, the roads not taken and the evidence
// indent under the statement, so the glyph column reads as the decision's spine.

export function DecisionElement({ element }: { readonly element: ElementOf<"decision"> }) {
  const { statement, why, alternatives, evidence, inferred } = element.data;
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(evidence);
  return (
    <div
      data-kind="decision"
      data-element-id={element.id}
      className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <Icon
          icon={GitCommitHorizontal}
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <h3 className="min-w-0 flex-1 font-medium text-13 text-foreground leading-snug">
          <InlineQuoteHighlight text={statement} elementId={element.id} />
        </h3>
        {inferred === true && (
          // The prompts (`prompts/decisions.md:34`) make the model mark a decision it
          // RECONSTRUCTED rather than read off an artifact. The badge is the reader's
          // only warning that the statement is a reconstruction, so it is bound to the
          // stamp and never to its absence.
          <span
            data-kind="decision-inferred"
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-10 text-muted-foreground"
          >
            inferred
          </span>
        )}
      </div>
      <QuoteHighlightLayer
        text={why}
        elementId={element.id}
        patchsetId={patchsetId}
        className="pl-5"
        // 13px, one step UNDER the 13.5px statement above and one over the 12.5px
        // alternatives below (prototype `lens-board.tsx:384-402`). At `text-sm` the
        // reasoning outsized the decision it explains — the hierarchy read inverted.
        paragraphClassName="text-foreground/85 text-13 leading-relaxed"
      />
      {alternatives.length > 0 && (
        // One inline line, not a headed list: the roads not taken are context for the
        // decision, and a heading over two words outweighed the words (prototype
        // `lens-board.tsx:400-402`). Same data, dot-joined.
        <p
          data-kind="decision-alternatives"
          className="pl-5 text-12-5 text-muted-foreground leading-relaxed"
        >
          Not taken: <InlineQuoteHighlight text={alternatives.join(" · ")} elementId={element.id} />
        </p>
      )}
      {citations.length > 0 && (
        <div className="pl-5">
          <CodeTabs citations={citations} />
        </div>
      )}
    </div>
  );
}
