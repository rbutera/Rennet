import type * as React from "react";
import { cn } from "../lib/utils";

// A styled <kbd> for keyboard-shortcut hints. No Base UI primitive underneath —
// just semantic markup themed by tokens. The quiet inline form: an outline and a
// hair of padding, no fill and no fixed box, so a hint sits inside a row of text
// instead of stamping a chip on it. Sizing rides the ramp (text-10).
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "rounded border border-border px-1 py-0.5 text-10 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
