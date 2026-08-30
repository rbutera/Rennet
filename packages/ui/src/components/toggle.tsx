import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClassName } from "../lib/utils";

// A two-state button (on/off). Used standalone or, with a `value`, as a member
// of a ToggleGroup — the kit's answer to hand-rolled `aria-pressed` markup.
// The lit state is the QUIET raised fill, never the gold accent: gold is Rennet's
// reserve accent (root DESIGN.md), and a segmented control lighting up gold shouts
// over the content it filters. `spikes/board-prototype` is authoritative here — its
// toggle and its hand-rolled segmented trays both light with `bg-muted`/`bg-secondary`
// (both alias to raised) and plain `text-foreground`.
const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap text-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring data-disabled:pointer-events-none data-disabled:opacity-50 data-pressed:bg-muted data-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent data-pressed:border-transparent",
      },
      size: {
        // `sm` is the segmented-tray step: 12px label, 3.5 glyphs, and the micro
        // radius that nests inside the tray's 6px corner across its 2px padding.
        // (The prototype splits the difference at a literal 5px, which is off the
        // Rennet radius scale; 4px is its sanctioned neighbour — packages/app-ui/DESIGN.md.)
        default: "h-8 min-w-8 px-2",
        sm: "h-7 min-w-7 rounded-sm px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={mergeClassName(toggleVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
