"use client"

import { useRouter } from "next/navigation"
import { ArchivedView } from "@/components/archived-view"
import { slugForSession } from "@/lib/resolve-slug"
import { useAppStore } from "@/lib/store"

export default function ArchivedRoute() {
  const router = useRouter()
  const hosts = useAppStore((s) => s.hosts)

  return (
    <ArchivedView
      hosts={hosts}
      onBack={() => router.back()}
      onSelectSession={(sessionId) => router.push(`/s/${slugForSession(sessionId)}`)}
      onUnarchive={(sessionId) => useAppStore.getState().toggleArchiveSession(sessionId)}
    />
  )
}
