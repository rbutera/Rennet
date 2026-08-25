"use client"

import { useParams, useRouter } from "next/navigation"
import { ProjectIndexingView } from "@/components/project-indexing-view"
import { useAppStore } from "@/lib/store"

export default function ProjectIndexingRoute() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const hosts = useAppStore((s) => s.hosts)
  const project = hosts.flatMap((h) => h.projects).find((p) => p.id === params.id)

  return (
    <ProjectIndexingView
      projectName={project?.name ?? "rennet"}
      onBack={() => router.back()}
      onNewChat={() => router.push(`/new-chat?project=${params.id}`)}
      onViewMap={() => router.push(`/projects/${params.id}/map`)}
    />
  )
}
