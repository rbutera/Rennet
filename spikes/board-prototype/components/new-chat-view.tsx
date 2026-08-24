"use client"

import * as React from "react"
import {
  ArrowLeft,
  ArrowUp,
  Check,
  GitBranch,
  GitPullRequest,
  GitMerge,
  Search,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { HostItem } from "@/lib/sidebar-data"
import { smartList, type SmartListItem } from "@/lib/smart-list-data"
import { ProjectPicker } from "@/components/settings-view"

/**
 * The New chat page: full-view takeover (no session yet, so no chat column).
 * A centered ask + big composer, then the project's smart list — the unified
 * branches/worktrees/PRs picker (wireframe 05) — as the review-target picker.
 * Selecting a row sets the composer's target chip; "Current checkout" is the
 * default target.
 */

type Target = { kind: "checkout" } | { kind: "item"; item: SmartListItem }

const TABS = ["All", "Needs you", "Mine", "Local", "PRs"] as const
type Tab = (typeof TABS)[number]

function itemKey(item: SmartListItem): string {
  return item.kind === "pr" ? `pr-${item.number}` : `local-${item.repo}-${item.branch}`
}

function matchesTab(item: SmartListItem, tab: Tab): boolean {
  switch (tab) {
    case "All":
      return true
    case "Needs you":
      return item.kind === "pr" && item.state === "needs-you"
    case "Mine":
      return item.kind === "local" || (item.kind === "pr" && item.state === "yours")
    case "Local":
      return item.kind === "local" || (item.kind === "pr" && item.checkedOutLocally === true)
    case "PRs":
      return item.kind === "pr"
  }
}

function matchesFilter(item: SmartListItem, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  const haystack =
    item.kind === "pr"
      ? `#${item.number} ${item.title} ${item.branch} ${item.repo} ${item.author}`
      : `${item.branch} ${item.repo}`
  return haystack.toLowerCase().includes(needle)
}

function targetLabel(target: Target): string {
  if (target.kind === "checkout") return "Current checkout · main"
  return target.item.kind === "pr" ? `#${target.item.number} · ${target.item.branch}` : target.item.branch
}

export function NewChatView({
  hosts,
  projectId,
  onProjectChange,
  onClose,
  onStart,
}: {
  hosts: HostItem[]
  projectId: string
  onProjectChange: (projectId: string) => void
  onClose: () => void
  /** Start the session: item = null means the current checkout / whole project. */
  onStart: (item: SmartListItem | null, message: string) => void
}) {
  const [filter, setFilter] = React.useState("")
  const [tab, setTab] = React.useState<Tab>("All")
  const [target, setTarget] = React.useState<Target>({ kind: "checkout" })
  const [message, setMessage] = React.useState("")

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const host = hosts.find((h) => h.projects.some((p) => p.id === projectId)) ?? hosts[0]
  const project = host.projects.find((p) => p.id === projectId) ?? host.projects[0]
  const items = smartList[project.id] ?? []

  const counts: Record<Tab, number> = Object.fromEntries(
    TABS.map((t) => [t, items.filter((i) => matchesTab(i, t)).length]),
  ) as Record<Tab, number>
  const visible = items.filter((i) => matchesTab(i, tab) && matchesFilter(i, filter))
  const selectedKey = target.kind === "item" ? itemKey(target.item) : null

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </button>
        <span className="text-[13px] text-muted-foreground">{project.name}</span>
        <span className="text-[13px] text-muted-foreground/50">›</span>
        <span className="text-[13px] font-medium text-foreground">New chat</span>
        <kbd className="ml-auto rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col px-8 pb-16 pt-[9vh]">
          <h1 className="flex items-baseline justify-center gap-2.5 text-center text-[26px] font-semibold tracking-tight text-foreground">
            What should we review in
            <ProjectPicker
              hosts={hosts}
              value={project}
              onChange={(p) => {
                onProjectChange(p.id)
                setTarget({ kind: "checkout" })
              }}
            />
            ?
          </h1>

          <div className="mt-7 flex flex-col rounded-xl border border-border bg-card/60 shadow-sm focus-within:border-ring">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="message the orchestrator"
              rows={3}
              aria-label="Message the orchestrator"
              className="w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none"
            />
            <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
              <span className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-1 text-[12px] text-foreground/90">
                {target.kind === "item" && target.item.kind === "pr" ? (
                  <GitPullRequest className="size-3 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <GitBranch className="size-3 text-muted-foreground" aria-hidden="true" />
                )}
                {targetLabel(target)}
                {target.kind === "item" && (
                  <button
                    type="button"
                    onClick={() => setTarget({ kind: "checkout" })}
                    aria-label="Reset target to current checkout"
                    className="flex size-3.5 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                )}
              </span>
              <button
                type="button"
                disabled={!message.trim()}
                onClick={() => onStart(target.kind === "item" ? target.item : null, message.trim())}
                aria-label="Send"
                className={cn(
                  "ml-auto flex size-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed",
                  message.trim()
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="mt-8 flex items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-card/40 p-0.5">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 py-1 text-[12px] font-medium transition-colors",
                    t === tab ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t}
                  <span className={cn("text-[10px]", t === tab ? "text-muted-foreground" : "text-muted-foreground/60")}>
                    {counts[t]}
                  </span>
                </button>
              ))}
            </div>
            <label className="ml-auto flex h-7 w-52 items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 focus-within:border-ring">
              <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  // Esc clears the filter first; a second Esc (empty filter) closes the page.
                  if (event.key === "Escape" && filter) {
                    event.stopPropagation()
                    setFilter("")
                  }
                }}
                placeholder="filter"
                aria-label="Filter branches and pull requests"
                className="w-full bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-col divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
            <CheckoutRow selected={target.kind === "checkout"} onSelect={() => setTarget({ kind: "checkout" })} />
            {visible.map((item) => (
              <ItemRow
                key={itemKey(item)}
                item={item}
                showRepo={new Set(items.map((i) => i.repo)).size > 1}
                selected={selectedKey === itemKey(item)}
                onSelect={() => onStart(item, message.trim())}
              />
            ))}
            {visible.length === 0 && (
              <div className="px-3 py-5 text-center text-[12.5px] text-muted-foreground/60">
                nothing matches
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CheckoutRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors",
        selected ? "bg-secondary/60" : "hover:bg-secondary/30",
      )}
    >
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-[13px] font-medium text-foreground">Current checkout</span>
      <span className="font-mono text-[12px] text-muted-foreground">main</span>
      <span className="ml-auto text-[11px] text-muted-foreground/50">no target — talk about the project</span>
      <SelectionMark selected={selected} />
    </button>
  )
}

