import { cn } from "@rennet/ui";
import { basename } from "../canvas/symbol";

// ─────────────────────────────────────────────────────────────────────────────
// The shared `basename:line` chip (C4). ONE presentational component used by both
// code-tabs (the tab pills, the anchor-reveal chips) and rich-text (inline citation
// chips), instead of each hand-rolling its own markup (the spike duplicated it). The
// label is `basename:line` (or `basename:start-end`); the full path is the title.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReferenceChipProps {
  readonly path: string;
  readonly startLine: number;
  readonly endLine?: number;
  /** Rendered "on" — the active tab, or a revealed citation. */
  readonly active?: boolean;
  readonly onClick?: () => void;
  /** Overrides the default title (the full path). */
  readonly title?: string;
  readonly className?: string;
}

export function ReferenceChip({
  path,
  startLine,
  endLine,
  active = false,
  onClick,
  title,
  className,
}: ReferenceChipProps) {
  const range =
    endLine != null && endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`;
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title ?? path}
      onClick={onClick}
      className={cn(
        "w-fit rounded border px-1.5 py-0.5 font-mono text-2xs transition-colors",
        active
          ? "border-border bg-secondary text-foreground"
          : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
        className,
      )}
    >
      {basename(path)}:{range}
    </button>
  );
}
