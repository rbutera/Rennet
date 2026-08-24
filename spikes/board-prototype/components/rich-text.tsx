"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import type { CodeAnchor } from "@/lib/lens-data"
import { CodeBlock } from "@/components/code-block"

/** Matches a repo file citation like `packages/x/y.ts:244` or `y.ts:112-113`. */
const FILE_REF = /^[\w@./-]+\.[a-z]+:\d+(?:-\d+)?$/
/** One tokenizer pass: backtick spans, or bare file:line(-line) citations. */
const TOKEN = /`[^`]+`|[\w@./-]+\.[a-z]+:\d+(?:-\d+)?/g

type FetchedSlice = { code: string; startLine: number }

export function parseRef(ref: string): CodeAnchor {
  const colon = ref.lastIndexOf(":")
  const line = Number.parseInt(ref.slice(colon + 1), 10)
  return { path: ref.slice(0, colon), line }
}

/** Fetches and renders the real lines around a cited location. */
export function SourcePanel({ anchor }: { anchor: CodeAnchor }) {
  const [slice, setSlice] = React.useState<FetchedSlice | "error" | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetch(`/api/source?path=${encodeURIComponent(anchor.path)}&line=${anchor.line}`)
      .then(async (response) => {
        const body = (await response.json()) as FetchedSlice
        if (!cancelled) setSlice(response.ok ? body : "error")
      })
      .catch(() => {
        if (!cancelled) setSlice("error")
      })
    return () => {
      cancelled = true
    }
  }, [anchor.path, anchor.line])

  if (slice === null)
    return (
      <p className="text-[12px] text-muted-foreground">
        Loading {anchor.path}:{anchor.line}…
      </p>
    )
  if (slice === "error")
    return (
      <p className="text-[12px] text-muted-foreground">{anchor.path} is not readable from this checkout.</p>
    )
  return (
    <CodeBlock code={slice.code} path={anchor.path} startLine={slice.startLine} highlightLines={[anchor.line]} />
  )
}

/**
 * Inline formatting only: `backticks` render monospace; file:line citations
 * render as mono text (not clickable — use RichText where reveal is wanted).
 */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/)
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="rounded bg-secondary/60 px-1 py-px font-mono text-[0.86em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  )
}

/**
 * Block prose with the board's reading affordances: paragraphs split on blank
 * lines, `backticks` in monospace, and file:line citations as chips that
 * reveal the real code below the paragraph when clicked.
 */
export function RichText({
  text,
  className,
  paragraphClassName,
}: {
  text: string
  className?: string
  paragraphClassName?: string
}) {
  const [activeRef, setActiveRef] = React.useState<string | null>(null)
  const paragraphs = text.split(/\n\n+/)

  function renderParagraph(paragraph: string, paragraphIndex: number) {
    const nodes: React.ReactNode[] = []
    let last = 0
    let match: RegExpExecArray | null
    TOKEN.lastIndex = 0
    while ((match = TOKEN.exec(paragraph)) !== null) {
      if (match.index > last) nodes.push(paragraph.slice(last, match.index))
      const token = match[0]
      const inner = token.startsWith("`") ? token.slice(1, -1) : token
      const isRef = FILE_REF.test(inner)
      if (isRef) {
        const refKey = `${paragraphIndex}:${inner}`
        nodes.push(
          <button
            key={refKey + match.index}
            type="button"
            onClick={() => setActiveRef((current) => (current === refKey ? null : refKey))}
            title={activeRef === refKey ? "Hide code" : "Show code"}
            className={cn(
              "rounded bg-secondary/60 px-1 py-px font-mono text-[0.86em] underline decoration-dotted underline-offset-2 transition-colors",
              activeRef === refKey ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {inner}
          </button>,
        )
      } else if (token.startsWith("`")) {
        nodes.push(
          <code key={match.index} className="rounded bg-secondary/60 px-1 py-px font-mono text-[0.86em]">
            {inner}
          </code>,
        )
      } else {
        nodes.push(token)
      }
      last = match.index + token.length
    }
    if (last < paragraph.length) nodes.push(paragraph.slice(last))

    const activeInParagraph =
      activeRef && activeRef.startsWith(`${paragraphIndex}:`) ? activeRef.slice(activeRef.indexOf(":") + 1) : null

    return (
      <React.Fragment key={paragraphIndex}>
        <p className={paragraphClassName}>{nodes}</p>
        {activeInParagraph && <SourcePanel anchor={parseRef(activeInParagraph)} />}
      </React.Fragment>
    )
  }

  return <div className={cn("flex flex-col gap-2", className)}>{paragraphs.map(renderParagraph)}</div>
}
