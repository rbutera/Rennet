import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "../lib/utils";

// A determinate/indeterminate progress bar. Base UI's Root carries the
// `role="progressbar"` + `aria-valuenow` semantics; value=null is indeterminate.
// The Indicator width tracks the percentage automatically.
function Progress({ className, value, ...props }: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root data-slot="progress" value={value} {...props}>
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full rounded-full bg-primary transition-all"
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
