import { QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId } from "./element-context";

// `prose` (C05 3.1) — the agent's freeform markdown surface, rendered through C4's
// `RichText` (the R45 subset: citations, code spans, bold, bullets) wrapped in C05's
// durable quote-highlight layer (cluster 5): a thread anchored in this prose renders
// highlighted and reveals its exchange. With no anchor here, the layer is `RichText`
// verbatim — nothing bespoke.

export function ProseElement({ element }: { readonly element: ElementOf<"prose"> }) {
  const patchsetId = useBoardPatchsetId();
  return (
    <div data-kind="prose">
      <QuoteHighlightLayer
        text={element.data.markdown}
        patchsetId={patchsetId}
        paragraphClassName="text-sm leading-relaxed text-foreground/90"
      />
    </div>
  );
}
