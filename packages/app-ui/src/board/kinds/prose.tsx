import { DesignGlossaryTerm, DesignTaskMetadata } from "../design-meta";
import { QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId } from "./element-context";

// `prose` (C05 3.1) — the agent's freeform markdown surface, rendered through C4's
// `RichText` (the R45 subset: citations, code spans, bold, bullets) wrapped in C05's
// durable quote-highlight layer (cluster 5): a thread anchored in this prose renders
// highlighted and reveals its exchange. With no anchor here, the layer is `RichText`
// verbatim — nothing bespoke.

// Both overrides exist for ONE caller: `requirement.tsx` renders a scenario as a nested
// prose element inside a flex row that has already set its own size, and inside a column
// far narrower than a top-level prose block. Defaulted, so the registry entry (which
// passes `element` alone) still gets the top-level reading measure and size.
export function ProseElement({
  element,
  className = "max-w-[640px]",
  paragraphClassName = "text-sm leading-relaxed text-foreground/90",
}: {
  readonly element: ElementOf<"prose">;
  /** The reading measure. `""` from a nested caller whose container owns the width. */
  readonly className?: string;
  /** The body type. A nested caller passes the size its row already declared. */
  readonly paragraphClassName?: string;
}) {
  const patchsetId = useBoardPatchsetId();
  const prose = (
    <QuoteHighlightLayer
      text={element.data.markdown}
      elementId={element.id}
      patchsetId={patchsetId}
      // The 640px measure belongs to the prose element, not the board column: board
      // rows and chips still run the full width (prototype `lens-board.tsx:149`).
      className={className}
      paragraphClassName={paragraphClassName}
    />
  );
  return (
    <div data-kind="prose" data-element-id={element.id}>
      <DesignGlossaryTerm value={element.data.glossary_term} fallback={prose} />
      <DesignTaskMetadata
        requirementRefs={element.data.requirement_refs}
        acceptanceCriteria={element.data.acceptance_criteria}
      />
    </div>
  );
}
