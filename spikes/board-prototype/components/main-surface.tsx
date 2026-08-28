"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  DraftingCompass,
  FileDiff,
  Flag,
  GitCommitHorizontal,
  History,
  ListOrdered,
  Map,
  MessageSquare,
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
  scenario,
  trail,
  onDispatchRound,
  onOpenPullRequest,
}: {
  showLocationTrail: boolean
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

  // Replace (never push) so toggling views doesn't spam back history — the
  // back arrow rides this remembered view instead of the browser's stack.
  const previous = React.useRef<{ view: ViewParam; lens: LensId } | null>(null)
  const go = (nextView: ViewParam, lens: LensId, remember = true) => {
    if (remember && nextView !== currentView)
      previous.current = nextView === "board" ? null : { view: currentView, lens: view.lens }
    const params = new URLSearchParams()
    if (nextView !== "board") params.set("view", nextView)
    params.set("lens", lens)
    router.replace(`${pathname}?${params.toString()}`)
  }
  const goBack = () => {
    const target = previous.current ?? { view: "board" as ViewParam, lens: view.lens }
    previous.current = null
    go(target.view, target.lens, false)
  }

  const viewedDeltaSections = useAppStore((s) => s.viewedDeltaSections)
  // The Flagged pip: findings not yet dismissed or requested. Both exits
  // shrink it; requesting also lands the staged ask on the FAB as usual.
  const findingStatus = useAppStore((s) => s.findingStatus)
  const openFindings = (board: LensBoard | null) =>
    board?.sections.reduce(
      (sum, section) =>
        sum +
        section.elements.filter((e) => e.kind === "finding" && !findingStatus[e.id]).length,
      0,
    ) ?? 0
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

  // STATE 3 of the corner-slot demo: nothing is left of the main view, so it
  // goes full-bleed and its titlebar contents become floating pill chips.
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const floatingBar = !sidebarOpen && !chatOpen
  // Translucent chip skin for the floating variant; solid card otherwise.
  const pillSkin = floatingBar ? "border-border/50 bg-card/60 backdrop-blur-md" : "border-border bg-card"

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header
        className={cn(
          "grid grid-cols-[1fr_auto_1fr] items-center px-3 @container",
          floatingBar
            ? "pointer-events-none absolute inset-x-0 top-0 z-30 h-10"
            : "h-14 shrink-0 border-b border-border",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 justify-self-start",
            // Clear the floating corner slot (lights + toggle end near x=116).
            floatingBar && "pointer-events-auto ml-[112px]",
          )}
        >
          {currentView !== "board" && (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              title="Back"
              className={cn(
                "flex shrink-0 items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground",
                floatingBar ? cn("size-8 rounded-full border shadow-sm", pillSkin) : "size-6 rounded-md",
              )}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </button>
          )}
          {/* The chat's one open/close control lives here, on the rightmost
              pane — a plain header button, or a floating FAB in the same spot
              when the titlebar has dissolved. */}
          <button
            type="button"
            onClick={() => useAppStore.getState().setChatOpen(!chatOpen)}
            aria-pressed={chatOpen}
            aria-label={chatOpen ? "Close chat" : "Open chat"}
            title={chatOpen ? "Close chat" : "Open chat"}
            className={cn(
              "flex shrink-0 items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground",
              floatingBar
                ? cn("size-8 rounded-full border shadow-sm", pillSkin)
                : "size-6 rounded-md",
            )}
          >
            <MessageSquare className="size-3.5" aria-hidden="true" />
          </button>
          {showLocationTrail && (
            <div className={cn("min-w-0", floatingBar && cn("rounded-full border py-1 pl-2.5 pr-3", pillSkin))}>
              <SessionTrail
                projectName={trail?.projectName ?? "rennet"}
                session={trail?.session ?? scenario.session}
              />
            </div>
          )}
        </div>
        <div
          data-tour="lenses"
          className={cn(
            "flex min-w-0 items-center gap-1.5 justify-self-center",
            floatingBar &&
              "pointer-events-auto [&_[role=tablist]]:border-border/50 [&_[role=tablist]]:bg-card/60 [&_[role=tablist]]:backdrop-blur-md",
          )}
        >
          <Coachmark id="lenses" />
          <ViewSwitcher
            segments={views.map((v) => ({
              label: v.segment,
              icon: v.icon,
              // Unread round-delta rollup (dot decays as sections are opened).
              dot: v.board?.sections.some((s) => s.delta && !viewedDeltaSections[s.id]) ?? false,
              count: v.lens === "flagged" ? openFindings(v.board) : undefined,
            }))}
            active={mapOpen || diffOpen || handoffOpen || roundsOpen ? "" : active}
            onChange={(segment) => {
              const picked = views.find((v) => v.segment === segment) ?? views[0]
              go("board", picked.lens)
            }}
          />
        </div>
        {/* History · Map · Diff — the ledger control joins the pill row only
            once a round has completed. Its label folds away earlier than
            Map/Diff's (66rem vs 54rem): it sits nearest the centered lens
            pill and looks janky when the two touch. */}
        <div className={cn("flex items-center gap-1.5 justify-self-end", floatingBar && "pointer-events-auto")}>
        {rounds.length > 0 && (
          <button
            type="button"
            onClick={() => go(roundsOpen ? "board" : "rounds", view.lens)}
            aria-pressed={roundsOpen}
            aria-label="History"
            title="History"
            className={cn(
              "flex items-center gap-1.5 rounded-full border py-1 px-2.5 text-[12px] font-medium transition-colors",
              pillSkin,
              roundsOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <History className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden @[66rem]:inline">History</span>
          </button>
        )}
        {/* Map · Diff — one pill, two halves (R49 shape, header home). */}
        <div className={cn("flex overflow-hidden rounded-full border", pillSkin)}>
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
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden @container",
          // Floating chips have no bar to sit in, so views clear them here.
          floatingBar && "pt-11",
        )}
      >
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
          <div
            data-tour="highlight"
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              // The board takes the clearance as scroll padding instead, so
              // prose slides under the translucent chips as you scroll.
              floatingBar && "-mt-11 pt-11",
            )}
          >
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
            "absolute bottom-6 right-5 z-20 flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-[14px] font-semibold text-primary-foreground shadow-lg transition-all duration-200 hover:bg-primary/90",
            // The hand-off IS the exit: on that view the FAB gets out of the way.
            handoffOpen && "pointer-events-none scale-75 opacity-0",
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
