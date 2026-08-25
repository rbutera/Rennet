"use client"

import * as React from "react"
import { ArrowLeft, Check, ChevronRight, LoaderCircle, Map, MessageSquarePlus } from "lucide-react"
import { cn } from "@/lib/utils"
import { mapScopes, mapStatements } from "@/lib/context-map-data"

/**
 * The add-project flow: indexing progress only (no live map — ruled out;
 * the map is viewable once it's done). On completion, two exits: start a
 * New chat on the project, or view the finished context map. Leaving early
 * is fine — indexing continues and the sidebar row carries the state.
 */

const SCOPE_TOTAL = mapScopes.length
const MAP_START = 2300
const MAP_DONE = 7800
const KNOWLEDGE_DONE = 9400
const READY_AT = 9800

interface IndexStep {
  label: string
  detail?: string
  doneDetail?: string
  start: number
  done: number
}

const STEPS: IndexStep[] = [
  { label: "Scanned the working tree", doneDetail: "456 files · 12 scopes", start: 0, done: 900 },
  { label: "Mapped imports across scopes", start: 1000, done: 2200 },
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

  const scopesBuilt = Math.max(
    0,
    Math.min(SCOPE_TOTAL, Math.round(((elapsed - MAP_START) / (MAP_DONE - MAP_START)) * SCOPE_TOTAL)),
  )
  const ready = elapsed >= READY_AT

  const steps: IndexStep[] = [
    ...STEPS,
    {
      label: "Building the context map",
      detail: `${scopesBuilt}/${SCOPE_TOTAL} scopes`,
      doneDetail: `${SCOPE_TOTAL} scopes`,
      start: MAP_START,
      done: MAP_DONE,
    },
    {
      label: "Deriving knowledge",
      detail: "reading evidence",
      doneDetail: `${mapStatements.length} statements proposed`,
      start: MAP_DONE + 100,
      done: KNOWLEDGE_DONE,
    },
  ]

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
          <span className="text-muted-foreground">{ready ? "indexed" : "indexing"}</span>
        </span>
        <kbd className="ml-auto rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-8 pt-[14vh]">
          <div className="flex flex-col gap-1.5">
            {steps
              .filter((step) => elapsed >= step.start)
              .map((step) => {
                const running = elapsed < step.done
                const detail = running ? step.detail : (step.doneDetail ?? step.detail)
                return (
                  <div key={step.label} className="flex items-center gap-1.5 text-[12.5px]">
                    {running ? (
                      <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
                    ) : (
                      <Check className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                    )}
                    <span className={cn("truncate", running ? "text-foreground" : "text-muted-foreground")}>
                      {step.label}
                      {detail ? ` · ${detail}` : ""}
                    </span>
                  </div>
                )
              })}
          </div>

          {ready && (
            <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3.5">
              <div className="flex items-center gap-2">
                <Check className="size-4 shrink-0 text-green-500" aria-hidden="true" />
                <span className="text-[13.5px] font-medium text-foreground">Context map ready</span>
                <span className="text-[12px] text-muted-foreground">
                  {SCOPE_TOTAL} scopes · {mapScopes.reduce((n, s) => n + s.files, 0)} files ·{" "}
                  {mapStatements.length} statements proposed
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onNewChat}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <MessageSquarePlus className="size-3.5" aria-hidden="true" />
                  New chat on {projectName}
                </button>
                <button
                  type="button"
                  onClick={onViewMap}
                  className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground/90 transition-colors hover:bg-secondary"
                >
                  <Map className="size-3.5" aria-hidden="true" />
                  View context map
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
