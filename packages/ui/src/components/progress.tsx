import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "../lib/utils";

// A determinate/indeterminate progress bar. Base UI's Root carries the
// `role="progressbar"` + `aria-valuenow` semantics; value=null is indeterminate.
// The Indicator width tracks the percentage automatically.
//
// `children` is omitted: this component renders its own Track/Indicator, so a passed
// `children` would be silently dropped. `className` is narrowed to a string too —
// it styles the Track, and Base UI's function form would resolve against the Track's
// state, which is not what a consumer expects.
function Progress({
  className,
  value,
  ...props
}: Omit<ProgressPrimitive.Root.Props, "children" | "className"> & { className?: string }) {
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
