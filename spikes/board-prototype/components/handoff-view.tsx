"use client"

import * as React from "react"
import { Check, GitPullRequest, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import { type Ask, useCodeComments } from "@/components/code-comments"
import { ProseSelectionLayer } from "@/components/selection-toolbar"
import { AnchorReveal } from "@/components/code-tabs"
import { RichText } from "@/components/rich-text"
import { StreamingProse } from "@/components/streaming-prose"

type Verdict = "Approve" | "Request Changes" | "Comment"

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

/**
 * The Hand off view, teammate-PR mode: one lane, Post review. The living
 * draft the orchestrator keeps current from staged asks; steering happens by
 * selection (Revise / Drop / Explain), never by typing into the draft (R32).
 */
export function HandoffView({ prLabel = "PR #434" }: { prLabel?: string }) {
  const store = useCodeComments()
  const asks = React.useMemo(() => store?.asks ?? [], [store?.asks])
  const retired = store?.retired ?? []

  const [override, setOverride] = React.useState<Verdict | null>(null)
  const [stage, setStage] = React.useState<"edit" | "preview" | "posted">("edit")
  const [revisions, setRevisions] = React.useState<Record<string, string>>({})
  const [streamingIds, setStreamingIds] = React.useState<Set<string>>(new Set())
  const seenAskIds = React.useRef<Set<string>>(new Set())

  const derived: Verdict = asks.some((ask) => ask.intent === "request-change")
    ? "Request Changes"
    : asks.length > 0
      ? "Comment"
      : "Approve"
  const verdict = override ?? derived
  const requestChangeCount = asks.filter((a) => a.intent === "request-change").length
  const commentCount = asks.length - requestChangeCount

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

  function handleRevise(quote: string, instruction: string) {
    const ask = findAskByQuote(quote)
    if (!ask) return
    setStreamingIds(new Set([ask.id]))
    window.setTimeout(() => {
      setRevisions((previous) => ({ ...previous, [ask.id]: applyRevision(blockText(ask), instruction) }))
      setStreamingIds(new Set())
    }, 1200)
  }

  function handleDrop(quote: string) {
    const ask = findAskByQuote(quote)
    if (!ask || !store) return
    store.retireBlock(blockText(ask), "dropped by you")
    store.unstageAsk(ask.id)
  }

  function handleExplain(quote: string): string {
    const ask = findAskByQuote(quote)
    return ask
      ? `This block comes from ${ask.source} — staged as a ${ask.intent.replace("-", " ")}.`
      : "This is the drafted opening; it follows from the verdict and the staged asks."
  }

  const threadsStaying = store?.quoteComments.length ?? 0
  const commentsStaying = Object.values(store?.comments ?? {}).reduce(
    (count, lines) => count + Object.keys(lines).length,
    0,
  )

  if (stage === "posted") {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col items-start gap-3 px-8 py-10">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <Check className="size-4 text-emerald-500" aria-hidden="true" />
          Review posted to {prLabel}
        </span>
        <p className="text-[13.5px] text-muted-foreground">
          {verdict} · {asks.filter((a) => a.codeAnchor).length} line comment
          {asks.filter((a) => a.codeAnchor).length === 1 ? "" : "s"} · body —
          github.com/acme/orbital/pull/434#pullrequestreview
        </p>
      </div>
    )
  }

  const preview = stage === "preview"
  const inlineAsks = asks.filter((ask) => ask.codeAnchor)
  const bodyAsks = asks.filter((ask) => !ask.codeAnchor)

  function askBlock(ask: Ask) {
    return (
      <div key={ask.id} className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              ask.intent === "request-change"
                ? "bg-primary/15 text-primary"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {ask.intent === "request-change" ? "request change" : "comment"}
          </span>
          <span className="text-[11px] text-muted-foreground/80">{ask.source}</span>
        </span>
        {streamingIds.has(ask.id) ? (
          <StreamingProse
            paragraphs={[blockText(ask)]}
            className="text-[14px] leading-relaxed text-foreground/90"
          />
        ) : (
          <RichText text={blockText(ask)} paragraphClassName="text-[14px] leading-relaxed text-foreground/90" />
        )}
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

  const draftBody = (
    <div className="flex flex-col gap-4">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Review body
      </span>
      <RichText
        text={openerFor(verdict, asks.length)}
        paragraphClassName="text-[14px] leading-relaxed text-foreground/90"
      />
      {bodyAsks.map(askBlock)}
      {inlineAsks.length > 0 && (
        <div className="mt-1 flex flex-col gap-3 border-t border-border/60 pt-3">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Line comments · {inlineAsks.length}
          </span>
          {[...inlineByFile.entries()].map(([path, fileAsks]) => (
            <div key={path} className="flex flex-col gap-2.5">
              <span className="font-mono text-[11.5px] text-muted-foreground">{path}</span>
              {fileAsks.map((ask) => (
                <div key={ask.id} className="flex flex-col gap-1.5 border-l-2 border-border/60 pl-3">
                  {ask.codeAnchor && <AnchorReveal anchors={[ask.codeAnchor]} />}
                  {askBlock(ask)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {asks.length === 0 && verdict !== "Approve" && (
        <p className="text-[13px] text-muted-foreground">Nothing staged yet.</p>
      )}
    </div>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-8 py-8">
        {/* Lane header */}
        <div className="flex items-center gap-2.5">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Post Review · {prLabel}</h1>
          {preview && (
            <span className="rounded border border-primary/40 px-1.5 py-0.5 text-[11px] text-primary">
              exactly what will post
            </span>
          )}
        </div>

        {/* Verdict */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[12px] text-muted-foreground">Verdict</span>
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {(["Approve", "Request Changes", "Comment"] as Verdict[]).map((option) => (
              <button
                key={option}
                type="button"
                disabled={preview}
                onClick={() => setOverride(option === derived ? null : option)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors",
                  option === verdict
                    ? "bg-secondary font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                  preview && option !== verdict && "opacity-40",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    option === "Approve" && "bg-emerald-500",
                    option === "Request Changes" && "bg-amber-500",
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

        {/* The living draft */}
        <div className={cn("rounded-md border px-4 py-3.5", preview ? "border-primary/40" : "border-border")}>
          {preview ? (
            draftBody
          ) : (
            <ProseSelectionLayer
              draftHandlers={{ onRevise: handleRevise, onDrop: handleDrop, explain: handleExplain }}
            >
              {draftBody}
            </ProseSelectionLayer>
          )}
        </div>

        {/* Residue + retired */}
        {!preview && (
          <>
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
                      onClick={() => {
                        store?.restoreRetired(entry.id)
                        store?.stageAsk(entry.text, "request-change", "restored from retired")
                      }}
                      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <RotateCcw className="size-2.5" aria-hidden="true" />
                      Restore
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {preview ? (
            <>
              <button
                type="button"
                onClick={() => setStage("posted")}
                className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                Post Review
              </button>
              <button
                type="button"
                onClick={() => setStage("edit")}
                className="rounded-md px-2.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                Back to Draft
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setStage("preview")}
              className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              Preview
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
