"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  DraftingCompass,
  FileDiff,
  Flag,
  GitCommitHorizontal,
  History,
  ListOrdered,
  Map,
  PanelLeft,
  PenLine,
  VolumeX,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Coachmark } from "@/components/coachmark"
import { SessionTrail } from "@/components/location-trail"
import { ViewSwitcher } from "@/components/view-switcher"
import { ContextMapPanel, MapBaseLine } from "@/components/context-map"
import { DiffView } from "@/components/diff-view"
import { HandoffView } from "@/components/handoff-view"
import { useCodeComments } from "@/components/code-comments"
import { FabPips } from "@/components/fab-pips"
import { LensBoardView } from "@/components/lens-board"
import { RoundsLedger } from "@/components/round-report"
import { useAppStore } from "@/lib/store"
import type { LensBoard } from "@/lib/lens-data"
import type { LensId } from "@/lib/lens-data"
import type { Scenario } from "@/lib/scenarios"
import type { SessionItem } from "@/lib/sidebar-data"

const LENS_SEGMENTS: { lens: LensId; segment: string; icon: LucideIcon }[] = [
  { lens: "design", segment: "Design", icon: DraftingCompass },
  { lens: "sequence", segment: "Sequence", icon: ListOrdered },
  { lens: "decisions", segment: "Decisions", icon: GitCommitHorizontal },
  { lens: "flagged", segment: "Flagged", icon: Flag },
  { lens: "noise", segment: "Noise", icon: VolumeX },
]

/** The non-lens board views; board (the active lens) is the omitted default. */
type ViewParam = "board" | "diff" | "map" | "handoff" | "rounds"

