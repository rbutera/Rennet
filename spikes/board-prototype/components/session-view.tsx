"use client"

import * as React from "react"
import { ArrowLeft, ChevronRight, GitBranch, GitPullRequest } from "lucide-react"
import { InputBar } from "@/components/input-bar"
import { MainSurface } from "@/components/main-surface"
import { DEFAULT_SCENARIO, scenarios } from "@/lib/scenarios"
import { ResizeHandle } from "@/components/resize-handle"
import { RunView } from "@/components/run-view"
import { TargetBadge, type TargetState } from "@/components/target-badge"
import type { ComposerBadge } from "@/lib/composer-badges"
import type { TargetKind } from "@/lib/target-language"

/**
 * A just-started review session: blank chat shell on the left, and the right
 * pane is a placeholder for the loading-context / lenses view (its own story,
 * designed next). Entered from the New chat page by picking a target.
 */
export function SessionView({
  projectName,
  targetLabel,
  targetKind,
  badge,
  initialMessage,
  onBack,
  chatWidth,
  onChatWidthChange,
}: {
  projectName: string
  targetLabel: string
  targetKind: "pr" | "branch"
  badge: { kind: TargetKind; state?: TargetState }
  initialMessage?: string
  onBack: () => void
  chatWidth: number
  onChatWidthChange: (width: number) => void
}) {
  const [turns, setTurns] = React.useState<string[]>(initialMessage ? [initialMessage] : [])
  const [boardsReady, setBoardsReady] = React.useState(false)

  function handleSend(message: string) {
    setTurns((prev) => [...prev, message])
  }

  const noBadges: ComposerBadge[] = []

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-border"
        style={{ width: chatWidth }}
      >
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
          <span className="ml-auto">
            <TargetBadge kind={badge.kind} state={badge.state} size="sm" />
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex h-full w-full max-w-[720px] flex-col justify-end gap-3 px-5 py-4">
            {turns.map((turn, index) => (
              <div key={index} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-secondary px-3.5 py-2.5 text-[15px] leading-relaxed text-foreground/95">
                  {turn}
                </div>
              </div>
            ))}
          </div>
        </div>
        <InputBar
          onSend={handleSend}
          prefillMessage=""
          badges={noBadges}
          onRemoveBadge={() => {}}
          onAddImage={() => {}}
        />
      </div>

      <ResizeHandle value={chatWidth} onChange={onChatWidthChange} />

      {boardsReady ? (
        <MainSurface showLocationTrail={false} onExpandChat={() => {}} scenario={scenarios[DEFAULT_SCENARIO]} />
      ) : (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          <header className="h-10 shrink-0 border-b border-border" />
          <RunView targetKind={targetKind} targetLabel={targetLabel} onReady={() => setBoardsReady(true)} />
        </div>
      )}
    </div>
  )
}
