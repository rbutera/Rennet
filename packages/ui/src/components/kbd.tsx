import type * as React from "react";
import { cn } from "../lib/utils";

// A styled <kbd> for keyboard-shortcut hints. No Base UI primitive underneath —
// just semantic markup themed by tokens. Sizing rides the existing type ramp
// (text-xs), no bracketed pixel sizes.
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