/** The row's one loud fact: a consistent chip vocabulary at the row's right edge. */
function StateChip({ item }: { item: SmartListItem }) {
  if (item.kind === "local") {
    return item.reviewed ? (
      <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10.5px] font-medium text-green-500">
        Reviewed
      </span>
    ) : (
      <span className="rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[10.5px] font-medium text-foreground/70">
        Working tree
      </span>
    )
  }
  switch (item.state) {
    case "needs-you":
      return (
        <span className="rounded-full bg-primary px-2 py-0.5 text-[10.5px] font-semibold text-primary-foreground">
          Needs you
        </span>
      )
    case "yours":
      return (
        <span className="rounded-full border border-primary/50 px-2 py-0.5 text-[10.5px] font-medium text-primary">
          Yours
        </span>
      )
    case "team":
      return (
        <span className="rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[10.5px] font-medium text-foreground/70">
          To review
        </span>
      )
    case "merged":
      return (
        <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          Merged
        </span>
      )
  }
}

function CiDot({ ci }: { ci: "pass" | "fail" | "running" }) {
  if (ci === "fail") {
    return (
      <span className="flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10.5px] font-medium text-destructive">
        CI failing
      </span>
    )
  }
  return (
    <span
      title={ci === "pass" ? "CI passing" : "CI running"}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        ci === "pass" ? "bg-green-500" : "animate-pulse bg-muted-foreground/60",
      )}
    />
  )
}

function AuthorMark({ author }: { author: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex size-4 items-center justify-center rounded-full bg-secondary text-[9px] font-semibold uppercase text-foreground/70">
        {author === "you" ? "Y" : author[0]}
      </span>
      <span>{author}</span>
    </span>
  )
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <Check
      className={cn("size-4 shrink-0 text-primary transition-opacity", selected ? "opacity-100" : "opacity-0")}
      aria-hidden="true"
    />
  )
}

function ItemRow({
  item,
  showRepo,
  selected,
  onSelect,
}: {
  item: SmartListItem
  showRepo: boolean
  selected: boolean
  onSelect: () => void
}) {
  const merged = item.kind === "pr" && item.state === "merged"

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-1 px-3.5 py-2.5 text-left transition-colors",
        selected ? "bg-secondary/60" : "hover:bg-secondary/30",
        merged && !selected && "opacity-50 hover:opacity-80",
      )}
    >
      {item.kind === "local" ? (
        <>
          <span className="flex w-full items-center gap-2">
            <GitBranch
              className={cn("size-3.5 shrink-0", item.dirty ? "text-primary" : "text-muted-foreground")}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate font-mono text-[13px] font-medium text-foreground">{item.branch}</span>
            {item.dirty && (
              <span className="shrink-0 text-[10.5px] font-medium text-primary" title="uncommitted changes">
                ● dirty
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <StateChip item={item} />
              <SelectionMark selected={selected} />
            </span>
          </span>
          {showRepo && <span className="pl-5.5 text-[11.5px] text-muted-foreground/70">{item.repo}</span>}
        </>
      ) : (
        <>
          <span className="flex w-full items-center gap-2">
            {merged ? (
              <GitMerge className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <GitPullRequest
                className={cn("size-3.5 shrink-0", item.state === "needs-you" ? "text-primary" : "text-muted-foreground")}
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{item.title}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <CiDot ci={item.ci} />
              <StateChip item={item} />
              <SelectionMark selected={selected} />
            </span>
          </span>
          <span className="flex w-full items-center gap-2.5 pl-5.5 text-[11.5px] text-muted-foreground/80">
            <span className="shrink-0 font-mono text-muted-foreground">#{item.number}</span>
            <span className="min-w-0 truncate font-mono">{item.branch}</span>
            {showRepo && <span className="shrink-0">{item.repo}</span>}
            <AuthorMark author={item.author} />
            <span className="shrink-0">
              <span className="text-green-500/90">+{item.adds.toLocaleString()}</span>{" "}
              <span className="text-red-400/90">−{item.dels.toLocaleString()}</span>
              <span className="text-muted-foreground/60"> · {item.files} files</span>
            </span>
            {item.checkedOutLocally && (
              <span className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                checked out locally
              </span>
            )}
          </span>
        </>
      )}
    </button>
  )
}
