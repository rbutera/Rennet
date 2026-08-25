"use client"

import * as React from "react"
import { ArrowRight, Check, ChevronRight, CircleDashed, Minus, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { AnchorReveal } from "@/components/code-tabs"
import { RichText } from "@/components/rich-text"
import { returnedRound, type SummaryItem } from "@/lib/scenarios/returned"

const STATUS: Record<SummaryItem["status"], { label: string; icon: typeof Check; tint: string }> = {
  addressed: { label: "Addressed", icon: Check, tint: "text-green" },
  partial: { label: "Partial", icon: CircleDashed, tint: "text-warn" },
  untouched: { label: "Untouched", icon: Minus, tint: "text-muted-foreground" },
  beyond: { label: "Beyond the asks", icon: Sparkles, tint: "text-model" },
}

/**
 * The successor-summary greeting that fills the surface on return from a round
 * (R34): what the round addressed / left partial / left untouched / did beyond
 * the asks, each item tracing to its ask, with one action back to the boards.
 * Over it sits the drafting activity feed — the R32-sanctioned home for the
 * collapsed regeneration line that expands into the trigger queue.
 */
export function SuccessorSummary({ onDismiss }: { onDismiss: () => void }) {
  const [feedOpen, setFeedOpen] = React.useState(false)
  const round = returnedRound

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Drafting activity feed — collapsed line over the surface (R32). */}
      <div className="border-b border-border bg-secondary/20">
        <button
          type="button"
          onClick={() => setFeedOpen((open) => !open)}
          aria-expanded={feedOpen}
          className="flex w-full items-center gap-2 px-8 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", feedOpen && "rotate-90")} aria-hidden="true" />
          <Check className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
          Regenerated the boards · {round.triggers.length} reworks · generation 2
        </button>
        {feedOpen && (
          <div className="flex flex-col gap-3 px-8 pb-3 pl-[3.75rem]">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Trigger queue</span>
              {round.triggers.map((trigger) => (
                <span key={trigger} className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <span aria-hidden="true" className="select-none text-muted-foreground/50">‣</span>
                  {trigger}
                </span>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Turn anatomy</span>
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Sparkles className="size-3 shrink-0" aria-hidden="true" /> Read the successor account and re-anchored asks by quote match
              </span>
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Check className="size-3 shrink-0" aria-hidden="true" /> Carried forward Design, Sequence, Decisions, Noise unchanged
              </span>
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Check className="size-3 shrink-0" aria-hidden="true" /> Re-drafted Flagged · marked 1 addressed, 1 partial, froze generation 1
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-10">
        <RichText text={round.greeting} paragraphClassName="text-[15px] leading-relaxed text-foreground/90" />

        <div className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
          {round.items.map((item, index) => {
            const meta = STATUS[item.status]
            const Icon = meta.icon
            return (
              <div key={index} className="flex flex-col gap-1.5 px-4 py-3">
                <span className="flex items-center gap-2">
                  <Icon className={cn("size-3.5 shrink-0", meta.tint)} aria-hidden="true" />
                  <span className={cn("text-[11px] font-semibold uppercase tracking-wide", meta.tint)}>{meta.label}</span>
                  <span className="text-[13px] text-muted-foreground">· {item.ask}</span>
                </span>
                <RichText text={item.note} paragraphClassName="text-[13.5px] leading-relaxed text-foreground/85" />
                {item.anchor && <AnchorReveal anchors={[item.anchor]} />}
              </div>
            )
          })}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="flex w-fit items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          Back to the Boards
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
