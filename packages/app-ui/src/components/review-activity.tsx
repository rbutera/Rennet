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
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="absolute inset-0 size-full animate-spin motion-reduce:animate-none"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="24 39"
        />
      </svg>
      <span
        aria-hidden="true"
        className="size-1 rounded-full bg-current animate-processing-pulse motion-reduce:animate-none"
      />
    </span>
  );
}
