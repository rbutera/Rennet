import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // Every variant carries a REAL hover AND a pressed state. Fills brighten a
      // touch on hover and darken when pressed (brightness reads the same in both
      // schemes, unlike an opacity fade onto the ground); transparent/bordered
      // variants paint a ground on hover then darken on press. All colour lives in
      // the Bench ramp — no opacity fades standing in for a tone shift.
      variant: {
        default: "bg-primary text-primary-foreground hover:brightness-110 active:brightness-90",
        outline:
          "border-border bg-background text-foreground hover:bg-muted hover:border-line-strong active:brightness-95 aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:brightness-110 active:brightness-90 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
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
      // Height ramp steps cleanly 7/8/9/10; the default (h-9) lines up with the
      // kit Input and Select trigger so a row of mixed controls sits flush.
      size: {
        default: "h-9 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-7 gap-1 rounded-md px-2.5 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 rounded-md px-3 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-9",
        "icon-xs":
          "size-7 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8 rounded-md in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-10",
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
