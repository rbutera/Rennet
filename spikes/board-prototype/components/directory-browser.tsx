"use client"

// Ported from packages/app-ui/src/components/directory-browser.tsx — the real
// component is fed by the daemon's `fs.listDir` RPC; here the same contract is
// satisfied by a `listDir` prop (see lib/fake-fs.ts). Behavior kept: descend by
// click/Enter, ascend via Up or Backspace, type an absolute path, breadcrumb
// navigation, repo badges, unreadable rows, invalid typed path surfaces an
// error and invalidates the selection.

import { ArrowUp, Folder, GitBranch } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import type { FsEntry, ListDirResult } from "@/lib/fake-fs"
import { Input } from "@/components/ui/input"

export function DirectoryBrowser({
  listDir,
  reloadKey,
  onPathChange,
  onPathInvalid,
}: {
  listDir: (path?: string) => Promise<ListDirResult>
  /** Bump this to force a reload (e.g. when the source changes). */
  reloadKey?: string
  onPathChange(path: string): void
  onPathInvalid?(): void
}) {
  const [path, setPath] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [error, setError] = useState<string>()
  const [typed, setTyped] = useState("")
  const [focusIndex, setFocusIndex] = useState(0)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  // Generation guard: an in-flight load from a previous source must not win.
  const generationRef = useRef(0)

  function load(target?: string): void {
    const generation = ++generationRef.current
    listDir(target)
      .then((result) => {
        if (generation !== generationRef.current) return
        setPath(result.path)
        setParent(result.parent)
        setEntries(result.entries)
        setError(undefined)
        setTyped(result.path)
        setFocusIndex(0)
        onPathChange(result.path)
      })
      .catch((reason: unknown) => {
        if (generation !== generationRef.current) return
        setError(reason instanceof Error ? reason.message : "No such directory")
        onPathInvalid?.()
      })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: fires on mount and source change only.
  useEffect(() => {
    load(undefined)
  }, [reloadKey])

  const loaded = path !== null
  const rows = error ? [] : entries
  const showEmpty = loaded && !error && rows.length === 0

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number, entry: FsEntry): void {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault()
        const next = Math.min(index + 1, rows.length - 1)
        setFocusIndex(next)
        rowRefs.current[next]?.focus()
        break
      }
      case "ArrowUp": {
        event.preventDefault()
        const prev = Math.max(index - 1, 0)
        setFocusIndex(prev)
        rowRefs.current[prev]?.focus()
        break
      }
      case "Enter":
        if (!entry.unreadable) load(entry.path)
        break
      case "Backspace":
        if (parent !== null) load(parent)
        break
      default:
        break
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => parent !== null && load(parent)}
          disabled={parent === null}
          aria-label="Up one level"
          title="Up one level"
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" aria-hidden="true" />
        </button>
        {loaded ? <PathBreadcrumb path={path} onNavigate={load} /> : null}
      </div>

      <Input
        type="text"
        aria-label="Directory path"
        value={typed}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          load(typed)
        }}
      />

      {error ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px]" role="alert">
          {error}
        </p>
      ) : null}

      <div
        role="listbox"
        aria-label="Directories"
        className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1"
      >
        {showEmpty ? (
          <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">No folders here</div>
        ) : (
          rows.map((entry, index) => (
            <div
              key={entry.path}
              role="option"
              aria-selected={index === focusIndex}
              aria-disabled={entry.unreadable}
              tabIndex={index === focusIndex ? 0 : -1}
              ref={(node) => {
                rowRefs.current[index] = node
              }}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                entry.unreadable
                  ? "cursor-not-allowed text-muted-foreground/50"
                  : "cursor-pointer text-foreground/90 hover:bg-secondary/60",
              )}
              onClick={() => {
                if (entry.unreadable) return
                setFocusIndex(index)
                load(entry.path)
              }}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(event) => handleRowKeyDown(event, index, entry)}
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{entry.name}</span>
              {entry.isRepo ? (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  <GitBranch className="size-3" aria-hidden="true" />
                  repo
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** The current path split into clickable segments — root first, current dir last (disabled). */
function PathBreadcrumb({ path, onNavigate }: { path: string; onNavigate(path: string): void }) {
  const segments = segmentsOf(path)
  return (
    <nav
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[12px] text-muted-foreground"
      aria-label="Current path"
    >
      {segments.map((segment, index) => {
        const current = index === segments.length - 1
        return (
          <span className="flex items-center gap-0.5" key={segment.path}>
            {index > 0 ? (
              <span className="text-muted-foreground/50" aria-hidden="true">
                /
              </span>
            ) : null}
            <button
              type="button"
              className={cn(
                "truncate rounded px-1 py-0.5",
                current ? "font-medium text-foreground" : "hover:bg-secondary hover:text-foreground",
              )}
              aria-current={current ? "page" : undefined}
              disabled={current}
              onClick={current ? undefined : () => onNavigate(segment.path)}
            >
              {segment.label}
            </button>
          </span>
        )
      })}
    </nav>
  )
}

function segmentsOf(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean)
  const segments = [{ label: "/", path: "/" }]
  let acc = ""
  for (const part of parts) {
    acc += `/${part}`
    segments.push({ label: part, path: acc })
  }
  return segments
}
