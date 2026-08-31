import { cn } from "@rennet/ui";
import type { ActionStepData } from "./chat-data";

// ─────────────────────────────────────────────────────────────────────────────
// ActionStep (C07, ported from the spike). A running-spinner → done-label step.
// RECONCILIATION 2: running vs done follows the turn's real `status` from the stream,
// NOT a self-timed `setTimeout`. `streaming` reads running (spinner, live label); a
// settled step (`complete`/`interrupted`) shows its done label + detail. An interrupted
// turn's step settles truthfully — never an infinite spinner.
// ─────────────────────────────────────────────────────────────────────────────

export function ActionStep({ step }: { readonly step: ActionStepData }) {
  const isRunning = step.status === "streaming";
  const Icon = step.icon;
  const label = !isRunning && step.doneLabel ? step.doneLabel : step.label;
  const detail = !isRunning && step.doneDetail !== undefined ? step.doneDetail : step.detail;

  return (
    <div className="flex max-w-[640px] items-center gap-1.5 text-12-5">
      <Icon
        className={cn(
          "size-3 shrink-0",
          isRunning ? "animate-spin text-model" : "text-muted-foreground/70",
        )}
        aria-hidden="true"
      />
      <span
        className={cn(
          "truncate underline decoration-dotted decoration-1 underline-offset-2",
          isRunning
            ? "text-foreground decoration-primary/50"
            : "text-muted-foreground decoration-border",
        )}
      >
        {label}
        {detail ? ` · ${detail}` : ""}
      </span>
      <span className="sr-only" aria-live="polite">
        {isRunning ? "running" : "done"}
      </span>
    </div>
  );
}
