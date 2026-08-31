import { cn } from "@rennet/ui";
import { Layers, RefreshCw } from "lucide-react";
import { Icon } from "../components/icon";
import type { CompactBoundaryRow, ContextRebuiltRow, ContextWindow } from "./chat-data";

// ─────────────────────────────────────────────────────────────────────────────
// CompactionRow + ContextMeter (C07, reconciliation 7, #466). Compaction is rendered
// HONESTLY: a `compact_boundary` timeline row marks where the harness compacted the
// session, and the ask-don't-estimate meter shows the harness-reported figure or says
// it does not know. Rennet NEVER estimates a token budget — the meter reads the
// projection's real figure (the boundary's own before→after, else the current context
// window) or renders "unknown". Data is B9's (stubbed via the projection today); the
// honest rendering is C7's.
// ─────────────────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** The honest context meter: the harness figure, or "unknown" — never a fabricated number. */
export function ContextMeter({
  row,
  contextWindow,
}: {
  readonly row: CompactBoundaryRow;
  readonly contextWindow?: ContextWindow;
}) {
  // Prefer the boundary's own reported figures; else the current window; else unknown.
  if (row.tokensBefore !== undefined || row.tokensAfter !== undefined) {
    const before = row.tokensBefore !== undefined ? formatTokens(row.tokensBefore) : "unknown";
    const after = row.tokensAfter !== undefined ? formatTokens(row.tokensAfter) : "unknown";
    return (
      <span className="tabular-nums" data-context="reported">
        {before} → {after} tokens
      </span>
    );
  }
  if (contextWindow) {
    const pct =
      contextWindow.limit > 0 ? Math.round((contextWindow.used / contextWindow.limit) * 100) : 0;
    return (
      <span className="tabular-nums" data-context="reported">
        {formatTokens(contextWindow.used)} / {formatTokens(contextWindow.limit)} tokens ({pct}%)
      </span>
    );
  }
  // Ask, don't estimate: the harness reported no figure.
  return (
    <span data-context="unknown" className="italic">
      context unknown
    </span>
  );
}

export function CompactionRow({
  row,
  contextWindow,
  className,
}: {
  readonly row: CompactBoundaryRow;
  readonly contextWindow?: ContextWindow;
  readonly className?: string;
}) {
  return (
    <div
      className={cn("flex items-center gap-3 text-2xs text-muted-foreground", className)}
      data-testid="compaction-row"
      data-row-id={row.id}
    >
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="flex items-center gap-1.5">
        <Icon icon={Layers} className="size-3 shrink-0" aria-hidden="true" />
        <span>Context compacted</span>
        <span aria-hidden="true">·</span>
        <ContextMeter row={row} contextWindow={contextWindow} />
        {row.time && <span className="text-muted-foreground/60">· {row.time}</span>}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

/**
 * The `context-rebuilt` marker. The harness no longer had the conversation Rennet's cursor
 * pointed at, so the turn ran on a fresh session and context was rebuilt from the boards.
 * Rendered for the same reason the compaction row is: without it the transcript reads as one
 * unbroken conversation across a real discontinuity, which is the surface claiming something
 * it cannot know. The reason is the daemon's own words — never paraphrased here.
 */
export function ContextRebuiltMarker({ row }: { readonly row: ContextRebuiltRow }) {
  return (
    <div
      className="flex items-center gap-3 text-2xs text-muted-foreground"
      data-testid="context-rebuilt-row"
      data-row-id={row.id}
    >
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="flex items-center gap-1.5">
        <Icon icon={RefreshCw} className="size-3 shrink-0" aria-hidden="true" />
        <span>Context rebuilt</span>
        <span aria-hidden="true">·</span>
        <span className="italic">{row.reason}</span>
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
