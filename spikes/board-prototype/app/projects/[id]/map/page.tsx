"use client"

import { useParams, useRouter } from "next/navigation"
import { ContextMapFullView } from "@/components/context-map"
import { useAppStore } from "@/lib/store"

export default function ContextMapRoute() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const hosts = useAppStore((s) => s.hosts)
  const project = hosts.flatMap((h) => h.projects).find((p) => p.id === params.id)

  return (
    <ContextMapFullView
      projectName={project?.name ?? "rennet"}
      // The map always returns to the New chat of its project.
      onBack={() => router.push(`/new-chat?project=${params.id}`)}
    />
  )
}
