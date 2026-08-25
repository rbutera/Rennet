import { ChevronRight } from "lucide-react"
import { TargetIcon } from "@/components/target-badge"
import type { SessionItem } from "@/lib/sidebar-data"

/** project › session, led by the session's target icon (branch / PR / …). */
export function LocationTrail({
  projectName,
  session,
}: {
  projectName: string
  session: SessionItem
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
      <TargetIcon
        kind={session.target}
        state={session.targetState === "reviewed" ? undefined : session.targetState}
        className="size-3.5 shrink-0"
      />
      <span className="shrink-0 font-medium text-foreground">{projectName}</span>
      <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
      <span className="truncate text-muted-foreground">{session.title}</span>
    </div>
  )
}
