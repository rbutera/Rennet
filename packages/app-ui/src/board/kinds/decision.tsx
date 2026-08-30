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
      <h3 className="font-semibold text-base text-foreground leading-snug">
        <InlineQuoteHighlight text={statement} elementId={element.id} />
      </h3>
      <QuoteHighlightLayer
        text={why}
        elementId={element.id}
        patchsetId={patchsetId}
        paragraphClassName="text-foreground/85 text-sm leading-relaxed"
      />
      {alternatives.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="font-medium text-sm text-foreground">Alternatives considered</h4>
          <ul className="flex list-disc flex-col gap-0.5 pl-5 text-foreground/80 text-sm marker:text-muted-foreground/60">
            {alternatives.map((alt) => (
              <li key={alt}>
                <InlineQuoteHighlight text={alt} elementId={element.id} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {citations.length > 0 && <CodeTabs citations={citations} />}
    </div>
  );
}
