"use client"

import * as React from "react"
import { Check, LoaderCircle } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * The run watched live (story 2, run-view variant): what fills the main
 * surface between "session started" and "boards ready". Prep steps stream in
 * as tool lines, then the five lens drafts progress independently, then the
 * unslop pass and the orchestrator's composition. Every label is derivable
 * from Rennet's own pipeline (prep → lens drafting agents → unslop editor →
 * orchestrator composes the Board).
 */

interface TimedStep {
  label: string
  detail?: string
  doneDetail?: string
  start: number
  done: number
}

function prepSteps(targetKind: "pr" | "branch", targetLabel: string): TimedStep[] {
  const source =
    targetKind === "pr"
      ? [
          { label: "Fetched pull request", detail: targetLabel },
          { label: "Created PR worktree" },
          { label: "Read the diff", doneDetail: "+1,412 −435 · 23 files" },
          { label: "Gathered related context", doneDetail: "14 files" },
        ]
      : [
          { label: "Read the working tree", detail: targetLabel },
          { label: "Mapped commits against main", doneDetail: "3 commits" },
          { label: "Read the diff", doneDetail: "+680 −74 · 18 files" },
          { label: "Gathered related context", doneDetail: "14 files" },
        ]
  return source.map((step, index) => ({
    ...step,
    start: index * 550,
    done: index * 550 + 700,
  }))
}

const LENS_START = 2900
const LENSES: { name: string; doneDetail: string; start: number; done: number }[] = [
  { name: "Design", doneDetail: "9 requirements · 6 covered", start: LENS_START, done: 7300 },
  { name: "Sequence", doneDetail: "12 steps", start: LENS_START + 200, done: 5600 },
  { name: "Decisions", doneDetail: "4 decisions · 1 inferred", start: LENS_START + 400, done: 6200 },
  { name: "Flagged", doneDetail: "5 findings · 1 high", start: LENS_START + 600, done: 6800 },
  { name: "Noise", doneDetail: "3 hunks grouped as noise", start: LENS_START + 800, done: 4900 },
]

const FINISH: TimedStep[] = [
  { label: "Cleaning up drafts · post-process pass", start: 7500, done: 8600 },
  { label: "Composed the board", start: 8700, done: 9600 },
]

const READY_AT = 10100

function StepLine({ step, elapsed }: { step: TimedStep; elapsed: number }) {
  if (elapsed < step.start) return null
  const running = elapsed < step.done
  const detail = running ? step.detail : (step.doneDetail ?? step.detail)
  return (
    <div className="flex items-center gap-1.5 text-[12.5px]">
      {running ? (
        <LoaderCircle className="size-3 shrink-0 animate-spin text-model" aria-hidden="true" />
      ) : (
        <Check className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      )}
      <span className={cn("truncate", running ? "text-foreground" : "text-muted-foreground")}>
        {step.label}
        {detail ? ` · ${detail}` : ""}
      </span>
    </div>
  )
}