export function MainSurface({
  showLocationTrail,
  onExpandChat,
  scenario,
  trail,
  onDispatchRound,
  onOpenPullRequest,
}: {
  showLocationTrail: boolean
  onExpandChat: () => void
  scenario: Scenario
  /** project + session behind the trail; falls back to the scenario fixture. */
  trail?: { projectName: string; session: SessionItem }
  onDispatchRound?: () => void
  onOpenPullRequest?: () => void
}) {
  // Absent lens = absent segment (never disabled). Diff is not a lens: it
  // lives beside Map as a raw-source toggle, not in the switcher.
  const views: { lens: LensId; segment: string; icon: LucideIcon; board: LensBoard | null }[] = LENS_SEGMENTS.filter(
    ({ lens }) => scenario.boards[lens],
  ).map(({ lens, segment, icon }) => ({
    lens,
    segment,
    icon,
    board: scenario.boards[lens] ?? null,
  }))

  // View state lives in the URL: ?view=board|diff|map|handoff (board omitted)
  // and ?lens=<lensId>. Unknown values fall back to board / first lens.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // The rounds ledger exists exactly when a round has completed (absent
  // control otherwise, never a disabled one).
  const rounds = scenario.rounds ?? []
  const viewParam = searchParams.get("view")
  const currentView: ViewParam =
    viewParam === "diff" || viewParam === "map" || viewParam === "handoff" || (viewParam === "rounds" && rounds.length > 0)
      ? (viewParam as ViewParam)
      : "board"
  const mapOpen = currentView === "map"
  const diffOpen = currentView === "diff"
  const handoffOpen = currentView === "handoff"
  const roundsOpen = currentView === "rounds"

  const lensParam = searchParams.get("lens")
  const view = views.find((v) => v.lens === lensParam) ?? views[0]
  const active = view.segment

  // Replace (never push) so toggling views doesn't spam back history.
  const go = (nextView: ViewParam, lens: LensId) => {
    const params = new URLSearchParams()
    if (nextView !== "board") params.set("view", nextView)
    params.set("lens", lens)
    router.replace(`${pathname}?${params.toString()}`)
  }

  const viewedDeltaSections = useAppStore((s) => s.viewedDeltaSections)
  const store = useCodeComments()
  const askCount = store?.asks.length ?? 0
  // The CTA names the job per review target (R35).
  const ctaLabel = scenario.cta
  const fabRef = React.useRef<HTMLButtonElement>(null)
  // One durable pip: everything currently staged into the review. A comment
  // or thread an ask was born from is the SAME item — the ask claims it.
  const asks = store?.asks ?? []
  const claimedLines = new Set(
    asks.filter((a) => a.codeAnchor).map((a) => `${a.codeAnchor?.path}:${a.codeAnchor?.line}`),
  )
  const claimedThreads = new Set(asks.map((a) => a.threadId).filter(Boolean))
  const commentCount = Object.entries(store?.comments ?? {}).reduce(
    (sum, [path, lines]) =>
      sum + Object.keys(lines).filter((line) => !claimedLines.has(`${path}:${line}`)).length,
    0,
  )
  const threadCount = (store?.quoteComments ?? []).filter(
    (t) => t.kind !== "explain" && !claimedThreads.has(t.id),
  ).length
  const pipCount = askCount + commentCount + threadCount

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border px-3 @container">
        <div className="flex items-center gap-2 justify-self-start">
          {showLocationTrail && (
            <>
              <button
                type="button"
                onClick={onExpandChat}
                aria-label="Expand chat"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <PanelLeft className="size-3.5" aria-hidden="true" />
              </button>
              <SessionTrail
                projectName={trail?.projectName ?? "rennet"}
                session={trail?.session ?? scenario.session}
              />
            </>
          )}
        </div>
        <div data-tour="lenses" className="flex min-w-0 items-center gap-1.5 justify-self-center">
          <Coachmark id="lenses" />
          <ViewSwitcher
            segments={views.map((v) => ({
              label: v.segment,
              icon: v.icon,
              // Unread round-delta rollup (dot decays as sections are opened).
              dot: v.board?.sections.some((s) => s.delta && !viewedDeltaSections[s.id]) ?? false,
            }))}
            active={mapOpen || diffOpen || handoffOpen || roundsOpen ? "" : active}
            onChange={(segment) => {
              const picked = views.find((v) => v.segment === segment) ?? views[0]
              go("board", picked.lens)
            }}
          />
        </div>
        {/* Rounds · Map · Diff — the ledger control joins the pill row only
            once a round has completed. */}
        <div className="flex items-center gap-1.5 justify-self-end">
        {rounds.length > 0 && (
          <button
            type="button"
            onClick={() => go(roundsOpen ? "board" : "rounds", view.lens)}
            aria-pressed={roundsOpen}
            aria-label="Rounds"
            title="Rounds"
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border bg-card py-1 px-2.5 text-[12px] font-medium transition-colors",
              roundsOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <History className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden @[54rem]:inline">Rounds</span>
          </button>
        )}
        {/* Map · Diff — one pill, two halves (R49 shape, header home). */}
        <div className="flex overflow-hidden rounded-full border border-border bg-card">
          <button
            type="button"
            onClick={() => go(mapOpen ? "board" : "map", view.lens)}
            aria-pressed={mapOpen}
            aria-label="Map"
            title="Map"
            className={cn(
              "flex items-center gap-1.5 py-1 pl-2.5 pr-2 text-[12px] font-medium transition-colors",
              mapOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Map className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden @[54rem]:inline">Map</span>
          </button>
          <span className="w-px self-stretch bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={() => go(diffOpen ? "board" : "diff", view.lens)}
            aria-pressed={diffOpen}
            aria-label="Diff"
            title="Diff"
            className={cn(
              "flex items-center gap-1.5 py-1 pl-2 pr-2.5 text-[12px] font-medium transition-colors",
              diffOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileDiff className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden @[54rem]:inline">Diff</span>
          </button>
        </div>
        </div>
      </header>
      {/* The view region owns the floating controls: they live in the margin
          beside the centered content column (R49). */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden @container">
        {handoffOpen ? (
          <HandoffView
            handoff={scenario.handoff}
            onDispatchRound={onDispatchRound}
            onOpenPullRequest={onOpenPullRequest}
          />
        ) : mapOpen ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <MapBaseLine />
            <ContextMapPanel />
          </div>
        ) : diffOpen ? (
          <DiffView />
        ) : roundsOpen ? (
          <RoundsLedger rounds={rounds} />
        ) : view?.board ? (
          <div data-tour="highlight" className="min-h-0 flex-1 overflow-y-auto">
            <Coachmark id="highlight" />
            <LensBoardView board={view.board} foldAll={view.lens !== "flagged"} />
          </div>
        ) : null}

        {/* The exit CTA — a real floating action button, bottom-right. Staged
            work flies in and lands as register pips (R50); opening the
            hand-off clears them (the draft has been seen). */}
        <Coachmark id="fab" />
        <button
          ref={fabRef}
          type="button"
          data-tour="fab"
          onClick={() => go(handoffOpen ? "board" : "handoff", view.lens)}
          aria-pressed={handoffOpen}
          aria-label={pipCount > 0 ? `${ctaLabel} · ${pipCount}` : ctaLabel}
          title={ctaLabel}
          className={cn(
            "absolute bottom-6 right-5 z-20 flex items-center gap-2 rounded-full px-5 py-3 text-[14px] font-semibold shadow-lg transition-colors",
            handoffOpen
              ? "border border-border bg-secondary text-foreground"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          <PenLine className="size-4.5 shrink-0" aria-hidden="true" />
          <span className="hidden @[54rem]:inline">{ctaLabel}</span>
          <FabPips fabRef={fabRef} count={pipCount} />
        </button>
      </div>
    </div>
  )
}
