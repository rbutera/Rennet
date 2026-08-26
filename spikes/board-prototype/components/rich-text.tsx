"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import type { CodeAnchor } from "@/lib/lens-data"
import { CodeBlock } from "@/components/code-block"
import { type QuoteComment, useCodeComments } from "@/components/code-comments"
import { nextCannedReply } from "@/lib/quote-thread-demo"

/** Matches a repo file citation like `packages/x/y.ts:244` or `y.ts:112-113`. */
const FILE_REF = /^[\w@./-]+\.[a-z]+:\d+(?:-\d+)?$/
/** One tokenizer pass: backtick spans, or bare file:line(-line) citations. */
const TOKEN = /`[^`]+`|[\w@./-]+\.[a-z]+:\d+(?:-\d+)?/g
/** Normative grammar (SHALL, WHEN/THEN, EARS keywords) for spec prose. */
const SPEC_KEYWORD = /\b(WHEN|THEN|AND|IF|WHILE|WHERE|SHALL NOT|SHALL|MUST NOT|MUST)\b/g

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
 * Hydrated span citation: fetches the exact cited lines and renders them as a
 * code block card — the code-ref element's renderer. Numbering comes from the
 * file itself, so it cannot drift from the citation.
 */
export function HydratedCode({
  path,
  startLine,
  endLine,
  highlightLines,
}: {
  path: string
  startLine: number
  endLine: number
  highlightLines?: number[]
}) {
  const [slice, setSlice] = React.useState<FetchedSlice | "error" | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetch(`/api/source?path=${encodeURIComponent(path)}&start=${startLine}&end=${endLine}`)
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
  }, [path, startLine, endLine])

  if (slice === null)
    return (
      <p className="text-[12px] text-muted-foreground">
        Loading {path}:{startLine}…
      </p>
    )
  if (slice === "error")
    return <p className="text-[12px] text-muted-foreground">{path} is not readable from this checkout.</p>
  return <CodeBlock code={slice.code} path={path} startLine={slice.startLine} highlightLines={highlightLines} />
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
          <code key={index} className="font-mono text-[0.9em] text-foreground">
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
 * A durable highlight over commented prose. Clicking it opens the thread —
 * the opening comment, every reply, and a follow-up input — in a tooltip
 * anchored above the highlighted text.
 */
function QuoteHighlight({ thread, children }: { thread: QuoteComment; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const wrapperRef = React.useRef<HTMLSpanElement>(null)
  const store = useCodeComments()

  React.useEffect(() => {
    if (store?.focusedThreadId === thread.id) {
      setOpen(true)
      store.focusThread(null)
    }
  }, [store, thread.id])

  React.useEffect(() => {
    if (!open) return
    function handleMouseDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", handleMouseDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleMouseDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open])

  function handleFollowUp() {
    const text = draft.trim()
    if (text.length === 0) return
    store?.addQuoteReply(thread.id, "user", text)
    setDraft("")
    const reply = nextCannedReply()
    window.setTimeout(() => store?.addQuoteReply(thread.id, "orchestrator", reply), 900)
  }

  return (
    <span ref={wrapperRef} className="relative">
      {/* role=button span, not <button>: the highlighted prose can itself
          contain citation-chip buttons, and nested buttons are invalid HTML
          (hydration errors, flaky clicks). */}
      <span
        role="button"
        tabIndex={0}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            setOpen((value) => !value)
          }
        }}
        title="View thread"
        className={cn(
          "cursor-pointer rounded-sm bg-green/20 px-0.5 shadow-[inset_0_-1.5px_0_0] shadow-green/70 transition-colors [box-decoration-break:clone]",
          open ? "bg-green/35" : "hover:bg-green/30",
        )}
      >
        {children}
      </span>
      {open && (
        <span className="absolute bottom-full left-0 z-50 mb-1.5 block w-[360px] cursor-auto rounded-md border border-border bg-popover p-2.5 font-sans not-italic shadow-lg">
          <span className="mb-1.5 flex flex-col gap-1.5">
            {thread.messages.map((message, index) =>
              message.author === "user" ? (
                <span key={index} className="flex justify-end">
                  <span className="max-w-[280px] rounded-lg bg-secondary px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground/95">
                    {message.text}
                  </span>
                </span>
              ) : (
                <span key={index} className="block text-[12.5px] leading-relaxed text-foreground/85">
                  {message.text}
                </span>
              ),
            )}
          </span>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                handleFollowUp()
              }
            }}
            placeholder="Ask a follow-up…"
            rows={1}
            className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
          />
        </span>
      )}
    </span>
  )
}

/**
 * Block prose with the board's reading affordances: paragraphs split on blank
 * lines, `backticks` in monospace, file:line citations as chips that reveal
 * the real code below the paragraph, and durable highlights over prose that
 * carries a comment thread.
 */
export function RichText({
  text,
  className,
  paragraphClassName,
  keywords = false,
}: {
  text: string
  className?: string
  paragraphClassName?: string
  /** Bold the normative spec grammar (SHALL, WHEN/THEN, EARS keywords). */
  keywords?: boolean
}) {
  const [activeRef, setActiveRef] = React.useState<string | null>(null)
  const store = useCodeComments()
  const paragraphs = text.split(/\n\n+/)

  function keywordNodes(chunk: string, keyBase: string): React.ReactNode[] {
    if (!keywords) return [chunk]
    const parts = chunk.split(SPEC_KEYWORD)
    return parts.map((part, index) =>
      index % 2 === 1 ? (
        <span key={`${keyBase}-kw-${index}`} className="font-semibold tracking-tight text-foreground">
          {part}
        </span>
      ) : (
        <React.Fragment key={`${keyBase}-kw-${index}`}>{part}</React.Fragment>
      ),
    )
  }

  // `**bold**` is the one markdown feature board prose carries (the bold-lead
  // form); anything richer stays out of the pipeline deliberately.
  function plainNodes(chunk: string, keyBase: string): React.ReactNode[] {
    const segments = chunk.split(/(\*\*[^*]+\*\*)/)
    if (segments.length === 1) return keywordNodes(chunk, keyBase)
    return segments.flatMap((segment, index) =>
      segment.startsWith("**") && segment.endsWith("**") ? (
        <strong key={`${keyBase}-b-${index}`} className="font-semibold text-foreground">
          {keywordNodes(segment.slice(2, -2), `${keyBase}-b-${index}`)}
        </strong>
      ) : (
        keywordNodes(segment, `${keyBase}-${index}`)
      ),
    )
  }

  function renderTokens(segment: string, paragraphIndex: number, keyOffset: number): React.ReactNode[] {
    const nodes: React.ReactNode[] = []
    let last = 0
    let match: RegExpExecArray | null
    TOKEN.lastIndex = 0
    while ((match = TOKEN.exec(segment)) !== null) {
      if (match.index > last) nodes.push(...plainNodes(segment.slice(last, match.index), `${keyOffset}-${last}`))
      const token = match[0]
      const inner = token.startsWith("`") ? token.slice(1, -1) : token
      const isRef = FILE_REF.test(inner)
      const key = `${keyOffset}-${match.index}`
      if (isRef) {
        const refKey = `${paragraphIndex}:${inner}`
        const shortLabel = inner.includes("/") ? (inner.split("/").pop() ?? inner) : inner
        nodes.push(
          <button
            key={key}
            type="button"
            onClick={() => setActiveRef((current) => (current === refKey ? null : refKey))}
            title={inner}
            className={cn(
              "rounded bg-secondary/60 px-1 py-px font-mono text-[0.86em] underline decoration-dotted underline-offset-2 transition-colors",
              activeRef === refKey ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {shortLabel}
          </button>,
        )
      } else if (token.startsWith("`")) {
        nodes.push(
          <code key={key} className="font-mono text-[0.9em] text-foreground">
            {inner}
          </code>,
        )
      } else {
        nodes.push(token)
      }
      last = match.index + token.length
    }
    if (last < segment.length) nodes.push(...plainNodes(segment.slice(last), `${keyOffset}-${last}`))
    return nodes
  }

  /**
   * The reader selects DISPLAY text (backticks stripped, citation chips show
   * short labels), but highlighting slices the RAW source string. This maps a
   * display-text quote back to a raw range, snapping to token boundaries.
   */
  function findRawRange(paragraph: string, quote: string): { start: number; end: number } | null {
    type Segment = { rawStart: number; rawEnd: number; normStart: number; normEnd: number; token: boolean }
    const segments: Segment[] = []
    let norm = ""
    let last = 0
    let match: RegExpExecArray | null
    TOKEN.lastIndex = 0
    const push = (rawStart: number, rawEnd: number, display: string, token: boolean) => {
      segments.push({ rawStart, rawEnd, normStart: norm.length, normEnd: norm.length + display.length, token })
      norm += display
    }
    while ((match = TOKEN.exec(paragraph)) !== null) {
      if (match.index > last) push(last, match.index, paragraph.slice(last, match.index), false)
      const token = match[0]
      const inner = token.startsWith("`") ? token.slice(1, -1) : token
      const display =
        FILE_REF.test(inner) && inner.includes("/") ? (inner.split("/").pop() ?? inner) : inner
      push(match.index, match.index + token.length, display, true)
      last = match.index + token.length
    }
    if (last < paragraph.length) push(last, paragraph.length, paragraph.slice(last), false)

    const normIndex = norm.indexOf(quote)
    if (normIndex === -1) return null
    const normEnd = normIndex + quote.length
    const startSegment = segments.find((s) => normIndex >= s.normStart && normIndex < s.normEnd)
    const endSegment = segments.find((s) => normEnd > s.normStart && normEnd <= s.normEnd)
    if (!startSegment || !endSegment) return null
    const start = startSegment.token
      ? startSegment.rawStart
      : startSegment.rawStart + (normIndex - startSegment.normStart)
    const end = endSegment.token ? endSegment.rawEnd : endSegment.rawStart + (normEnd - endSegment.normStart)
    return { start, end }
  }

  function buildNodes(paragraph: string, paragraphIndex: number): React.ReactNode[] {
    // Durable highlights: wrap any span of this paragraph that a quote thread
    // anchors to. A multi-paragraph quote keeps its composer chip but gets no
    // inline highlight (its text no longer matches one paragraph).
    const threads = (store?.quoteComments ?? [])
      .filter((thread) => thread.quote.length > 0)
      .map((thread) => ({ thread, range: findRawRange(paragraph, thread.quote) }))
      .filter((entry): entry is { thread: QuoteComment; range: { start: number; end: number } } =>
        entry.range !== null,
      )
      .sort((a, b) => a.range.start - b.range.start)

    const nodes: React.ReactNode[] = []
    let cursor = 0
    for (const { thread, range } of threads) {
      if (range.start < cursor) continue
      if (range.start > cursor)
        nodes.push(...renderTokens(paragraph.slice(cursor, range.start), paragraphIndex, cursor))
      nodes.push(
        <QuoteHighlight key={thread.id} thread={thread}>
          {renderTokens(paragraph.slice(range.start, range.end), paragraphIndex, range.start)}
        </QuoteHighlight>,
      )
      cursor = range.end
    }
    if (cursor < paragraph.length) nodes.push(...renderTokens(paragraph.slice(cursor), paragraphIndex, cursor))
    return nodes
  }

  function renderParagraph(paragraph: string, paragraphIndex: number) {
    const activeInParagraph =
      activeRef && activeRef.startsWith(`${paragraphIndex}:`) ? activeRef.slice(activeRef.indexOf(":") + 1) : null

    // A block whose lines all start with "- " is a bulleted list; each line
    // keeps the full token pipeline (citations, code, highlights).
    const lines = paragraph.split("\n")
    if (lines.length > 1 && lines.every((line) => line.startsWith("- "))) {
      return (
        <React.Fragment key={paragraphIndex}>
          <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground/60">
            {lines.map((line, lineIndex) => (
              <li key={lineIndex} className={paragraphClassName}>
                {buildNodes(line.slice(2), paragraphIndex)}
              </li>
            ))}
          </ul>
          {activeInParagraph && <SourcePanel anchor={parseRef(activeInParagraph)} />}
        </React.Fragment>
      )
    }

    return (
      <React.Fragment key={paragraphIndex}>
        <p className={paragraphClassName}>{buildNodes(paragraph, paragraphIndex)}</p>
        {activeInParagraph && <SourcePanel anchor={parseRef(activeInParagraph)} />}
      </React.Fragment>
    )
  }

  return <div className={cn("flex flex-col gap-2", className)}>{paragraphs.map(renderParagraph)}</div>
}
