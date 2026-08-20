import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../lib/utils";

// Two registers. `default` is the compact solid-primary control. `backlight` is the
// Affineur's Bench private/local register (root DESIGN.md §Colors): a soft-gold track
// with an accent border, an inset glow, and a gold knob when on — the treatment the
// front-door "include" toggle carries. Restored into the kit so no call site re-skins
// a switch by hand.
const trackVariants = {
  default:
    "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-50",
  backlight:
    "peer group/switch relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border p-0.5 transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-unchecked:border-line-strong data-unchecked:bg-raised data-checked:border-accent-line data-checked:bg-accent-soft data-checked:shadow-[inset_0_0_10px_var(--rn-accent-soft)] data-disabled:cursor-not-allowed data-disabled:opacity-50",
} as const;

const thumbVariants = {
  default:
    "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0",
  backlight:
    "pointer-events-none block h-[17px] w-[17px] rounded-full ring-0 transition-transform data-unchecked:bg-ink-faint data-checked:translate-x-[17px] data-checked:bg-accent",
} as const;

function Switch({
  className,
  size = "default",
  variant = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
  variant?: "default" | "backlight";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(trackVariants[variant], className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={thumbVariants[variant]} />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
