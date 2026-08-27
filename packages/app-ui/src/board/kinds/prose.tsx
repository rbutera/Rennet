import { RichText } from "../../review";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId } from "./element-context";

// `prose` (C05 3.1) — the agent's freeform markdown surface, rendered through C4's
// `RichText` (the R45 subset: citations, code spans, bold, bullets). Nothing bespoke.

export function ProseElement({ element }: { readonly element: ElementOf<"prose"> }) {
  const patchsetId = useBoardPatchsetId();
  return (
    <div data-kind="prose">
      <RichText
        text={element.data.markdown}
        patchsetId={patchsetId}
        paragraphClassName="text-sm leading-relaxed text-foreground/90"
      />
    </div>
  );
}
