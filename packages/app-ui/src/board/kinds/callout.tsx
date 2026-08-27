import { cn } from "@rennet/ui";
import { Info, TriangleAlert } from "lucide-react";
import { Icon } from "../../components/icon";
import { RichText } from "../../review";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId } from "./element-context";

// `callout` (C05 3.1) — an emphasized aside. `variant` picks the tone: `warn` reads
// danger-toned (the one warning hue the palette carries), anything else reads as a
// neutral `info` aside. Body is markdown through `RichText`. Theme tokens only.

export function CalloutElement({ element }: { readonly element: ElementOf<"callout"> }) {
  const { variant, body } = element.data;
  const patchsetId = useBoardPatchsetId();
  const warn = variant === "warn";
  return (
    <div
      data-kind="callout"
      data-variant={variant}
      className={cn(
        "flex gap-2 rounded-md border px-3 py-2.5",
        warn ? "border-danger/40 bg-danger-soft" : "border-border bg-secondary/40",
      )}
    >
      <Icon
        icon={warn ? TriangleAlert : Info}
        className={cn("mt-0.5 size-4 shrink-0", warn ? "text-danger" : "text-muted-foreground")}
      />
      <RichText
        text={body}
        patchsetId={patchsetId}
        paragraphClassName="text-sm leading-relaxed text-foreground/90"
      />
    </div>
  );
}
