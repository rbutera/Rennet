"use client"

import * as React from "react"
import type { CSSProperties } from "react"
import { useSearchParams } from "next/navigation"
import {
  Check,
  ChevronDown,
  Copy,
  File,
  FileCode,
  Folder,
  MessageSquare,
  Plus,
  Search,
  UnfoldVertical,
} from "lucide-react"
import type { ThemedToken } from "shiki"
import { cn } from "@/lib/utils"
import { Collapse } from "@/components/collapse"
import { getHighlightedLines } from "@/lib/code-highlighter"
import { useShikiTheme } from "@/lib/store"
import { LineCommentEditor, tokenStyle } from "@/components/code-block"
import { useCodeComments } from "@/components/code-comments"
import { ProseSelectionLayer } from "@/components/selection-toolbar"
import { type DiffFile, type DiffHunk, diffFiles, fileStats, hunkHeader } from "@/lib/diff-data"

const EXTENSION_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  json: "json",
  css: "css",
  md: "markdown",
}

function inferLang(path: string): string {
  return EXTENSION_LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text"
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  modified: "",
  renamed: "renamed",
}

/** GitHub's five-square add/delete proportion chip. */
function StatSquares({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const greens = total === 0 ? 0 : Math.round((additions / total) * 5)
  return (
    <span className="flex items-center gap-px" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "size-2 rounded-[2px]",
            i < greens ? "bg-green-600" : total > 0 && "bg-red-600/80",
            total === 0 && "bg-muted",
          )}
        />
      ))}
    </span>
  )
}

/**
 * The Diff surface — the raw patchset in GitHub's Files-changed shape:
 * file tree + filter on the left, per-file diff cards with dual line-number
 * gutters, hunk headers, viewed tracking, and the same line-comment /
 * Request Changes / selection Explain machinery as every other code surface.
 */
