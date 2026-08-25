"use client"

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { RoundRunView } from "@/components/run-view"
import { resolveSlug } from "@/lib/resolve-slug"
import { useAppStore } from "@/lib/store"

/**
 * The one place RoundRunView renders (route-first, W2C). Deep-linkable cold.
 * Only a rounds-type handoff has a round to run — anything else (post-review
 * scenarios, plain sessions) bounces to the board. Once the round has finished,
 * its session row is stamped off its fixture time; revisiting the run route
 * (back from /s/returned) detects that and bounces too, so the demo never
 * phantom-restarts and re-pushes you forward.
 */
export default function RunPage() {
  const router = useRouter()
  const params = useParams<{ slug: string }>()
  const slug = decodeURIComponent(params.slug)
  const hosts = useAppStore((s) => s.hosts)

  const resolution = resolveSlug(slug, hosts)
  const scenario = resolution.kind === "scenario" ? resolution.scenario : null
  const isRound = scenario?.handoff.mode === "rounds"
  const liveTime = hosts
    .flatMap((h) => h.projects)
    .flatMap((p) => p.sessions)
    .find((s) => s.id === scenario?.session.id)?.time
  const alreadyRan = isRound && liveTime !== scenario?.session.time

  const bounce = !isRound || alreadyRan
  React.useEffect(() => {
    if (bounce) router.replace(`/s/${slug}`)
  }, [bounce, router, slug])

  if (bounce) return null

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="h-10 shrink-0 border-b border-border" />
      <RoundRunView
        onComplete={() => {
          useAppStore.getState().stampSession("s2", "round complete")
          useAppStore.getState().setGreetingOpen(true)
          router.push("/s/returned")
        }}
      />
    </div>
  )
}
