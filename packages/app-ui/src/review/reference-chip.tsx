import { cn } from "@rennet/ui";
import { basename } from "../canvas/symbol";

// ─────────────────────────────────────────────────────────────────────────────
// The standalone `basename:line` chip (C4). It is what `AnchorReveal` reveals citations
// with: chips sitting on their own line, where the border is what makes them read as
// citations. The two surfaces that DON'T use it both sit inside something else — a
// CodeTabs tab strip and a citation mid-sentence — and each carries its own quieter
// treatment there. Full path stays in the title for hover.
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
