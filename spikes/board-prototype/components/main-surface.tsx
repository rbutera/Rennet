"use client"

import { useState } from "react"
import {
  DraftingCompass,
  FileDiff,
  Flag,
  GitCommitHorizontal,
  ListOrdered,
  Map,
  PanelLeft,
  PenLine,
  VolumeX,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { LocationTrail } from "@/components/location-trail"
import { ViewSwitcher } from "@/components/view-switcher"
import { ContextMapPanel, MapBaseLine } from "@/components/context-map"
import { HandoffView } from "@/components/handoff-view"
import { useCodeComments } from "@/components/code-comments"
import { LensBoardView } from "@/components/lens-board"
import type { LensBoard } from "@/lib/lens-data"
import type { LensId } from "@/lib/lens-data"
import type { Scenario } from "@/lib/scenarios"

const LENS_SEGMENTS: { lens: LensId; segment: string; icon: LucideIcon }[] = [
  { lens: "design", segment: "Design", icon: DraftingCompass },
  { lens: "sequence", segment: "Sequence", icon: ListOrdered },
  { lens: "decisions", segment: "Decisions", icon: GitCommitHorizontal },
  { lens: "flagged", segment: "Flagged", icon: Flag },
  { lens: "noise", segment: "Noise", icon: VolumeX },
]

export function MainSurface({
  showLocationTrail,
  onExpandChat,
  scenario,
}: {
  showLocationTrail: boolean
  onExpandChat: () => void
  scenario: Scenario
}) {
  // Absent lens = absent segment (never disabled); Diff always exists.
  const views: { segment: string; icon: LucideIcon; board: LensBoard | null }[] = [
    ...LENS_SEGMENTS.filter(({ lens }) => scenario.boards[lens]).map(({ lens, segment, icon }) => ({
      segment,
      icon,
      board: scenario.boards[lens] ?? null,
    })),
    { segment: "Diff", icon: FileDiff, board: null },
  ]
  const [active, setActive] = useState(views[0].segment)
  const [mapOpen, setMapOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const store = useCodeComments()
  const askCount = store?.asks.length ?? 0
  // The CTA names the job per review target (R35).
  const ctaLabel = scenario.cta
  const view = views.find((v) => v.segment === active) ?? views[0]

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border px-3 @container">
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
            <span className="hidden @[46rem]:inline">Map</span>
          </button>
          <ViewSwitcher
            segments={views.map((v) => ({ label: v.segment, icon: v.icon }))}
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
            aria-label={ctaLabel}
            title={ctaLabel}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
              handoffOpen
                ? "bg-secondary text-foreground"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            <PenLine className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden @[46rem]:inline">{ctaLabel}</span>
            {askCount > 0 && <span>· {askCount}</span>}
          </button>
        </div>
      </header>
      {handoffOpen ? (
        <HandoffView
          prLabel={scenario.handoff.mode === "post-review" ? scenario.handoff.prLabel : undefined}
        />
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
