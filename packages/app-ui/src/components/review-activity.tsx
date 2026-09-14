import { cn } from "@rennet/ui";

export function ReviewActivity({
  className,
  label = "Reviewing the change",
}: {
  readonly className?: string;
  readonly label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "relative inline-flex size-5 shrink-0 items-center justify-center text-primary",
        className,
      )}
    >
      {/* The vessel: a faint static ring holding the mark. No rotation — a spinning arc
          reads as a generic loader; the life is in the breath of the core, not a sweep. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full border border-current opacity-20"
      />
      {/* A soft halo that breathes with the core, so the whole ring warms and settles
          rather than a lone dot pulsing in a static frame. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-current animate-seat-halo motion-reduce:hidden"
      />
      {/* The core: swells and dims on the calm sine curve. At rest (reduced motion) it is a
          steady filled dot inside the ring — still an unmistakable "working" mark. */}
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-current animate-seat-breathe motion-reduce:animate-none"
      />
    </span>
  );
}
