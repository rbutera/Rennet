"use client"

import * as React from "react"
import { ArrowRight, Check, ChevronRight, CircleDashed, LoaderCircle, Minus, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { AnchorReveal } from "@/components/code-tabs"
import { RichText } from "@/components/rich-text"
import type { RoundReturn, SummaryItem } from "@/lib/scenarios"

const STATUS: Record<SummaryItem["status"], { label: string; icon: typeof Check; tint: string }> = {
  addressed: { label: "Addressed", icon: Check, tint: "text-green" },
  partial: { label: "Partial", icon: CircleDashed, tint: "text-warn" },
  untouched: { label: "Untouched", icon: Minus, tint: "text-muted-foreground" },
  beyond: { label: "Beyond the Asks", icon: Sparkles, tint: "text-model" },
}

/** The report's status tally, e.g. "1 addressed · 1 partial · 1 beyond". */
function tally(round: RoundReturn): string {
  const counts = new Map<SummaryItem["status"], number>()
  for (const item of round.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, n]) => `${n} ${STATUS[status].label.toLowerCase()}`).join(" · ")
}

/** The report itself: the greeting line and the per-ask outcome items. */
function RoundReportBody({ round }: { round: RoundReturn }) {
  return (
    <>
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
    </>
  )
}

/**
 * The live regeneration the reviewer reads the report over: the report is the
 * first artifact out of the round (the drafters receive it, R34), so it is
 * readable while the lens drafters rework in the background. Carried lenses
 * complete as carry-forwards; touched lenses re-draft; then the post-process
 * pass and composition. When the new generation composes, the transition
 * control appears — never a disabled button waiting to enable.
 */
const REGEN_LENSES: { name: string; start: number; done: number; doneDetail: string; drafting?: boolean }[] = [
  { name: "Design", start: 200, done: 700, doneDetail: "carried forward" },
  { name: "Sequence", start: 300, done: 850, doneDetail: "carried forward" },
  { name: "Decisions", start: 400, done: 1000, doneDetail: "carried forward" },
  { name: "Flagged", start: 200, done: 5800, doneDetail: "1 addressed · 1 still open · 1 beyond", drafting: true },
  { name: "Noise", start: 500, done: 1150, doneDetail: "carried forward" },
]

const REGEN_FINISH: { label: string; start: number; done: number }[] = [
  { label: "Cleaning up drafts · post-process pass", start: 6000, done: 7000 },
  { label: "Composed generation 2", start: 7100, done: 8000 },
]

const REGEN_READY_AT = 8300

function RegenProgress({ elapsed }: { elapsed: number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {elapsed >= REGEN_READY_AT ? "Regenerated the Boards" : "Regenerating the Boards"}
      </span>
      <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
        {REGEN_LENSES.map((lens) => {
          const queued = elapsed < lens.start
          const working = !queued && elapsed < lens.done
          return (
            <div key={lens.name} className="flex items-center gap-2.5 px-3.5 py-2">
              {working ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-model" aria-hidden="true" />
              ) : queued ? (
                <span className="size-3.5 shrink-0 rounded-full border border-border" aria-hidden="true" />
              ) : (
                <Check className="size-3.5 shrink-0 text-green-500" aria-hidden="true" />
              )}
              <span className={cn("text-[13px] font-medium", queued ? "text-muted-foreground/50" : "text-foreground")}>
                {lens.name}
              </span>
              <span className="ml-auto text-[11.5px] text-muted-foreground">
                {queued ? "queued" : working ? (lens.drafting ? "re-drafting" : "carrying forward") : lens.doneDetail}
              </span>
            </div>
          )
        })}
      </div>
      {REGEN_FINISH.filter((step) => elapsed >= step.start).map((step) => (
        <span key={step.label} className="flex items-center gap-1.5 pt-1 text-[12.5px] text-muted-foreground">
          {elapsed < step.done ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-model" aria-hidden="true" />
          ) : (
            <Check className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
          )}
          {step.label}
        </span>
      ))}
    </div>
  )
}

/** The retrospective activity-feed line a settled report wears (R32's home). */
function ActivityFeed({ round }: { round: RoundReturn }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="rounded-md border border-border bg-secondary/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <Check className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        Regenerated the boards · {round.triggers.length} reworks · generation {round.number + 1}
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-4 pb-3 pl-[2.6rem]">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Trigger Queue</span>
            {round.triggers.map((trigger) => (
              <span key={trigger} className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <span aria-hidden="true" className="select-none text-muted-foreground/50">‣</span>
                {trigger}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Turn Anatomy</span>
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Sparkles className="size-3 shrink-0" aria-hidden="true" /> Read the round report and re-anchored asks by quote match
            </span>
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Check className="size-3 shrink-0" aria-hidden="true" /> Carried forward Design, Sequence, Decisions, Noise unchanged
            </span>
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Check className="size-3 shrink-0" aria-hidden="true" /> Re-drafted Flagged · marked 1 addressed, 1 partial, froze generation {round.number}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The round-report greeting that fills the surface on return from a round
 * (R34): the report is readable immediately while the lens drafters regenerate
 * live beneath it; the way to the new generation appears when it composes.
 */
export function RoundReportGreeting({ round, onViewBoards }: { round: RoundReturn; onViewBoards: () => void }) {
  const [elapsed, setElapsed] = React.useState(0)
  React.useEffect(() => {
    const interval = setInterval(() => setElapsed((value) => value + 100), 100)
    return () => clearInterval(interval)
  }, [])
  const ready = elapsed >= REGEN_READY_AT

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-10">
        <RoundReportBody round={round} />
        <RegenProgress elapsed={elapsed} />
        {ready && (
          <button
            type="button"
            onClick={onViewBoards}
            className="flex w-fit items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            View the New Boards
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The rounds ledger (`?view=rounds`): every completed round's report stays
 * readable — one row per round, the selected report rendered beneath. The
 * frozen prior generation remains each board's own drill-down; this surface
 * keeps the reports.
 */
export function RoundsLedger({ rounds }: { rounds: RoundReturn[] }) {
  const ordered = [...rounds].reverse()
  const [selected, setSelected] = React.useState(ordered[0]?.number)
  const round = ordered.find((r) => r.number === selected) ?? ordered[0]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-10">
        <div className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
          {ordered.map((r) => (
            <button
              key={r.number}
              type="button"
              onClick={() => setSelected(r.number)}
              aria-pressed={r.number === round.number}
              className={cn(
                "flex items-center gap-2.5 px-4 py-2.5 text-left",
                r.number === round.number ? "bg-secondary/40" : "hover:bg-secondary/20",
              )}
            >
              <span className="text-[13px] font-medium text-foreground">Round {r.number}</span>
              <span className="text-[12px] text-muted-foreground">{r.when}</span>
              <span className="ml-auto text-[12px] text-muted-foreground">{tally(r)}</span>
            </button>
          ))}
        </div>
        {round && (
          <>
            <RoundReportBody round={round} />
            <ActivityFeed round={round} />
          </>
        )}
      </div>
    </div>
  )
}
