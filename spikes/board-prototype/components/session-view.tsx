"use client"

import { ChatHeader } from "@/components/chat-column"
import { cn } from "@/lib/utils"
import { InputBar } from "@/components/input-bar"
import { MainSurface } from "@/components/main-surface"
import { DEFAULT_SCENARIO, scenarios } from "@/lib/scenarios"
import { ResizeHandle } from "@/components/resize-handle"
import { RunView } from "@/components/run-view"
import type { TargetState } from "@/components/target-badge"
import type { SessionItem } from "@/lib/sidebar-data"
import type { ComposerBadge } from "@/lib/composer-badges"
import type { TargetKind } from "@/lib/target-language"
import { useAppStore } from "@/lib/store"

/**
 * A just-started review session: blank chat shell on the left, and the right
 * pane is a placeholder for the loading-context / lenses view (its own story,
 * designed next). Entered from the New chat page by picking a target. Turns,
 * boardsReady, and chat width live in the store so they survive navigation.
 */
export function SessionView({
  projectName,
  targetLabel,
  targetKind,
  badge,
}: {
  projectName: string
  targetLabel: string
  targetKind: "pr" | "branch"
  badge: { kind: TargetKind; state?: TargetState }
}) {
  const turns = useAppStore((s) => s.sessionTurns)
  const boardsReady = useAppStore((s) => s.boardsReady)
  const chatWidth = useAppStore((s) => s.chatWidth)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const appendSessionTurn = useAppStore((s) => s.appendSessionTurn)
  const setBoardsReady = useAppStore((s) => s.setBoardsReady)
  const onChatWidthChange = useAppStore((s) => s.setChatWidth)

  // The same session shape every chat surface renders (unified header/trail).
  const session: SessionItem = {
    id: "staged-run",
    title: targetLabel,
    time: "now",
    target: badge.kind,
    targetState: badge.state,
  }

  function handleSend(message: string) {
    appendSessionTurn(message)
  }

  const noBadges: ComposerBadge[] = []

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div
        className={cn(
          "flex h-full min-h-0 shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none",
        )}
        style={{ width: chatOpen ? chatWidth : 0 }}
        inert={!chatOpen}
      >
      <div
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-border"
        style={{ width: chatWidth }}
      >
        <ChatHeader
          projectName={projectName}
          session={session}
          onCollapse={() => useAppStore.getState().setChatOpen(false)}
        />
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
      </div>

      {chatOpen && <ResizeHandle value={chatWidth} onChange={onChatWidthChange} />}

      {boardsReady ? (
        <MainSurface
          showLocationTrail={!chatOpen}
          onExpandChat={() => useAppStore.getState().setChatOpen(true)}
          scenario={scenarios[DEFAULT_SCENARIO]}
          trail={{ projectName, session }}
        />
      ) : (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          <header className="h-10 shrink-0 border-b border-border" />
          <RunView targetKind={targetKind} targetLabel={targetLabel} onReady={() => setBoardsReady(true)} />
        </div>
      )}
    </div>
  )
}
