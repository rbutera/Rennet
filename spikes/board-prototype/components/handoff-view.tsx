"use client"

import * as React from "react"
import { Check, GitPullRequest, Pencil, RotateCcw, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { type Ask, useCodeComments } from "@/components/code-comments"
import { ProseSelectionLayer } from "@/components/selection-toolbar"
import { AnchorReveal } from "@/components/code-tabs"
import { RichText } from "@/components/rich-text"
import { StreamingProse } from "@/components/streaming-prose"
import { RoundsLanes } from "@/components/rounds-lanes"
import type { Scenario } from "@/lib/scenarios"

type Verdict = "Approve" | "Request Changes" | "Comment"

/**
 * The Hand off view dispatches by the scenario's entry mode (R31): a teammate
 * PR gets the single Post Review lane below; an own branch gets the R34 rounds
 * lanes (This Round + The Pull Request).
 */
export function HandoffView({
  handoff,
  onDispatchRound,
  onOpenPullRequest,
}: {
  handoff: Scenario["handoff"]
  onDispatchRound?: () => void
  onOpenPullRequest?: () => void
}) {
  if (handoff.mode === "rounds") {
    return <RoundsLanes pr={handoff.pr} onDispatch={onDispatchRound} onOpenPullRequest={onOpenPullRequest} />
  }
  return <PostReviewLane prLabel={handoff.prLabel} />
}

/** Deterministic demo stand-in for the orchestrator's rework of a span. */
function applyRevision(text: string, instruction: string): string {
  const firstSentence = text.split(/(?<=\.)\s+/)[0] ?? text
  if (/short|tight|blunt|brief/i.test(instruction)) return firstSentence
  return `${firstSentence} ${instruction.replace(/[.?!]*$/, "")}.`
}

function openerFor(verdict: Verdict, askCount: number): string {
  if (verdict === "Approve")
    return "This holds up. The retry removal is the right call — the shared transport owns the only replay-safe retry — and the secret-free record shape delivers what the PR promises. The threads raised during the read resolved cleanly; nothing rises to a request."
  if (verdict === "Request Changes")
    return `Solid direction, with ${askCount === 1 ? "one thing" : `${askCount} things`} to settle before merge. The refresh observability this PR adds is the point of the change, so the gaps below are worth closing now rather than in a follow-up.`
  return "A few notes from the read — nothing blocking."
}

/** Provenance a retired block needs to come back whole (intent + diff anchor). */
interface RetiredProvenance {
  intent: Ask["intent"]
  source: string
  codeAnchor?: Ask["codeAnchor"]
}

/**
 * The Hand off view, teammate-PR mode: one lane, Post review. The living
 * draft the orchestrator keeps current from staged asks; steering happens by
 * selection (Revise / Drop / Explain), never by typing into the draft (R32).
 * The draft is rendered exactly as it posts, so there is no separate preview
 * stage — Post Review acts on what is on screen.
 */
function PostReviewLane({ prLabel = "PR #434" }: { prLabel?: string }) {
  const store = useCodeComments()
  const asks = React.useMemo(() => store?.asks ?? [], [store?.asks])
  const retired = store?.retired ?? []

  const [override, setOverride] = React.useState<Verdict | null>(null)
  const [stage, setStage] = React.useState<"edit" | "posted">("edit")
  const [revisions, setRevisions] = React.useState<Record<string, string>>({})
  const [streamingIds, setStreamingIds] = React.useState<Set<string>>(new Set())
  const seenAskIds = React.useRef<Set<string>>(new Set())

  // Opener steering: a revision overrides the generated text; a drop removes
  // it (ledgered in Retired, restorable). Both survive verdict switches — the
  // reviewer's edit wins over regeneration.
  const [openerOverride, setOpenerOverride] = React.useState<string | null>(null)
  const [openerDropped, setOpenerDropped] = React.useState(false)
  const [openerStreaming, setOpenerStreaming] = React.useState(false)
  const droppedOpenerText = React.useRef<string | null>(null)
  const retiredProvenance = React.useRef<Map<string, RetiredProvenance>>(new Map())

  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editDraft, setEditDraft] = React.useState("")

  const derived: Verdict = asks.some((ask) => ask.intent === "request-change")
    ? "Request Changes"
    : asks.length > 0
      ? "Comment"
      : "Approve"
  const verdict = override ?? derived
  const requestChangeCount = asks.filter((a) => a.intent === "request-change").length
  const commentCount = asks.length - requestChangeCount
  const opener = openerDropped ? null : (openerOverride ?? openerFor(verdict, asks.length))

  // The living draft catches up on asks staged since the last look: each new
  // ask streams its block in with a visible trigger line (R32).
  React.useEffect(() => {
    const fresh = asks.filter((ask) => !seenAskIds.current.has(ask.id))
    if (fresh.length === 0) return
    for (const ask of fresh) seenAskIds.current.add(ask.id)
    setStreamingIds((previous) => {
      const next = new Set(previous)
      for (const ask of fresh) next.add(ask.id)
      return next
    })
    const timer = window.setTimeout(() => setStreamingIds(new Set()), 1400)
    return () => window.clearTimeout(timer)
  }, [asks])

  function blockText(ask: Ask): string {
    return revisions[ask.id] ?? ask.text
  }

  function findAskByQuote(quote: string): Ask | undefined {
    return asks.find((ask) => blockText(ask).includes(quote) || quote.includes(blockText(ask).slice(0, 40)))
  }

  function quoteHitsOpener(quote: string): boolean {
    return opener !== null && (opener.includes(quote) || quote.includes(opener.slice(0, 40)))
  }

  function handleRevise(quote: string, instruction: string) {
    const ask = findAskByQuote(quote)
    if (ask) {
      setStreamingIds(new Set([ask.id]))
      window.setTimeout(() => {
        setRevisions((previous) => ({ ...previous, [ask.id]: applyRevision(blockText(ask), instruction) }))
        setStreamingIds(new Set())
      }, 1200)
      return
    }
    if (opener && quoteHitsOpener(quote)) {
      setOpenerStreaming(true)
      window.setTimeout(() => {
        setOpenerOverride(applyRevision(opener, instruction))
        setOpenerStreaming(false)
      }, 1200)
    }
  }

  function handleDrop(quote: string) {
    const ask = findAskByQuote(quote)
    if (ask && store) {
      const text = blockText(ask)
      retiredProvenance.current.set(text, { intent: ask.intent, source: ask.source, codeAnchor: ask.codeAnchor })
      store.retireBlock(text, "dropped by you")
      store.unstageAsk(ask.id)
      return
    }
    if (opener && quoteHitsOpener(quote) && store) {
      droppedOpenerText.current = opener
      store.retireBlock(opener, "dropped by you")
      setOpenerDropped(true)
    }
  }

  function handleExplain(quote: string): string {
    const ask = findAskByQuote(quote)
    if (ask) return `This block comes from ${ask.source} — staged as a ${ask.intent.replace("-", " ")}.`
    if (quoteHitsOpener(quote))
      return `This is the drafted opening — written from the ${verdict.toLowerCase()} verdict and the ${asks.length} staged ask${asks.length === 1 ? "" : "s"}.`
    return "This is drafted prose; it follows from the verdict and the staged asks."
  }

  function handleRestore(entryId: string, text: string) {
    store?.restoreRetired(entryId)
    if (droppedOpenerText.current === text) {
      setOpenerDropped(false)
      setOpenerOverride(text)
      droppedOpenerText.current = null
      return
    }
    const provenance = retiredProvenance.current.get(text)
    store?.stageAsk(
      text,
      provenance?.intent ?? "request-change",
      provenance?.source ?? "restored from retired",
      provenance?.codeAnchor,
    )
  }

  function startEdit(ask: Ask) {
    setEditingId(ask.id)
    setEditDraft(blockText(ask))
  }

  function saveEdit() {
    if (!editingId) return
    const text = editDraft.trim()
    if (text.length > 0) setRevisions((previous) => ({ ...previous, [editingId]: text }))
    setEditingId(null)
    setEditDraft("")
  }

  function deleteAsk(ask: Ask) {
    if (!store) return
    const text = blockText(ask)
    retiredProvenance.current.set(text, { intent: ask.intent, source: ask.source, codeAnchor: ask.codeAnchor })
    store.retireBlock(text, "deleted by you")
    store.unstageAsk(ask.id)
  }

  const threadsStaying = store?.quoteComments.length ?? 0
  const commentsStaying = Object.values(store?.comments ?? {}).reduce(
    (count, lines) => count + Object.keys(lines).length,
    0,
  )

  const inlineAsks = asks.filter((ask) => ask.codeAnchor)
  const bodyAsks = asks.filter((ask) => !ask.codeAnchor)

  if (stage === "posted") {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col items-start gap-3 px-8 py-10">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <Check className="size-4 text-green" aria-hidden="true" />
          Review posted to {prLabel}
        </span>
        <p className="text-[13.5px] text-muted-foreground">
          {verdict} · {inlineAsks.length} line comment
          {inlineAsks.length === 1 ? "" : "s"} · body —
          github.com/acme/orbital/pull/434#pullrequestreview
        </p>
      </div>
    )
  }

  function intentTag(ask: Ask) {
    return (
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
          ask.intent === "request-change" ? "bg-warn-soft text-warn" : "bg-secondary text-muted-foreground",
        )}
      >
        {ask.intent === "request-change" ? "request change" : "comment"}
      </span>
    )
  }

  // Body asks read as review prose: serif, same measure as the opener, with a
  // small provenance line above each block.
  function bodyAskBlock(ask: Ask) {
    return (
      <div key={ask.id} className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5">
          {intentTag(ask)}
          <span className="text-[11px] text-muted-foreground/80">{ask.source}</span>
        </span>
        {streamingIds.has(ask.id) ? (
          <StreamingProse
            paragraphs={[blockText(ask)]}
            className="font-serif text-[15px] leading-[1.7] text-foreground/90"
          />
        ) : (
          <RichText text={blockText(ask)} paragraphClassName="font-serif text-[15px] leading-[1.7] text-foreground/90" />
        )}
      </div>
    )
  }

  // Line comments are the cards on this page: each one a discrete object
  // pinned to a diff position, with its own Edit / Delete controls.
  function lineCommentCard(ask: Ask) {
    const editing = editingId === ask.id
    return (
      <div key={ask.id} className="group rounded-lg border border-border bg-card px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          {ask.codeAnchor && <AnchorReveal anchors={[ask.codeAnchor]} />}
          {intentTag(ask)}
          {!editing && (
            <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => startEdit(ask)}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Pencil className="size-3" aria-hidden="true" />
                Edit
              </button>
              <button
                type="button"
                onClick={() => deleteAsk(ask)}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Trash2 className="size-3" aria-hidden="true" />
                Delete
              </button>
            </span>
          )}
        </div>
        <div className="mt-1.5">
          {editing ? (
            <>
              <textarea
                autoFocus
                value={editDraft}
                onChange={(event) => setEditDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    saveEdit()
                  }
                  if (event.key === "Escape") setEditingId(null)
                }}
                rows={2}
                className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[13.5px] leading-relaxed text-foreground focus-visible:border-ring focus-visible:outline-none"
              />
              <div className="mt-1.5 flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Save
                </button>
              </div>
            </>
          ) : streamingIds.has(ask.id) ? (
            <StreamingProse
              paragraphs={[blockText(ask)]}
              className="text-[13.5px] leading-relaxed text-foreground/90"
            />
          ) : (
            <RichText text={blockText(ask)} paragraphClassName="text-[13.5px] leading-relaxed text-foreground/90" />
          )}
        </div>
      </div>
    )
  }

  // Rendered in GitHub's own shape: one review body, then line comments
  // pinned to diff positions, grouped by file.
  const inlineByFile = new Map<string, Ask[]>()
  for (const ask of inlineAsks) {
    const path = ask.codeAnchor?.path ?? ""
    inlineByFile.set(path, [...(inlineByFile.get(path) ?? []), ask])
  }

  const reviewBody = (
    <div className="flex flex-col gap-4">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Review body
      </span>
      {opener &&
        (openerStreaming ? (
          <StreamingProse
            paragraphs={[opener]}
            className="font-serif text-[15px] leading-[1.7] text-foreground/90"
          />
        ) : (
          <RichText text={opener} paragraphClassName="font-serif text-[15px] leading-[1.7] text-foreground/90" />
        ))}
      {bodyAsks.map(bodyAskBlock)}
    </div>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
        {/* Lane header */}
        <div className="flex items-center gap-2.5">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Post Review · {prLabel}</h1>
        </div>

        {/* Verdict */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[12px] text-muted-foreground">Verdict</span>
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {(["Approve", "Request Changes", "Comment"] as Verdict[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setOverride(option === derived ? null : option)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors",
                  option === verdict
                    ? "bg-secondary font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    option === "Approve" && "bg-green",
                    option === "Request Changes" && "bg-warn",
                    option === "Comment" && "bg-muted-foreground/50",
                    option !== verdict && "opacity-40",
                  )}
                />
                {option}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-muted-foreground/80">
            {override ? (
              <>
                overridden — proposed {derived.toLowerCase()}{" "}
                <button
                  type="button"
                  onClick={() => setOverride(null)}
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                >
                  use proposal
                </button>
              </>
            ) : (
              `proposed from your review · ${requestChangeCount} request change${requestChangeCount === 1 ? "" : "s"} · ${commentCount} comment${commentCount === 1 ? "" : "s"}`
            )}
          </span>
        </div>

        {/* The living draft: open prose, no wrapper — the page is the review. */}
        <ProseSelectionLayer
          draftHandlers={{ onRevise: handleRevise, onDrop: handleDrop, explain: handleExplain }}
        >
          {reviewBody}
        </ProseSelectionLayer>

        {/* Line comments: the discrete objects get the cards. */}
        {inlineAsks.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Line comments · {inlineAsks.length}
            </span>
            {[...inlineByFile.entries()].map(([path, fileAsks]) => (
              <div key={path} className="flex flex-col gap-2">
                <span className="font-mono text-[11.5px] text-muted-foreground">{path}</span>
                {fileAsks.map(lineCommentCard)}
              </div>
            ))}
          </div>
        )}

        {/* Residue + retired */}
        <p className="text-[12px] text-muted-foreground/80">
          {threadsStaying} thread{threadsStaying === 1 ? "" : "s"} · {commentsStaying} code comment
          {commentsStaying === 1 ? "" : "s"} stay local
        </p>
        {retired.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Retired
            </span>
            {retired.map((entry) => (
              <span key={entry.id} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground line-through">
                  {entry.text}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground/70">{entry.reason}</span>
                <button
                  type="button"
                  onClick={() => handleRestore(entry.id, entry.text)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <RotateCcw className="size-2.5" aria-hidden="true" />
                  Restore
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Post: the draft above is exactly what posts — no separate preview. */}
        <div className="flex items-center border-t border-border/60 pt-4">
          <button
            type="button"
            onClick={() => setStage("posted")}
            className="rounded-md bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            Post Review
          </button>
        </div>
      </div>
    </div>
  )
}
