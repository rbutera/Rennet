"use client"

import * as React from "react"
import { ArrowLeft, Check, ChevronRight, LoaderCircle, Map, MessageSquarePlus } from "lucide-react"
import { cn } from "@/lib/utils"
import { mapScopes, mapStatements } from "@/lib/context-map-data"
import { Coachmark } from "@/components/coachmark"

/**
 * The add-project flow (#487): the modal stays a host + folder picker;
 * everything after Add happens here. A deterministic pass + the project
 * scout run first as their own progression; context-map generation starts
 * only once the scout returns and the questionnaire is on screen, so the
 * user confirms the prefilled answers while the map cooks beneath. The
 * questionnaire is skippable — never a gate — and every answer stays
 * editable in Settings → Projects. On completion, two exits: start a New
 * chat on the project, or view the finished context map. Leaving early is
 * fine — indexing continues and the sidebar row carries the state.
 */

const SCOPE_TOTAL = mapScopes.length

// Scout phase: deterministic pass, then the medium-tier project-scout seat.
const SCOUT_DONE = 2600
// Map generation starts at SCOUT_DONE; these offsets are relative to it.
const MAP_START = SCOUT_DONE + 2300
const MAP_DONE = SCOUT_DONE + 7800
const KNOWLEDGE_DONE = SCOUT_DONE + 9400
const READY_AT = SCOUT_DONE + 9800

interface IndexStep {
  label: string
  detail?: string
  doneDetail?: string
  start: number
  done: number
}

const SCOUT_STEPS: IndexStep[] = [
  { label: "Read the git remotes", doneDetail: "github.com origin", start: 0, done: 500 },
  { label: "Checked for tracker markers and CI config", start: 550, done: 1150 },
  {
    label: "Scout reading README, CONTRIBUTING, agent files",
    start: 1250,
    done: 2450,
  },
  { label: "Scout returned", doneDetail: "4 detected · 2 guessed", start: 2500, done: SCOUT_DONE },
]

const MAP_STEPS: IndexStep[] = [
  {
    label: "Scanned the working tree",
    doneDetail: "456 files · 12 scopes",
    start: SCOUT_DONE,
    done: SCOUT_DONE + 900,
  },
  { label: "Mapped imports across scopes", start: SCOUT_DONE + 1000, done: SCOUT_DONE + 2200 },
]

type Provenance = "detected" | "guessed"

interface ScoutAnswer {
  id: string
  label: string
  value: string
  provenance: Provenance
  hint: string
  /** Present = the value renders as a segmented pick instead of an input. */
  options?: string[]
}

/** What the scout prefilled — the questionnaire's starting state. */
const SCOUT_ANSWERS: ScoutAnswer[] = [
  {
    id: "tracker",
    label: "Issue tracker",
    value: "github",
    provenance: "detected",
    hint: "from the git remote — referenced tickets feed the review agents",
    options: ["github", "jira", "linear", "none"],
  },
  {
    id: "branch",
    label: "Default branch",
    value: "main",
    provenance: "detected",
    hint: "from the remote HEAD",
  },
  {
    id: "worktrees",
    label: "Worktree location",
    value: "~/.rennet/worktrees",
    provenance: "guessed",
    hint: "no in-repo convention found — rounds check out here",
  },
  {
    id: "gate",
    label: "Gate command",
    value: "pnpm check",
    provenance: "guessed",
    hint: "rounds run this before handing work back",
  },
  {
    id: "logo",
    label: "Logo",
    value: "docs/logo.svg",
    provenance: "detected",
    hint: "found in the repo — shown in the sidebar",
  },
]

