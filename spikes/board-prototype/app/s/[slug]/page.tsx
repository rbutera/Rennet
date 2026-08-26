"use client"

import * as React from "react"
import { Suspense } from "react"
import { useParams, useRouter } from "next/navigation"
import { MainSurface } from "@/components/main-surface"
import { RoundReportGreeting } from "@/components/round-report"
import { SessionView } from "@/components/session-view"
import { resolveSlug } from "@/lib/resolve-slug"
import { useAppStore } from "@/lib/store"

export default function BoardPage() {
  const router = useRouter()
  const params = useParams<{ slug: string }>()
  const slug = decodeURIComponent(params.slug)

  const hosts = useAppStore((s) => s.hosts)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const greetingOpen = useAppStore((s) => s.greetingOpen)
  const sessionView = useAppStore((s) => s.sessionView)

  const resolution = resolveSlug(slug, hosts)

  // Visiting a scenario route IS starting that session — the sidebar row
  // appears on first visit (first run opens with zero sessions, R54).
  const scenarioId = resolution.kind === "scenario" ? resolution.scenario.id : null
  React.useEffect(() => {
    if (scenarioId) useAppStore.getState().addScenarioSession(scenarioId)
  }, [scenarioId])

  // A minted new-chat session renders the full SessionView (its own chat + run).
  if (resolution.kind === "session" && sessionView?.id === resolution.sessionId) {
    return (
      <SessionView
        projectName={sessionView.projectName}
        targetLabel={sessionView.targetLabel}
        targetKind={sessionView.targetKind}
        badge={sessionView.badge}
      />
    )
  }

  // Any other slug without a scenario: an empty session placeholder.
  if (resolution.kind !== "scenario") {
    const known = hosts
      .flatMap((h) => h.projects)
      .flatMap((p) => p.sessions)
      .find((s) => s.id === slug)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden px-6 text-center">
        <p className="text-[15px] font-medium text-foreground">{known?.title ?? "Session"}</p>
        <p className="text-[13px] text-muted-foreground">No scenario backs this session.</p>
      </div>
    )
  }

  const scenario = resolution.scenario

  // The trail reads the live session record (renames included), falling back
  // to the scenario fixture before the sidebar row exists.
  const trailProject = hosts
    .flatMap((h) => h.projects)
    .find((p) => p.sessions.some((s) => s.id === scenario.session.id))
  const trail = {
    projectName: trailProject?.name ?? "rennet",
    session: trailProject?.sessions.find((s) => s.id === scenario.session.id) ?? scenario.session,
  }

  // The greeting: the round report fills the surface while the lens drafters
  // regenerate live; the way to the new generation appears when it composes.
  const latestRound = scenario.rounds?.at(-1)
  if (scenario.id === "returned" && greetingOpen && latestRound) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <header className="h-14 shrink-0 border-b border-border" />
        <RoundReportGreeting
          round={latestRound}
          onViewBoards={() => useAppStore.getState().setGreetingOpen(false)}
        />
      </div>
    )
  }

  return (
    // Suspense: useSearchParams inside MainSurface requires a boundary for prerender.
    <Suspense>
      <MainSurface
        showLocationTrail={!chatOpen}
        onExpandChat={() => useAppStore.getState().setChatOpen(true)}
        scenario={scenario}
        trail={trail}
        onDispatchRound={() => router.push(`/s/${slug}/run`)}
      />
    </Suspense>
  )
}
