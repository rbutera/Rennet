import { Loader2Icon, type LucideProps } from "lucide-react";

import { cn } from "../lib/utils";

// The kit's one busy glyph. Every surface that hand-rolled `<Loader2 className="…
// animate-spin" />` was re-deciding the glyph, the size, and the stroke weight in
// isolation; this fixes all three in one place at Rennet's 1.6px line weight (root
// DESIGN.md). Size on the ramp via className (`size-3`, `size-5`, …).
//
// It announces itself as a live region by default. A spinner that sits INSIDE a
// control already carrying its own pending label ("Connecting…") is decorative —
// pass `aria-hidden` there so the label is the only announcement.
function Spinner({ className, strokeWidth = 1.6, ...props }: LucideProps) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      strokeWidth={strokeWidth}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
