"use client"

import { useState } from "react"
import { PanelLeft } from "lucide-react"
import { LocationTrail } from "@/components/location-trail"
import { ViewSwitcher } from "@/components/view-switcher"
import { LensBoardView } from "@/components/lens-board"
import type { LensBoard } from "@/lib/lens-data"
import { designBoard } from "@/lib/fixtures/design"
import { sequenceBoard } from "@/lib/fixtures/sequence"
import { decisionsBoard } from "@/lib/fixtures/decisions"
import { flaggedBoard } from "@/lib/fixtures/flagged"
import { noiseBoard } from "@/lib/fixtures/noise"

const VIEWS: { segment: string; board: LensBoard | null }[] = [
  { segment: "Design", board: designBoard },
  { segment: "Sequence", board: sequenceBoard },
  { segment: "Decisions", board: decisionsBoard },
  { segment: "Flagged", board: flaggedBoard },
  { segment: "Noise", board: noiseBoard },
  { segment: "Diff", board: null },
]

export function MainSurface({
  showLocationTrail,
  onExpandChat,
}: {
  showLocationTrail: boolean
  onExpandChat: () => void
}) {
  const [active, setActive] = useState(VIEWS[0].segment)
  const view = VIEWS.find((v) => v.segment === active) ?? VIEWS[0]

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="grid h-10 shrink-0 grid-cols-3 items-center border-b border-border px-3">
        <div className="flex items-center gap-2 justify-self-start">
          {showLocationTrail && (
            <>
              <button
                type="button"
                onClick={onExpandChat}
                aria-label="Expand chat"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <PanelLeft className="size-3.5" aria-hidden="true" />
              </button>
              <LocationTrail />
            </>
          )}
        </div>
        <div className="min-w-0 justify-self-center">
          <ViewSwitcher segments={VIEWS.map((v) => v.segment)} active={active} onChange={setActive} />
        </div>
        <div className="flex items-center gap-1 justify-self-end">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Hand off
          </button>
        </div>
      </header>
      {view.board ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <LensBoardView board={view.board} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-[12px] text-muted-foreground/50">raw diff view — separate story</span>
        </div>
      )}
    </div>
  )
}
