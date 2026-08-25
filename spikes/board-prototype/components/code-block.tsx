"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { Check, Copy, FileCode, MessageSquare, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { getHighlightedLines } from "@/lib/code-highlighter"
import { useShikiTheme } from "@/lib/store"
import { useCodeComments } from "@/components/code-comments"
import type { ThemedToken } from "shiki"

export interface CodeBlockProps {
  /** The source code to render. */
  code: string
  /** File path shown in the header — also used to infer the language when `lang` is omitted. */
  path: string
  /** Shiki bundled-language id. Inferred from `path`'s extension when omitted. */
  lang?: string
  /** Line number of the first line in `code`, for headers/gutters that reference a slice of a larger file. */
  startLine?: number
  /** Absolute line numbers (matching `startLine` + offset) to call out as the lines under discussion. */
  highlightLines?: number[]
  /** Existing local comments keyed by absolute line number, so a reopened editor is pre-filled and commented lines stay marked. */
  comments?: Record<number, string>
  /**
   * Called when a line's comment is saved or removed (`text === null`).
   * Omit to render a plain, non-interactive gutter with no "+" affordance.
   */
  onCommentChange?: (line: number, text: string | null) => void
  className?: string
}

const EXTENSION_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
}

function inferLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_LANG[ext] ?? "text"
}

export function tokenStyle(token: ThemedToken): CSSProperties {
  return {
    color: token.color,
    fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
    fontWeight: token.fontStyle && token.fontStyle & 2 ? 600 : undefined,
  }
}

/**
 * The line-comment editor panel — one component so every code surface
 * (chat blocks, board excerpts, the Diff view) carries identical Save /
 * Request Changes / Delete behavior. Callers own the container styling.
 */
export function LineCommentEditor({
  lineLabel,
  initialText,
  hasComment,
  onCancel,
  onSave,
  onRequestChanges,
}: {
  /** Shown top-right, e.g. "L42". */
  lineLabel: string
  initialText: string
  hasComment: boolean
  onCancel: () => void
  /** null clears the comment (Delete or emptied text). */
  onSave: (text: string | null) => void
  /** Saves the comment AND stages a request-change ask (caller wires the store). */
  onRequestChanges: (text: string) => void
}) {
  const [draft, setDraft] = useState(initialText)
  const draftRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    draftRef.current?.focus()
  }, [])

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <MessageSquare className="size-3 text-muted-foreground" aria-hidden="true" />
          Local comment
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">Comment on line {lineLabel}</span>
      </div>
      <textarea
        ref={draftRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder="Leave a comment on this line…"
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 font-sans text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
      />
      <div className="mt-2 flex items-center justify-between">
        {hasComment ? (
          <button
            type="button"
            onClick={() => onSave(null)}
            className="rounded-md px-2 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const trimmed = draft.trim()
              if (trimmed.length > 0) onRequestChanges(trimmed)
            }}
            className="rounded-md border border-primary/50 px-2.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            Request Changes
          </button>
          <button
            type="button"
            onClick={() => {
              const trimmed = draft.trim()
              onSave(trimmed.length > 0 ? trimmed : null)
            }}
            className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Save
          </button>
        </div>
      </div>
    </>
  )
}

/**
 * A file-scoped code snippet with syntax highlighting (via Shiki), a header
 * naming the file and the line range shown, per-line numbers anchored to
 * that range, optional highlighted lines, and a copy button.
 *
 * This is the shared building block for any code shown in the product —
 * chat tool output, diff review, file viewers — so behavior here (loading
 * state, line numbering, highlight styling, copy affordance) should stay
 * consistent across all of them rather than being reimplemented per call site.
 */
