import { cn } from "@rennet/ui";
import { QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId } from "./element-context";

// `callout` (C05 3.1) — an emphasized aside. `variant` picks the tone: `warn` takes a
// barely-there danger wash and its border, anything else reads as a neutral `info`
// aside. No icon column: the tint IS the signal, and a glyph on every aside turns a
// quiet emphasis into an alarm (prototype `lens-board.tsx:333-341`). Body is markdown
// through `RichText`. Theme tokens only.

export function CalloutElement({ element }: { readonly element: ElementOf<"callout"> }) {
  const { variant, body } = element.data;
  const patchsetId = useBoardPatchsetId();
  const warn = variant === "warn";
  return (
    <div
      data-kind="callout"
      data-variant={variant}
      data-element-id={element.id}
      className={cn(
        "rounded-md border px-3 py-2",
        warn ? "border-destructive/40 bg-destructive/5" : "border-border bg-secondary/40",
      )}
    >
      <QuoteHighlightLayer
        text={body}
        elementId={element.id}
        patchsetId={patchsetId}
        paragraphClassName="text-13 leading-relaxed text-foreground/90"
      />
    </div>
  );
}