export function RunView({
  targetKind,
  targetLabel,
  onReady,
}: {
  targetKind: "pr" | "branch"
  targetLabel: string
  onReady: () => void
}) {
  const [elapsed, setElapsed] = React.useState(0)
  const prep = React.useMemo(() => prepSteps(targetKind, targetLabel), [targetKind, targetLabel])

  React.useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((value) => value + 100)
    }, 100)
    return () => clearInterval(interval)
  }, [])

  const readyFired = React.useRef(false)
  React.useEffect(() => {
    if (elapsed >= READY_AT && !readyFired.current) {
      readyFired.current = true
      onReady()
    }
  }, [elapsed, onReady])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-8 pt-[11vh]">
        <div className="flex flex-col gap-1.5">
          {prep.map((step) => (
            <StepLine key={step.label} step={step} elapsed={elapsed} />
          ))}
        </div>

        {elapsed >= LENS_START - 300 && (
          <div className="flex flex-col gap-1">
            <span className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Lenses
            </span>
            <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
              {LENSES.map((lens) => {
                const queued = elapsed < lens.start
                const drafting = !queued && elapsed < lens.done
                return (
                  <div key={lens.name} className="flex items-center gap-2.5 px-3.5 py-2.5">
                    {drafting ? (
                      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-model" aria-hidden="true" />
                    ) : queued ? (
                      <span className="size-3.5 shrink-0 rounded-full border border-border" aria-hidden="true" />
                    ) : (
                      <Check className="size-3.5 shrink-0 text-green-500" aria-hidden="true" />
                    )}
                    <span
                      className={cn(
                        "text-[13px] font-medium",
                        queued ? "text-muted-foreground/50" : "text-foreground",
                      )}
                    >
                      {lens.name}
                    </span>
                    <span className="ml-auto text-[11.5px] text-muted-foreground">
                      {queued ? "queued" : drafting ? "drafting" : lens.doneDetail}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {FINISH.map((step) => (
            <StepLine key={step.label} step={step} elapsed={elapsed} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A work-order round watched live (R34): one worker in a detached worktree
 * applies the staged asks, an activity block streams its turns, the full gate
 * runs, and the round commits — then the reviewer is greeted by the successor
 * summary. Every label derives from Rennet's own round pipeline (R4).
 */
const ROUND_PREP: TimedStep[] = [
  { label: "Created detached worktree", doneDetail: "fix/token-refresh-observability @ round-1", start: 0, done: 900 },
  { label: "Applied the round's asks", doneDetail: "2 asks", start: 800, done: 1600 },
]

const ROUND_WORK_START = 1800
const ROUND_WORK: { name: string; detail: string; start: number; done: number }[] = [
  { name: "Read the refresh path", detail: "github-auth.ts", start: ROUND_WORK_START, done: 3200 },
  { name: "Wrote a terminal record on every exit", detail: "exchange-error + persistence-failure", start: 3000, done: 5000 },
  { name: "Reported the post-send failure as unknown", detail: "network copy", start: 4600, done: 6400 },
  { name: "Tightened the tests", detail: "github-auth.test.ts", start: 6200, done: 7600 },
]

const ROUND_FINISH: TimedStep[] = [
  { label: "Ran the gate", detail: "pnpm check", doneDetail: "pnpm check · 14 projects green", start: 7800, done: 9000 },
  { label: "Committed the round", doneDetail: "2 commits", start: 9100, done: 9900 },
]

const ROUND_READY_AT = 10400

export function RoundRunView({ onComplete }: { onComplete: () => void }) {
  const [elapsed, setElapsed] = React.useState(0)

  React.useEffect(() => {
    const interval = setInterval(() => setElapsed((value) => value + 100), 100)
    return () => clearInterval(interval)
  }, [])

  const doneFired = React.useRef(false)
  React.useEffect(() => {
    if (elapsed >= ROUND_READY_AT && !doneFired.current) {
      doneFired.current = true
      onComplete()
    }
  }, [elapsed, onComplete])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-8 pt-[11vh]">
        <span className="text-[13px] font-medium text-foreground">Round 1 · fix/token-refresh-observability</span>

        <div className="flex flex-col gap-1.5">
          {ROUND_PREP.map((step) => (
            <StepLine key={step.label} step={step} elapsed={elapsed} />
          ))}
        </div>

        {elapsed >= ROUND_WORK_START - 300 && (
          <div className="flex flex-col gap-1">
            <span className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Round worker
            </span>
            <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
              {ROUND_WORK.map((step) => {
                const queued = elapsed < step.start
                const running = !queued && elapsed < step.done
                return (
                  <div key={step.name} className="flex items-center gap-2.5 px-3.5 py-2.5">
                    {running ? (
                      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-model" aria-hidden="true" />
                    ) : queued ? (
                      <span className="size-3.5 shrink-0 rounded-full border border-border" aria-hidden="true" />
                    ) : (
                      <Check className="size-3.5 shrink-0 text-green-500" aria-hidden="true" />
                    )}
                    <span className={cn("text-[13px] font-medium", queued ? "text-muted-foreground/50" : "text-foreground")}>
                      {step.name}
                    </span>
                    <span className="ml-auto text-[11.5px] text-muted-foreground">
                      {queued ? "queued" : step.detail}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {ROUND_FINISH.map((step) => (
            <StepLine key={step.label} step={step} elapsed={elapsed} />
          ))}
        </div>
      </div>
    </div>
  )
}
