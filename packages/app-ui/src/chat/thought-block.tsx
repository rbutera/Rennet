import { Collapse, cn } from "@rennet/ui";
import { ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import type { ThoughtBlockData } from "./chat-data";

// ─────────────────────────────────────────────────────────────────────────────
// ThoughtBlock (C07, ported from the spike). The collapsing "Thinking → Thought for
// Ns" block with manual re-expand. RECONCILIATION 2: the live/settled look follows
// the turn's real `status` from the stream, NOT the spike's self-timed `setTimeout`
// reveal. A `streaming` block reads live (spinner, expanded, "Thinking"); a settled
// block (`complete`/`interrupted`) collapses to "Thought for Ns" and re-expands on tap.
// No timers — an interrupted turn's block settles truthfully instead of spinning forever.
// ─────────────────────────────────────────────────────────────────────────────

export function ThoughtBlock({ step }: { readonly step: ThoughtBlockData }) {
  const isLive = step.status === "streaming";
  const [manuallyOpened, setManuallyOpened] = useState(false);
  // Live ⇒ open while thinking; settled ⇒ collapsed to the summary, re-expandable.
  const isExpanded = isLive || manuallyOpened;

  return (
    <div className="max-w-[640px]">
      <button
        type="button"
        onClick={() => !isLive && setManuallyOpened((v) => !v)}
        className="flex items-center gap-1.5 text-12-5 text-muted-foreground/80 hover:text-muted-foreground"
        aria-expanded={isExpanded}
      >
        <Loader2
          className={cn(
            "size-3 shrink-0",
            isLive ? "animate-spin text-model" : "text-muted-foreground/70",
          )}
          aria-hidden="true"
        />
        <span>
          {isLive
            ? "Thinking"
            : step.seconds === undefined
              ? "Thought"
              : `Thought for ${step.seconds}s`}
        </span>
        {!isLive && (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform",
              manuallyOpened && "rotate-90",
            )}
            aria-hidden="true"
          />
        )}
      </button>
      <Collapse open={isExpanded}>
        <div className="mt-1 flex flex-col gap-2 border-l border-border pl-3 font-prose text-13 italic leading-relaxed text-muted-foreground">
          {step.text.map((paragraph, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: thought paragraphs are a fixed positional list.
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      </Collapse>
    </div>
  );
}