export function CodeBlock({
  code,
  path,
  lang,
  startLine = 1,
  highlightLines,
  comments: commentsProp,
  onCommentChange: onCommentChangeProp,
  className,
}: CodeBlockProps) {
  // Explicit props win; otherwise the shared store makes every code block
  // commentable with the same hover-+ affordance as the chat blocks.
  const store = useCodeComments()
  const comments = commentsProp ?? store?.comments[path]
  const onCommentChange =
    onCommentChangeProp ?? (store ? (line: number, text: string | null) => store.setComment(path, line, text) : undefined)
  const resolvedLang = lang ?? inferLang(path)
  const [lines, setLines] = useState<ThemedToken[][] | null>(null)
  const [copied, setCopied] = useState(false)
  const [openLine, setOpenLine] = useState<number | null>(null)
  const shikiTheme = useShikiTheme()

  const lineCount = useMemo(() => code.split("\n").length, [code])
  const highlightSet = useMemo(() => new Set(highlightLines ?? []), [highlightLines])
  const endLine = startLine + lineCount - 1
  const gutterChars = String(endLine).length + 1

  function openEditor(line: number) {
    setOpenLine(line)
  }

  function closeEditor() {
    setOpenLine(null)
  }

  useEffect(() => {
    let cancelled = false
    getHighlightedLines(code, resolvedLang, shikiTheme).then((tokens) => {
      if (!cancelled) setLines(tokens)
    })
    return () => {
      cancelled = true
    }
  }, [code, resolvedLang, shikiTheme])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can fail (permissions, insecure context) — copy button simply no-ops.
    }
  }

  return (
    <div
      className={cn(
        "w-full max-w-[640px] overflow-hidden rounded-lg border border-border bg-card [container-type:inline-size]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary/50 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileCode className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-mono text-[12px] text-foreground/80">{path}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {lineCount > 1 ? `L${startLine}\u2013${endLine}` : `L${startLine}`}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-max py-1.5 font-mono text-[12.5px] leading-[1.7]">
          {lines
            ? lines.map((lineTokens, i) => {
                const lineNumber = startLine + i
                const isHighlighted = highlightSet.has(lineNumber)
                const hasComment = comments?.[lineNumber] != null
                const isOpen = openLine === lineNumber
                return (
                  <div key={i}>
                    <div
                      className={cn(
                        "group flex min-h-[1.7em]",
                        isHighlighted && "bg-green/15",
                        (hasComment || isOpen) && "bg-primary/10",
                      )}
                    >
                      <span
                        className={cn(
                          "sticky left-0 flex shrink-0 select-none items-center justify-end gap-1 border-r px-2.5 text-muted-foreground/50",
                          isHighlighted || hasComment || isOpen
                            ? "border-primary/50 bg-primary/10"
                            : "border-transparent bg-card",
                        )}
                        style={{ minWidth: `${gutterChars}ch` }}
                      >
                        {onCommentChange && (
                          <button
                            type="button"
                            onClick={() => (isOpen ? closeEditor() : openEditor(lineNumber))}
                            aria-label={
                              hasComment ? `Edit comment on line ${lineNumber}` : `Comment on line ${lineNumber}`
                            }
                            title={hasComment ? `Edit comment on line ${lineNumber}` : `Comment on line ${lineNumber}`}
                            className={cn(
                              "size-4 shrink-0 items-center justify-center rounded transition-colors",
                              hasComment || isOpen
                                ? "flex bg-primary text-primary-foreground hover:bg-primary/90"
                                : "hidden bg-primary text-primary-foreground hover:bg-primary/90 group-hover:flex",
                            )}
                          >
                            {hasComment ? (
                              <MessageSquare className="size-2.5" aria-hidden="true" />
                            ) : (
                              <Plus className="size-3" aria-hidden="true" />
                            )}
                          </button>
                        )}
                        <span
                          className={cn(
                            "tabular-nums",
                            onCommentChange && !hasComment && !isOpen && "group-hover:hidden",
                          )}
                        >
                          {lineNumber}
                        </span>
                      </span>
                      <span className="whitespace-pre px-3 text-foreground/90">
                        {lineTokens.length === 0
                          ? "\u00a0"
                          : lineTokens.map((token, ti) => (
                              <span key={ti} style={tokenStyle(token)}>
                                {token.content}
                              </span>
                            ))}
                      </span>
                    </div>
                    {isOpen && (
                      <div className="sticky left-0 w-[100cqw] border-y border-border bg-secondary/40 px-3 py-2.5 font-sans">
                        <LineCommentEditor
                          lineLabel={`L${lineNumber}`}
                          initialText={comments?.[lineNumber] ?? ""}
                          hasComment={hasComment}
                          onCancel={closeEditor}
                          onSave={(text) => {
                            onCommentChange?.(lineNumber, text)
                            closeEditor()
                          }}
                          onRequestChanges={(text) => {
                            // The comment saves locally AND stages a line-comment
                            // ask: a code line is a real diff position, so this
                            // ask posts as a GitHub line comment (R36).
                            onCommentChange?.(lineNumber, text)
                            store?.stageAsk(text, "request-change", `${path.split("/").pop()}:${lineNumber}`, {
                              path,
                              line: lineNumber,
                            })
                            closeEditor()
                          }}
                        />
                      </div>
                    )}
                  </div>
                )
              })
            : Array.from({ length: lineCount }).map((_, i) => (
                <div key={i} className="flex min-h-[1.7em] animate-pulse items-center">
                  <span className="shrink-0" style={{ minWidth: `${gutterChars}ch` }} />
                  <span className="mx-3 h-3 w-[65%] rounded bg-muted" />
                </div>
              ))}
        </div>
      </div>
    </div>
  )
}
