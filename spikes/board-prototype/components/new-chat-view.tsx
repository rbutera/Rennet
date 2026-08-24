"use client"

import * as React from "react"
import {
  ArrowLeft,
  ArrowUp,
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
}: {
  hosts: HostItem[]
  projectId: string
  onProjectChange: (projectId: string) => void
  onClose: () => void
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

          <div className="mt-3 flex flex-col gap-1.5">
            <CheckoutRow selected={target.kind === "checkout"} onSelect={() => setTarget({ kind: "checkout" })} />
            {visible.map((item) => (
              <ItemRow
                key={itemKey(item)}
                item={item}
                selected={selectedKey === itemKey(item)}
                onSelect={() => setTarget({ kind: "item", item })}
              />
            ))}
            {visible.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-muted-foreground/60">
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
        "flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
        selected ? "border-ring bg-secondary/60" : "border-border hover:bg-secondary/40",
      )}
    >
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-[13px] font-medium text-foreground">Current checkout</span>
      <span className="font-mono text-[12px] text-muted-foreground">main</span>
      <span className="ml-auto text-[11px] text-muted-foreground/60">no target — talk about the project</span>
    </button>
  )
}

const CI_CHIP: Record<string, { label: string; className: string }> = {
  pass: { label: "CI ✓", className: "border-green-700/40 text-green-600 dark:text-green-500" },
  fail: { label: "CI ✕", className: "border-destructive/40 text-destructive" },
  running: { label: "CI …", className: "border-border text-muted-foreground" },
}

function ItemRow({
  item,
  selected,
  onSelect,
}: {
  item: SmartListItem
  selected: boolean
  onSelect: () => void
}) {
  if (item.kind === "local") {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "flex flex-col gap-0.5 rounded-md border border-l-2 px-3 py-2 text-left transition-colors",
          selected ? "border-ring bg-secondary/60 border-l-ring" : "border-border border-l-primary/50 bg-secondary/25 hover:bg-secondary/40",
        )}
      >
        <span className="flex items-center gap-2">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-mono text-[13px] font-medium text-foreground">{item.branch}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {item.dirty && (
              <span className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary">dirty</span>
            )}
            <span className="text-[11px] text-muted-foreground">{item.reviewed ? "reviewed" : "local"}</span>
          </span>
        </span>
        <span className="pl-5.5 text-[11.5px] text-muted-foreground">
          {item.repo} · working tree
        </span>
      </button>
    )
  }

  const merged = item.state === "merged"
  const ci = CI_CHIP[item.ci]
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
        item.state === "yours" && "border-l-2 border-l-primary/50",
        item.state === "needs-you" && !selected && "border-primary/40 bg-primary/5",
        selected ? "border-ring bg-secondary/60" : "hover:bg-secondary/40",
        !selected && item.state !== "needs-you" && "border-border",
        merged && "opacity-55",
      )}
    >
      <span className="flex items-center gap-2">
        {merged ? (
          <GitMerge className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">#{item.number}</span>
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{item.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", ci.className)}>{ci.label}</span>
          {item.state === "needs-you" && (
            <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
              needs you
            </span>
          )}
          {item.state === "yours" && <span className="text-[11px] text-muted-foreground">your PR</span>}
          {item.state === "team" && <span className="text-[11px] text-muted-foreground">review</span>}
          {merged && <span className="text-[11px] text-muted-foreground">merged</span>}
        </span>
      </span>
      <span className="flex items-center gap-2 pl-5.5 text-[11.5px] text-muted-foreground">
        <span className="font-mono">{item.branch}</span>
        <span>
          {item.repo} · {item.author} · +{item.adds} −{item.dels} · {item.files}f
        </span>
        {item.checkedOutLocally && (
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px]">checked out locally</span>
        )}
      </span>
    </button>
  )
}