export function ProjectIndexingView({
  projectName,
  onBack,
  onNewChat,
  onViewMap,
}: {
  projectName: string
  onBack: () => void
  onNewChat: () => void
  onViewMap: () => void
}) {
  const [elapsed, setElapsed] = React.useState(0)
  const [answers, setAnswers] = React.useState(SCOUT_ANSWERS)
  const [saved, setSaved] = React.useState(false)

  React.useEffect(() => {
    const interval = setInterval(() => setElapsed((value) => value + 100), 100)
    return () => clearInterval(interval)
  }, [])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onBack()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onBack])

  const scoutDone = elapsed >= SCOUT_DONE
  const scopesBuilt = Math.max(
    0,
    Math.min(SCOPE_TOTAL, Math.round(((elapsed - MAP_START) / (MAP_DONE - MAP_START)) * SCOPE_TOTAL)),
  )
  const ready = elapsed >= READY_AT

  // The CTA appears at the bottom of a scrolled timeline — bring it on screen.
  const ctaRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (ready) ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [ready])

  // Timeline mirrors the #460 swarm architecture: scope-partitioned light-tier
  // workers, then the medium verify/synthesis seat confirming hypotheses itself.
  const confirmed = mapStatements.filter((s) => s.status === "confirmed").length
  const rejected = mapStatements.filter((s) => s.status === "rejected").length
  const mapSteps: IndexStep[] = [
    ...MAP_STEPS,
    {
      label: "Knowledge workers reading scopes",
      detail: `${scopesBuilt}/${SCOPE_TOTAL} scopes · ${mapStatements.length} hypotheses`,
      doneDetail: `${SCOPE_TOTAL} scopes · ${mapStatements.length} hypotheses`,
      start: MAP_START,
      done: MAP_DONE,
    },
    {
      label: "Verifying hypotheses against cited evidence",
      detail: "re-reading anchors",
      doneDetail: `${confirmed} confirmed · ${rejected} rejected`,
      start: MAP_DONE + 100,
      done: KNOWLEDGE_DONE,
    },
    {
      label: "Connected the dots across scopes",
      start: KNOWLEDGE_DONE + 100,
      done: READY_AT - 100,
    },
  ]

  const renderSteps = (steps: IndexStep[]) =>
    steps
      .filter((step) => elapsed >= step.start)
      .map((step) => {
        const running = elapsed < step.done
        const detail = running ? step.detail : (step.doneDetail ?? step.detail)
        return (
          <div key={step.label} className="flex items-center gap-1.5 text-[12.5px]">
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
      })

  const status = ready ? "indexed" : scoutDone ? "indexing" : "scouting"

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="mr-0.5 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="shrink-0 font-medium text-foreground">{projectName}</span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <span className="text-muted-foreground">{status}</span>
        </span>
        <kbd className="ml-auto rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-8 pt-[10vh] pb-16">
          <div className="flex flex-col gap-1.5">{renderSteps(SCOUT_STEPS)}</div>

          {scoutDone && (
            <ScoutQuestionnaire
              answers={answers}
              onChange={setAnswers}
              saved={saved}
              onSave={() => setSaved(true)}
            />
          )}

          {scoutDone && <div className="flex flex-col gap-1.5">{renderSteps(mapSteps)}</div>}

          {ready && (
            <>
              <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <Check className="size-4 shrink-0 text-green-500" aria-hidden="true" />
                  <span className="text-[13.5px] font-medium text-foreground">
                    Context Map Ready
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    {SCOPE_TOTAL} scopes · {mapScopes.reduce((n, s) => n + s.files, 0)} files ·{" "}
                    {confirmed} statements confirmed · {rejected} rejected
                  </span>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={onViewMap}
                    className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground/90 transition-colors hover:bg-secondary"
                  >
                    <Map className="size-3.5" aria-hidden="true" />
                    View Context Map
                  </button>
                </div>
              </div>

              <button
                ref={ctaRef}
                type="button"
                onClick={onNewChat}
                data-tour="start-review"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 py-4 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <MessageSquarePlus className="size-5" aria-hidden="true" />
                Start a Review
              </button>
              <Coachmark id="start-review" />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ProvenanceChip({ provenance }: { provenance: Provenance }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1 py-px text-[10px] uppercase tracking-wide",
        provenance === "detected"
          ? "border-border text-muted-foreground"
          : "border-model/40 text-model",
      )}
    >
      {provenance}
    </span>
  )
}

/**
 * The scout's answers, offered for confirmation while the map generates.
 * Confirming is optional — answers apply as shown unless edited, and stay
 * editable in Settings → Projects.
 */
function ScoutQuestionnaire({
  answers,
  onChange,
  saved,
  onSave,
}: {
  answers: ScoutAnswer[]
  onChange: (answers: ScoutAnswer[]) => void
  saved: boolean
  onSave: () => void
}) {
  const patch = (id: string, value: string) =>
    onChange(answers.map((a) => (a.id === id ? { ...a, value } : a)))

  const stopEscape = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation()
      ;(event.currentTarget as HTMLElement).blur()
    }
  }

  if (saved) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border px-4 py-3">
        <Check className="size-3.5 shrink-0 text-green-500" aria-hidden="true" />
        <span className="text-[12.5px] text-muted-foreground">
          Project setup saved — editable anytime in Settings → Projects
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3.5">
      <div className="flex flex-col">
        <span className="text-[13.5px] font-medium text-foreground">
          While the map generates — does this look right?
        </span>
        <span className="text-[12px] text-muted-foreground">
          The scout prefilled these. Skipping is fine; everything stays editable in Settings.
        </span>
      </div>

      <div className="flex flex-col divide-y divide-border/60">
        {answers.map((answer) => (
          <div key={answer.id} className="flex items-center gap-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                {answer.label}
                <ProvenanceChip provenance={answer.provenance} />
              </span>
              <span className="truncate text-[11.5px] text-muted-foreground">{answer.hint}</span>
            </div>
            <div className="ml-auto shrink-0">
              {answer.options ? (
                <div className="flex items-center gap-0.5 rounded-md border border-border bg-card/40 p-0.5">
                  {answer.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => patch(answer.id, option)}
                      className={cn(
                        "rounded-[5px] px-2 py-0.5 text-[11.5px] transition-colors",
                        option === answer.value
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  value={answer.value}
                  onChange={(event) => patch(answer.id, event.target.value)}
                  onKeyDown={stopEscape}
                  aria-label={answer.label}
                  spellCheck={false}
                  className="w-48 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11.5px] text-foreground focus-visible:border-ring focus-visible:outline-none"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          onClick={onSave}
          className="rounded-md border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground/90 transition-colors hover:bg-secondary"
        >
          Looks right
        </button>
      </div>
    </div>
  )
}
