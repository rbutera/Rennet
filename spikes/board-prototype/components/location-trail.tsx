import { ChevronRight, GitPullRequest } from "lucide-react"

export function LocationTrail() {
  return (
    <div className="flex items-center gap-1.5 text-[13px]">
      <GitPullRequest className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium text-foreground">rennet</span>
      <ChevronRight className="size-3 text-muted-foreground/50" aria-hidden="true" />
      <span className="text-muted-foreground">pr-434</span>
      <ChevronRight className="size-3 text-muted-foreground/50" aria-hidden="true" />
      <span className="text-foreground">review</span>
    </div>
  )
}
