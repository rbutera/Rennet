"use client"

import * as React from "react"
import { Archive, ArchiveRestore, ArrowLeft, Check, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { TargetIcon } from "@/components/target-badge"
import { ProjectIcon } from "@/components/project-icon"
import type { HostItem, ProjectItem, SessionItem } from "@/lib/sidebar-data"

type SortKey = "recent" | "project" | "title"

/** Fuzzy sidebar times ("now", "1h", "2d", "3w") to minutes, for sorting. */
function timeToMinutes(time: string): number {
  if (time === "now") return 0
  if (time === "yesterday") return 24 * 60
  const match = /^(\d+)([mhdw])$/.exec(time)
  if (!match) return Number.MAX_SAFE_INTEGER
  const value = Number(match[1])
  const unit = { m: 1, h: 60, d: 24 * 60, w: 7 * 24 * 60 }[match[2] as "m" | "h" | "d" | "w"]
  return value * unit
}

/**
 * Archived sessions as a main-surface location, same shape as Settings:
 * back arrow / Esc leave, the board stays mounted underneath.
 */
export function ArchivedView({
  hosts,
  onBack,
  onSelectSession,
  onUnarchive,
}: {
  hosts: HostItem[]
  onBack: () => void
  onSelectSession: (sessionId: string) => void
  onUnarchive: (sessionId: string) => void
}) {
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState<SortKey>("recent")

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onBack()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onBack])

  const all = hosts.flatMap((host) =>
    host.projects.flatMap((project) =>
      project.sessions.filter((s) => s.archived).map((session) => ({ session, project, host })),
    ),
  )

  const q = query.trim().toLowerCase()
  const shown = all
    .filter(
      ({ session, project }) =>
        !q || session.title.toLowerCase().includes(q) || project.name.toLowerCase().includes(q),
    )
    .sort((a, b) => {
      if (sort === "project") {
        return (
          a.project.name.localeCompare(b.project.name) ||
          timeToMinutes(a.session.time) - timeToMinutes(b.session.time)
        )
      }
      if (sort === "title") return a.session.title.localeCompare(b.session.title)
      return timeToMinutes(a.session.time) - timeToMinutes(b.session.time)
    })

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </button>
        <span className="text-[13px] font-medium text-foreground">Archived</span>
        {all.length > 0 && (
          <span className="text-[11px] text-muted-foreground">{all.length}</span>
        )}
        <kbd className="ml-auto rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-8 py-8">
          {all.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-24 text-center">
              <Archive className="size-5 text-muted-foreground/50" aria-hidden="true" />
              <span className="text-[14px] text-muted-foreground">Nothing archived.</span>
              <span className="text-[12px] text-muted-foreground/70">
                Right-click a session in the sidebar to archive it.
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="flex h-8 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2 focus-within:border-ring">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      // Esc clears the search before it can close the view.
                      if (event.key === "Escape" && query) {
                        event.stopPropagation()
                        setQuery("")
                      }
                    }}
                    placeholder="Search archived sessions…"
                    aria-label="Search archived sessions"
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="flex items-center gap-0.5 rounded-md border border-border bg-card/40 p-0.5" role="radiogroup" aria-label="Sort by">
                  {(["recent", "project", "title"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={sort === key}
                      onClick={() => setSort(key)}
                      className={cn(
                        "rounded-[5px] px-2 py-0.5 text-[12px] transition-colors",
                        sort === key
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              </div>

              {shown.length === 0 ? (
                <span className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                  No archived sessions match “{query.trim()}”.
                </span>
              ) : (
                <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {shown.map(({ session, project }) => (
                    <ArchivedRow
                      key={session.id}
                      session={session}
                      project={project}
                      onSelect={() => onSelectSession(session.id)}
                      onUnarchive={() => onUnarchive(session.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ArchivedRow({
  session,
  project,
  onSelect,
  onUnarchive,
}: {
  session: SessionItem
  project: ProjectItem
  onSelect: () => void
  onUnarchive: () => void
}) {
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/40">
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex items-center gap-1.5">
          <TargetIcon
            kind={session.target}
            state={session.targetState === "reviewed" ? undefined : session.targetState}
            className="size-3"
          />
          <span className="truncate text-[13px] leading-tight text-foreground/90">
            {session.title}
          </span>
          {session.targetState === "reviewed" && (
            <Check className="size-3 shrink-0 text-green-500" aria-label="Reviewed" />
          )}
        </span>
        <span className="pl-[18px] text-[11px] text-muted-foreground">{session.time}</span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[12px] text-muted-foreground">
        <ProjectIcon icon={project.icon} className="size-3" />
        {project.name}
      </span>
      <button
        type="button"
        onClick={onUnarchive}
        className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <ArchiveRestore className="size-3.5" aria-hidden="true" />
        Unarchive
      </button>
    </div>
  )
}
