import { cn } from "@rennet/ui";
import { AnchorReveal, RichText } from "../../review";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefs } from "./element-context";

// `requirement` (C05 3.4) — a shall-requirement and how the change covers it. A
// coverage chip reads the `met | gap | partial` verdict (green / danger / gold); the
// `trace` code_refs reveal on click through `AnchorReveal`. `shall` renders with the
// normative-grammar bolding (SHALL/WHEN/THEN) `RichText` already carries.

const COVERAGE_CHIP: Record<"met" | "gap" | "partial", string> = {
  met: "border-green-line text-green",
  gap: "border-danger/40 text-danger",
  partial: "border-primary/40 text-primary",
};

export function RequirementElement({ element }: { readonly element: ElementOf<"requirement"> }) {
  const { shall, coverage, trace } = element.data;
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(trace);
  return (
    <div data-kind="requirement" data-coverage={coverage} className="flex flex-col gap-1.5">
      <span
        className={cn(
          "w-fit rounded border px-1.5 py-0.5 font-medium text-2xs uppercase tracking-wide",
          COVERAGE_CHIP[coverage],
        )}
      >
        {coverage}
      </span>
      <RichText
        text={shall}
        patchsetId={patchsetId}
        keywords
        paragraphClassName="text-foreground/90 text-sm leading-relaxed"
      />
      {citations.length > 0 && <AnchorReveal citations={citations} />}
    </div>
  );
}
