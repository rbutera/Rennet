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
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full border border-current opacity-20"
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-current border-r-current motion-reduce:animate-none"
      />
      <span
        aria-hidden="true"
        className="size-1 rounded-full bg-current animate-processing-pulse motion-reduce:animate-none"
      />
    </span>
  );
}
