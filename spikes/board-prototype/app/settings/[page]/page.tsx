"use client"

import { Suspense } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { SettingsView } from "@/components/settings-view"
import type { SettingsPage } from "@/lib/settings-data"
import { useAppStore } from "@/lib/store"

export default function SettingsRoute() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  )
}

function SettingsInner() {
  const router = useRouter()
  const params = useParams<{ page: string }>()
  const searchParams = useSearchParams()
  const hosts = useAppStore((s) => s.hosts)

  return (
    <SettingsView
      hosts={hosts}
      initialPage={params.page as SettingsPage}
      activeProjectId={searchParams.get("project") ?? "p1"}
      onClose={() => router.back()}
      onRenameProject={(projectId, name) => useAppStore.getState().renameProject(projectId, name)}
      onSetProjectIcon={(projectId, icon) => useAppStore.getState().setProjectIcon(projectId, icon)}
    />
  )
}
