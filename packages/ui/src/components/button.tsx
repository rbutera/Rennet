import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // Every variant carries a REAL hover AND a pressed state. Hover shifts the
      // tone (secondary mixes ink into the fill via --color-secondary-hover, so it
      // darkens on light and lightens on dark — a brightness filter only ever goes
      // one way); pressed darkens with `active:brightness-*`, which reads the same
      // in both schemes. Transparent/bordered variants paint a ground on hover.
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80 active:brightness-90",
        outline:
          "border-border bg-background text-foreground hover:bg-muted hover:border-line-strong active:brightness-95 aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:brightness-90 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "text-foreground hover:bg-muted hover:text-foreground active:brightness-95 aria-expanded:bg-muted aria-expanded:text-foreground",
        // Affineur's Bench soft-gold CTA: the tinted accent action that is not a
        // full gold fill (default) — a warm secondary call to action. Rennet
        // identity, so it speaks the accent ramp directly (theme-backed tokens).
        accent:
          "border-accent-line bg-accent-soft text-ink hover:bg-accent-surface hover:border-accent active:brightness-95 aria-expanded:bg-accent-surface aria-expanded:border-accent",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 active:brightness-95 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Height ramp steps cleanly 6/7/8/9 (the prototype control ramp); the
      // default (h-8) lines up with the kit Input so a row of mixed controls
      // sits flush. (Select's default trigger is still h-9; its sm is h-8.)
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-md px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
