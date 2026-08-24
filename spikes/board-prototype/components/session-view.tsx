"use client"

import * as React from "react"
import { ArrowLeft, ChevronRight, GitBranch, GitPullRequest } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { InputBar } from "@/components/input-bar"
import type { ComposerBadge } from "@/lib/composer-badges"

/**
 * A just-started review session: blank chat shell on the left, and the right
 * pane is a placeholder for the loading-context / lenses view (its own story,
 * designed next). Entered from the New chat page by picking a target.
 */
export function SessionView({
  projectName,
  targetLabel,
  targetKind,
  initialMessage,
  onBack,
}: {
  projectName: string
  targetLabel: string
  targetKind: "pr" | "branch"
  initialMessage?: string
  onBack: () => void
}) {
  const [turns, setTurns] = React.useState<string[]>(initialMessage ? [initialMessage] : [])

  function handleSend(message: string) {
    setTurns((prev) => [...prev, message])
  }

  const noBadges: ComposerBadge[] = []

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 w-[420px] shrink-0 flex-col overflow-hidden border-r border-border">
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
            {targetKind === "pr" ? (
              <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="shrink-0 font-medium text-foreground">{projectName}</span>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">{targetLabel}</span>
          </span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-y-auto px-4 py-4">
          {turns.map((turn, index) => (
            <div key={index} className="flex justify-end">
              <div className="max-w-[320px] rounded-lg bg-secondary px-3 py-2 text-[13.5px] leading-relaxed text-foreground/95">
                {turn}
              </div>
            </div>
          ))}
        </div>
        <InputBar
          onSend={handleSend}
          prefillMessage=""
          badges={noBadges}
          onRemoveBadge={() => {}}
          onAddImage={() => {}}
        />
      </div>

      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <header className="h-10 shrink-0 border-b border-border" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Spinner className="size-4 text-muted-foreground/60" />
          <span className="text-[12px] text-muted-foreground/50">
            context loading · lenses view — separate story
          </span>
        </div>
      </div>
    </div>
  )
}
