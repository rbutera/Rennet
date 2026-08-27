import { AnchorReveal } from "../../review";
import { QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefOf } from "./element-context";

// `annotation` (C05 3.1) — prose anchored to cited code. The `code_ref` attribute is
// an element id resolved through the board pool to its CodeRef, revealed on click via
// C4's `AnchorReveal` (span-read seam, honest error while unbound); the body is
// markdown through `RichText`.

export function AnnotationElement({ element }: { readonly element: ElementOf<"annotation"> }) {
  const patchsetId = useBoardPatchsetId();
  const ref = useCodeRefOf(element.data.code_ref);
  return (
    <div data-kind="annotation" data-element-id={element.id} className="flex flex-col gap-1.5">
      {ref && <AnchorReveal citations={[ref]} />}
      <QuoteHighlightLayer
        text={element.data.body}
        elementId={element.id}
        patchsetId={patchsetId}
        paragraphClassName="text-sm leading-relaxed text-foreground/90"
      />
    </div>
  );
}
