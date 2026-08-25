"use client"

import { useState } from "react"
import { Map, PanelLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { LocationTrail } from "@/components/location-trail"
import { ViewSwitcher } from "@/components/view-switcher"
import { ContextMapPanel, MapBaseLine } from "@/components/context-map"
import { HandoffView } from "@/components/handoff-view"
import { useCodeComments } from "@/components/code-comments"
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
  const [mapOpen, setMapOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const store = useCodeComments()
  const askCount = store?.asks.length ?? 0
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
        <div className="flex min-w-0 items-center gap-1.5 justify-self-center">
          <button
            type="button"
            onClick={() => setMapOpen((open) => !open)}
            aria-pressed={mapOpen}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-medium transition-colors",
              mapOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Map className="size-3.5" aria-hidden="true" />
            Map
          </button>
          <ViewSwitcher
            segments={VIEWS.map((v) => v.segment)}
            active={mapOpen || handoffOpen ? "" : active}
            onChange={(segment) => {
              setMapOpen(false)
              setHandoffOpen(false)
              setActive(segment)
            }}
          />
        </div>
        <div className="flex items-center gap-1 justify-self-end">
          <button
            type="button"
            onClick={() => {
              setHandoffOpen((open) => !open)
              setMapOpen(false)
            }}
            aria-pressed={handoffOpen}
            className={cn(
              "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
              handoffOpen
                ? "bg-secondary text-foreground"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            Continue{askCount > 0 ? ` · ${askCount}` : ""}
          </button>
        </div>
      </header>
      {handoffOpen ? (
        <HandoffView />
      ) : mapOpen ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <MapBaseLine />
          <ContextMapPanel />
        </div>
      ) : view.board ? (
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
