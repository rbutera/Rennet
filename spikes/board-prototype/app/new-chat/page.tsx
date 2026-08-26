"use client"

import { Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { NewChatView, targetOf } from "@/components/new-chat-view"
import type { SmartListItem } from "@/lib/smart-list-data"
import { useAppStore } from "@/lib/store"

export default function NewChatRoute() {
  return (
    <Suspense>
      <NewChatInner />
    </Suspense>
  )
}

function NewChatInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const hosts = useAppStore((s) => s.hosts)

  // Resolve the param against real projects (by id, then by name) — an
  // unknown value must fall back, never mint a session into a ghost project.
  const allProjects = hosts.flatMap((h) => h.projects)
  const projectParam = searchParams.get("project")
  const projectId =
    allProjects.find((p) => p.id === projectParam)?.id ??
    allProjects.find((p) => p.name === projectParam)?.id ??
    allProjects[0]?.id ??
    "p1"

  function start(item: SmartListItem | null, message: string) {
    const project = hosts.flatMap((h) => h.projects).find((p) => p.id === projectId)
    const targetLabel = item
      ? item.kind === "pr"
        ? `#${item.number} · ${item.branch}`
        : item.branch
      : "main"
    const title = item ? `Review ${targetLabel}` : message.trim() || "New review"
    const id = useAppStore.getState().mintSession(projectId, title)
    useAppStore.getState().startSessionView({
      id,
      projectName: project?.name ?? "rennet",
      targetLabel,
      targetKind: item?.kind === "pr" ? "pr" : "branch",
      badge: item ? targetOf(item) : { kind: "your-branch" },
      initialMessage: message || undefined,
    })
    router.push(`/s/${id}`)
  }

  return (
    <NewChatView
      hosts={hosts}
      projectId={projectId}
      onProjectChange={(id) => router.replace(`/new-chat?project=${id}`)}
      onClose={() => router.back()}
      onStart={start}
      onOpenMap={() => router.push(`/projects/${projectId}/map`)}
    />
  )
}
