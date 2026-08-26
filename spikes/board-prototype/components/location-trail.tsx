import { ChevronRight } from "lucide-react"
import { TargetIcon } from "@/components/target-badge"
import { TARGET_LABEL } from "@/lib/target-language"
import type { SessionItem } from "@/lib/sidebar-data"

/**
 * The one session trail (R51/R52): two lines — session title over
 * target-icon + project › target words ("· needs you" as words beside the
 * accent icon, never a pill). Rendered identically in the main-surface top
 * bar and the chat-pane header.
 */
export function SessionTrail({
  projectName,
  session,
}: {
  projectName: string
  session: SessionItem
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[13px] font-medium leading-tight text-foreground">
        {session.title}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-[11px] leading-tight text-muted-foreground">
        <TargetIcon kind={session.target} state={session.targetState} className="size-3" />
        <span className="shrink-0">{projectName}</span>
        <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
        <span className="truncate">
          {TARGET_LABEL[session.target]}
          {session.targetState === "needs-you" ? " · needs you" : ""}
        </span>
      </span>
    </div>
  )
}
