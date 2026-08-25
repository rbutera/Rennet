"use client"

import { Suspense } from "react"
import { useParams, useRouter } from "next/navigation"
import { MainSurface } from "@/components/main-surface"
import { SuccessorSummary } from "@/components/successor-summary"
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

  // A minted new-chat session renders the full SessionView (its own chat + run).
  if (resolution.kind === "session" && sessionView?.id === resolution.sessionId) {
    return (
      <SessionView
        projectName={sessionView.projectName}
        targetLabel={sessionView.targetLabel}
        targetKind={sessionView.targetKind}
        badge={sessionView.badge}
        onBack={() => router.back()}
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

  if (scenario.id === "returned" && greetingOpen) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <header className="h-10 shrink-0 border-b border-border" />
        <SuccessorSummary onDismiss={() => useAppStore.getState().setGreetingOpen(false)} />
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