export function DiffView({ files = diffFiles }: { files?: DiffFile[] }) {
  const [filter, setFilter] = React.useState("")
  const [viewed, setViewed] = React.useState<Record<string, boolean>>({})
  const searchParams = useSearchParams()

  // ?file=<path> deep-links to one file's card (the code-block filename links
  // here with it). Read once on mount; the param stays shareable.
  const fileParam = searchParams.get("file")
  React.useEffect(() => {
    if (!fileParam) return
    document.getElementById(`diff-${fileParam}`)?.scrollIntoView({ block: "start" })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only jump
  }, [])

  const q = filter.trim().toLowerCase()
  const shown = files.filter((f) => !q || f.path.toLowerCase().includes(q))
  const totals = files.reduce(
    (acc, f) => {
      const s = fileStats(f)
      return { additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions }
    },
    { additions: 0, deletions: 0 },
  )
  const viewedCount = files.filter((f) => viewed[f.path]).length

  function jumpTo(path: string) {
    document.getElementById(`diff-${path}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Scroll frame 1: the diff cards. The selection layer sits INSIDE the
          frame (its plain container div would otherwise break the flex height
          chain — the lens boards wrap the same way). */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ProseSelectionLayer>
          <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4 px-6 py-4">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">
                {files.length} files changed
              </span>
              <span className="text-green-600">+{totals.additions}</span>
              <span className="text-red-600">−{totals.deletions}</span>
              <StatSquares additions={totals.additions} deletions={totals.deletions} />
              <span className="ml-auto tabular-nums">
                {viewedCount} / {files.length} viewed
              </span>
            </div>

            {shown.map((file) => (
              <DiffFileCard
                key={file.path}
                file={file}
                viewed={!!viewed[file.path]}
                onViewedChange={(value) =>
                  setViewed((prev) => ({ ...prev, [file.path]: value }))
                }
              />
            ))}
            {shown.length === 0 && (
              <span className="py-8 text-center text-[13px] text-muted-foreground">
                No files match “{filter.trim()}”.
              </span>
            )}
          </div>
        </ProseSelectionLayer>
      </div>

      {/* Scroll frame 2: the file list, on the right. */}
      <aside className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-3">
        <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 focus-within:border-ring">
          <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files…"
            aria-label="Filter changed files"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <FileTree files={shown} viewed={viewed} onJump={jumpTo} />
      </aside>
    </div>
  )
}

/** Minimal directory tree — folders as headers, files indented beneath. */
function FileTree({
  files,
  viewed,
  onJump,
}: {
  files: DiffFile[]
  viewed: Record<string, boolean>
  onJump: (path: string) => void
}) {
  const byDir = new Map<string, DiffFile[]>()
  for (const file of files) {
    const dir = file.path.split("/").slice(0, -1).join("/")
    byDir.set(dir, [...(byDir.get(dir) ?? []), file])
  }

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Changed files">
      {[...byDir.entries()].map(([dir, dirFiles]) => (
        <div key={dir} className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 px-1 pt-1.5 text-[11px] text-muted-foreground/70">
            <Folder className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{dir}</span>
          </span>
          {dirFiles.map((file) => {
            const name = file.path.split("/").pop()
            const stats = fileStats(file)
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => onJump(file.path)}
                className="flex items-center gap-1.5 rounded-md py-1 pl-5 pr-1 text-left text-[12px] text-foreground/85 transition-colors hover:bg-secondary"
              >
                <File className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className={cn("truncate", viewed[file.path] && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                  {name}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                  <span className="text-green-600">+{stats.additions}</span>
                  <span className="text-red-600">−{stats.deletions}</span>
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function DiffFileCard({
  file,
  viewed,
  onViewedChange,
}: {
  file: DiffFile
  viewed: boolean
  onViewedChange: (viewed: boolean) => void
}) {
  // Marking a file viewed collapses it, exactly like GitHub.
  const [collapsed, setCollapsed] = React.useState(false)
  const open = !collapsed && !viewed
  const stats = fileStats(file)
  const [copied, setCopied] = React.useState(false)

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(file.path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can fail (permissions) — the button no-ops.
    }
  }

  return (
    <section
      id={`diff-${file.path}`}
      className="scroll-mt-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border bg-secondary/50 px-2 py-1.5",
          !open && "border-b-0",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value || viewed)}
          aria-expanded={open}
          aria-label={open ? "Collapse file" : "Expand file"}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} aria-hidden="true" />
        </button>
        <FileCode className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className={cn("truncate font-mono text-[12px] text-foreground/85", viewed && "text-muted-foreground")}>
          {file.status === "renamed" && file.oldPath ? (
            <>
              <span className="text-muted-foreground">{file.oldPath}</span>
              <span className="mx-1 text-muted-foreground/60">→</span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {STATUS_LABEL[file.status] && (
          <span
            className={cn(
              "shrink-0 rounded border px-1 py-px text-[10px] uppercase tracking-wide",
              file.status === "added"
                ? "border-green-600/40 text-green-600"
                : "border-border text-muted-foreground",
            )}
          >
            {STATUS_LABEL[file.status]}
          </span>
        )}
        <button
          type="button"
          onClick={copyPath}
          aria-label="Copy file path"
          title="Copy file path"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] tabular-nums">
          <span className="text-green-600">+{stats.additions}</span>
          <span className="text-red-600">−{stats.deletions}</span>
          <StatSquares additions={stats.additions} deletions={stats.deletions} />
        </span>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => onViewedChange(event.target.checked)}
            className="size-3 accent-primary"
          />
          Viewed
        </label>
      </div>

      <Collapse open={open}>
        <div className="overflow-x-auto">
          <div className="min-w-max font-mono text-[12.5px] leading-[1.7]">
            {file.hunks.map((hunk, i) => (
              <DiffHunkView key={i} hunk={hunk} path={file.path} />
            ))}
          </div>
        </div>
      </Collapse>
    </section>
  )
}

interface NumberedLine {
  type: "context" | "add" | "del"
  text: string
  oldLine: number | null
  newLine: number | null
}

function numberLines(hunk: DiffHunk): NumberedLine[] {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  return hunk.lines.map((line) => ({
    ...line,
    oldLine: line.type === "add" ? null : oldLine++,
    newLine: line.type === "del" ? null : newLine++,
  }))
}

function DiffHunkView({ hunk, path }: { hunk: DiffHunk; path: string }) {
  const store = useCodeComments()
  const comments = store?.comments[path]
  const [openLine, setOpenLine] = React.useState<number | null>(null)
  const [tokens, setTokens] = React.useState<ThemedToken[][] | null>(null)
  const lines = React.useMemo(() => numberLines(hunk), [hunk])
  // Same contract as CodeBlock: staged request-change asks read danger red,
  // plain comments read evidence green.
  const askLines = React.useMemo(
    () =>
      new Set(
        (store?.asks ?? [])
          .filter((ask) => ask.intent === "request-change" && ask.codeAnchor?.path === path)
          .map((ask) => ask.codeAnchor?.line),
      ),
    [store?.asks, path],
  )
  const shikiTheme = useShikiTheme()

  // Highlight the hunk as one slab; shiki tokenizes line-by-line, so mixed
  // old/new lines come back aligned with the input order.
  React.useEffect(() => {
    let cancelled = false
    getHighlightedLines(hunk.lines.map((l) => l.text).join("\n"), inferLang(path), shikiTheme).then((result) => {
      if (!cancelled) setTokens(result)
    })
    return () => {
      cancelled = true
    }
  }, [hunk, path, shikiTheme])

  return (
    <div className="[container-type:inline-size]">
      <div className="flex items-center gap-2 bg-secondary/40 px-2 py-1 text-[11px] text-muted-foreground">
        <UnfoldVertical className="size-3 shrink-0" aria-hidden="true" />
        <span>{hunkHeader(hunk)}</span>
      </div>
      {lines.map((line, i) => {
        const commentLine = line.newLine
        const hasComment = commentLine !== null && comments?.[commentLine] != null
        const hasAsk = commentLine !== null && askLines.has(commentLine)
        const isOpen = commentLine !== null && openLine === commentLine
        return (
          <React.Fragment key={i}>
            <div
              className={cn(
                "group flex min-h-[1.7em]",
                line.type === "add" && "bg-green-600/10",
                line.type === "del" && "bg-red-600/10",
                hasAsk ? "bg-destructive/25" : (hasComment || isOpen) && "bg-green/15",
              )}
            >
              <span
                className={cn(
                  "w-[5ch] shrink-0 select-none border-r border-transparent py-0 pr-2 text-right text-muted-foreground/50",
                  line.type === "add" && "bg-green-600/10",
                  line.type === "del" && "bg-red-600/15",
                )}
              >
                {line.oldLine ?? ""}
              </span>
              <span
                className={cn(
                  "relative flex w-[6ch] shrink-0 select-none items-center justify-end gap-1 pr-2 text-right text-muted-foreground/50",
                  line.type === "add" && "bg-green-600/15",
                  line.type === "del" && "bg-red-600/10",
                )}
              >
                {store && commentLine !== null && (
                  <button
                    type="button"
                    onClick={() => setOpenLine(isOpen ? null : commentLine)}
                    aria-label={
                      hasComment
                        ? `Edit comment on line ${commentLine}`
                        : `Comment on line ${commentLine}`
                    }
                    className={cn(
                      "size-4 shrink-0 items-center justify-center rounded transition-colors",
                      hasAsk
                        ? "bg-destructive text-white hover:bg-destructive/90"
                        : "bg-primary text-primary-foreground hover:bg-primary/90",
                      hasComment || isOpen ? "flex" : "hidden group-hover:flex",
                    )}
                  >
                    {hasComment ? (
                      <MessageSquare className="size-2.5" aria-hidden="true" />
                    ) : (
                      <Plus className="size-3" aria-hidden="true" />
                    )}
                  </button>
                )}
                <span className={cn("tabular-nums", store && commentLine !== null && !hasComment && !isOpen && "group-hover:hidden")}>
                  {line.newLine ?? ""}
                </span>
              </span>
              <span
                className={cn(
                  "w-[2ch] shrink-0 select-none text-center",
                  line.type === "add" && "text-green-600",
                  line.type === "del" && "text-red-600",
                )}
              >
                {line.type === "add" ? "+" : line.type === "del" ? "−" : ""}
              </span>
              <span className="whitespace-pre pr-3 text-foreground/90">
                {tokens?.[i] && tokens[i].length > 0
                  ? tokens[i].map((token, ti) => (
                      <span key={ti} style={tokenStyle(token) as CSSProperties}>
                        {token.content}
                      </span>
                    ))
                  : line.text || " "}
              </span>
            </div>
            {isOpen && commentLine !== null && (
              <div className="sticky left-0 w-[100cqw] border-y border-border bg-secondary/40 px-3 py-2.5 font-sans">
                <LineCommentEditor
                  lineLabel={`L${commentLine}`}
                  initialText={comments?.[commentLine] ?? ""}
                  hasComment={!!hasComment}
                  onCancel={() => setOpenLine(null)}
                  onSave={(text) => {
                    store?.setComment(path, commentLine, text)
                    setOpenLine(null)
                  }}
                  onRequestChanges={(text) => {
                    // Same contract as CodeBlock: local comment + staged
                    // line-comment ask with a real diff position (R36).
                    store?.setComment(path, commentLine, text)
                    store?.stageAsk(text, "request-change", `${path.split("/").pop()}:${commentLine}`, {
                      path,
                      line: commentLine,
                    })
                    setOpenLine(null)
                  }}
                />
              </div>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
