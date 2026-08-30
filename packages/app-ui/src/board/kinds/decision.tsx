import { CodeTabs } from "../../review";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefs } from "./element-context";

// `decision` (C05 3.4) — a recovered design decision: the statement, the why, the
// alternatives weighed, and the evidence. Evidence is a list of `code_ref` ids shown
// as tabbed sites through C4's `CodeTabs`; alternatives are free text.

export function DecisionElement({ element }: { readonly element: ElementOf<"decision"> }) {
  const { statement, why, alternatives, evidence } = element.data;
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(evidence);
  return (
    <div data-kind="decision" data-element-id={element.id} className="flex flex-col gap-1.5">
      <h3 className="font-medium text-13 text-foreground leading-snug">
        <InlineQuoteHighlight text={statement} elementId={element.id} />
      </h3>
      <QuoteHighlightLayer
        text={why}
        elementId={element.id}
        patchsetId={patchsetId}
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
          className="text-12-5 text-muted-foreground leading-relaxed"
        >
          Not taken: <InlineQuoteHighlight text={alternatives.join(" · ")} elementId={element.id} />
        </p>
      )}
      {citations.length > 0 && <CodeTabs citations={citations} />}
    </div>
  );
}
