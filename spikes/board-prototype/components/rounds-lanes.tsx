"use client"

import * as React from "react"
import { GitBranch, GitPullRequest } from "lucide-react"
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
 * The Hand off view, own-branch mode (R34): two lanes. **This Round** is the
 * living work order composed from the staged asks — steered by span selection
 * (Revise / Drop / Explain), dispatched as one round. **The Pull Request** is
 * always visible, its description ripening across rounds toward the real PR.
 */
export function RoundsLanes({
  pr,
  onDispatch,
  onOpenPullRequest,
}: {
  pr: { title: string; body: string; ready: boolean }
  onDispatch?: () => void
  /** Present only once the PR lane is ripe (the `returned` state). */
  onOpenPullRequest?: () => void
}) {
  const store = useCodeComments()
  const asks = React.useMemo(() => store?.asks ?? [], [store?.asks])

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
      ? `This instruction comes from ${ask.source}${ask.codeAnchor ? ` (${ask.codeAnchor.path.split("/").pop()}:${ask.codeAnchor.line})` : ""}.`
      : "This is the round's opening — it frames the asks for the coding agent."
  }

  const prBodyParagraphs = pr.body.split(/\n{2,}/).filter((block) => block.trim().length > 0)

  const workOrder = (
    <div className="flex flex-col gap-3">
      <RichText
        text={
          asks.length === 0
            ? "Nothing staged for this round yet — raise a change on the boards and it lands here."
            : `Apply the ${asks.length === 1 ? "change" : `${asks.length} changes`} below on a detached worktree of fix/token-refresh-observability, run the full gate, and report what each one did.`
        }
        paragraphClassName="text-[14px] leading-relaxed text-foreground/90"
      />
      {asks.map((ask, index) => (
        <div key={ask.id} className="flex flex-col gap-1.5 border-l-2 border-border/60 pl-3">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">{index + 1}.</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                ask.intent === "request-change" ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
              )}
            >
              {ask.intent === "request-change" ? "request change" : "comment"}
            </span>
            <span className="text-[11px] text-muted-foreground/80">{ask.source}</span>
          </span>
          {streamingIds.has(ask.id) ? (
            <StreamingProse paragraphs={[orderText(ask)]} className="text-[14px] leading-relaxed text-foreground/90" />
          ) : (
            <RichText text={orderText(ask)} paragraphClassName="text-[14px] leading-relaxed text-foreground/90" />
          )}
          {ask.codeAnchor && <AnchorReveal anchors={[ask.codeAnchor]} />}
        </div>
      ))}
    </div>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-8 py-8">
        {/* This Round */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-[20px] font-semibold tracking-tight text-foreground">This Round</h1>
            <span className="text-[12px] text-muted-foreground">
              {asks.length} {asks.length === 1 ? "ask" : "asks"}
            </span>
          </div>
          <div className="rounded-md border border-border px-4 py-3.5">
            <ProseSelectionLayer draftHandlers={{ onRevise: handleRevise, onDrop: handleDrop, explain: handleExplain }}>
              {workOrder}
            </ProseSelectionLayer>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={asks.length === 0}
              onClick={onDispatch}
              className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              Dispatch Round
            </button>
            <span className="text-[12px] text-muted-foreground/80">
              one worker, detached worktree · asks raised mid-run queue for the next round
            </span>
          </div>
        </section>

        {/* The Pull Request */}
        <section className="flex flex-col gap-3 border-t border-border/60 pt-6">
          <div className="flex items-center gap-2.5">
            <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-[17px] font-semibold tracking-tight text-foreground">The Pull Request</h2>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px]",
                pr.ready ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-border text-muted-foreground",
              )}
            >
              {pr.ready ? "ripe" : "ripening"}
            </span>
          </div>
          <div className="rounded-md border border-border">
            <div className="border-b border-border px-4 py-2.5">
              <span className="text-[14px] font-medium text-foreground">{pr.title}</span>
            </div>
            <div className="max-h-[320px] overflow-y-auto px-4 py-3">
              {prBodyParagraphs.map((block, index) => (
                <RichText
                  key={index}
                  text={block}
                  paragraphClassName={cn(
                    "text-[13px] leading-relaxed text-foreground/85",
                    index > 0 && "mt-2.5",
                  )}
                />
              ))}
            </div>
          </div>
          {pr.ready ? (
            <button
              type="button"
              onClick={onOpenPullRequest}
              className="w-fit rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              Open Pull Request
            </button>
          ) : (
            <span className="text-[12px] text-muted-foreground/80">
              Opens after the round closes the asks — the description keeps ripening until then.
            </span>
          )}
        </section>
      </div>
    </div>
  )
}
