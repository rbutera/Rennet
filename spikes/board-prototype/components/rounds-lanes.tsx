"use client"

import * as React from "react"
import { Check, GitBranch, GitPullRequest } from "lucide-react"
import { cn } from "@/lib/utils"
import { type Ask, useCodeComments } from "@/components/code-comments"
import { ProseSelectionLayer } from "@/components/selection-toolbar"
import { AnchorReveal } from "@/components/code-tabs"
import { RichText } from "@/components/rich-text"
import { StreamingProse } from "@/components/streaming-prose"

/** Deterministic demo stand-in for the orchestrator reworking a work-order span. */
function applyRevision(text: string, instruction: string): string {
  const firstSentence = text.split(/(?<=\.)\s+/)[0] ?? text
  if (/short|tight|blunt|brief/i.test(instruction)) return firstSentence
  return `${firstSentence} ${instruction.replace(/[.?!]*$/, "")}.`
}

/**
 * The Hand off view, own-branch mode (R34/R37). One goal, two states, and the
 * page's shape states which one you're in: while asks remain, the page is
 * **Changes** — one card per ask, Dispatch Round — and the pull request is a
 * single muted destination line. When nothing is left to ask, the page IS the
 * pull request: title, body, Open Pull Request.
 */
export function RoundsLanes({
  pr,
  onDispatch,
  onOpenPullRequest,
}: {
  pr: { title: string; body: string; ready: boolean }
  onDispatch?: () => void
  /** Present only once the PR is the page (the `returned` state). */
  onOpenPullRequest?: () => void
}) {
  const store = useCodeComments()
  const asks = React.useMemo(() => store?.asks ?? [], [store?.asks])

  const [submitted, setSubmitted] = React.useState(false)
  const [revisions, setRevisions] = React.useState<Record<string, string>>({})
  const [streamingIds, setStreamingIds] = React.useState<Set<string>>(new Set())

  function orderText(ask: Ask): string {
    return revisions[ask.id] ?? ask.text
  }

  function findAskByQuote(quote: string): Ask | undefined {
    return asks.find((ask) => orderText(ask).includes(quote) || quote.includes(orderText(ask).slice(0, 40)))
  }

  function handleRevise(quote: string, instruction: string) {
    const ask = findAskByQuote(quote)
    if (!ask) return
    setStreamingIds(new Set([ask.id]))
    window.setTimeout(() => {
      setRevisions((previous) => ({ ...previous, [ask.id]: applyRevision(orderText(ask), instruction) }))
      setStreamingIds(new Set())
    }, 1200)
  }

  function handleDrop(quote: string) {
    const ask = findAskByQuote(quote)
    if (!ask || !store) return
    store.retireBlock(orderText(ask), "dropped from the round")
    store.unstageAsk(ask.id)
  }

  function handleExplain(quote: string): string {
    const ask = findAskByQuote(quote)
    return ask
      ? `This change comes from ${ask.source}${ask.codeAnchor ? ` (${ask.codeAnchor.path.split("/").pop()}:${ask.codeAnchor.line})` : ""}.`
      : "This is drafted from the staged asks."
  }

  const prBodyParagraphs = pr.body.split(/\n{2,}/).filter((block) => block.trim().length > 0)
  const gathering = asks.length > 0

  /** Minimal markdown for the PR body: ## headings and **bold** spans. */
  function prBlock(block: string, index: number) {
    if (block.startsWith("## ")) {
      return (
        <h3 key={index} className={cn("text-[14px] font-semibold text-foreground", index > 0 && "mt-4")}>
          {block.slice(3)}
        </h3>
      )
    }
    const clean = block.replace(/\*\*([^*]+)\*\*/g, "$1")
    return (
      <RichText
        key={index}
        text={clean}
        paragraphClassName={cn("text-[13.5px] leading-relaxed text-foreground/85", index > 0 && "mt-2")}
      />
    )
  }

  // ── State: the pull request is the page ────────────────────────────────
  if (!gathering && pr.ready) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-8 py-8">
          <div className="flex items-center gap-2.5">
            <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{pr.title}</h1>
          </div>
          <div className="flex flex-col">{prBodyParagraphs.map(prBlock)}</div>
          {submitted ? (
            <div className="flex flex-col gap-1 pt-1">
              <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                <Check className="size-4 text-emerald-500" aria-hidden="true" />
                Pull request opened · #438
              </span>
              <span className="text-[12px] text-muted-foreground">github.com/rbutera/rennet/pull/438</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSubmitted(true)
                onOpenPullRequest?.()
              }}
              className="w-fit rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              Open Pull Request
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── State: changes remain ──────────────────────────────────────────────
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-8 py-8">
        <div className="flex items-center gap-2.5">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Changes</h1>
          {gathering && (
            <span className="text-[12px] text-muted-foreground">{asks.length}</span>
          )}
        </div>

        {gathering ? (
          <ProseSelectionLayer draftHandlers={{ onRevise: handleRevise, onDrop: handleDrop, explain: handleExplain }}>
            <div className="flex flex-col gap-3">
              {asks.map((ask) => (
                <div key={ask.id} className="flex flex-col gap-1.5 rounded-md border border-border px-4 py-3">
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
                      paragraphs={[orderText(ask)]}
                      className="text-[14px] leading-relaxed text-foreground/90"
                    />
                  ) : (
                    <RichText
                      text={orderText(ask)}
                      paragraphClassName="text-[14px] leading-relaxed text-foreground/90"
                    />
                  )}
                  {ask.codeAnchor && <AnchorReveal anchors={[ask.codeAnchor]} />}
                </div>
              ))}
            </div>
          </ProseSelectionLayer>
        ) : (
          <p className="text-[13px] text-muted-foreground">Nothing staged yet.</p>
        )}

        <button
          type="button"
          disabled={!gathering}
          onClick={onDispatch}
          className="w-fit rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Dispatch Round
        </button>

        {/* The destination, held quietly until the changes are gone. */}
        <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-4">
          <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <span className="min-w-0 truncate text-[12.5px] text-muted-foreground/60">{pr.title}</span>
        </div>
      </div>
    </div>
  )
}
