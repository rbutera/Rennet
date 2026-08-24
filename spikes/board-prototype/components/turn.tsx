"use client"

import { useState } from "react"
import { ActivitySequence } from "@/components/activity-sequence"
import { StreamingProse } from "@/components/streaming-prose"
import { CodeBlock } from "@/components/code-block"
import type { TurnData } from "@/lib/conversation-data"

export function Turn({
  turn,
  comments,
  onCommentChange,
}: {
  turn: TurnData
  comments?: Record<string, Record<number, string>>
  onCommentChange?: (path: string, line: number, text: string | null) => void
}) {
  const isUser = turn.speaker === "user"
  // `turn` is keyed by turn.id in the parent list, so this component remounts
  // (and this initial state is recomputed) whenever the turn actually changes.
  const [prefaceDone, setPrefaceDone] = useState(!turn.preface)

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[520px] rounded-lg bg-secondary px-3 py-2 font-prose text-[15px] leading-relaxed text-foreground/95">
          {turn.paragraphs.map((paragraph, index) => (
            <p key={index} className={index > 0 ? "mt-2" : undefined}>
              {paragraph}
            </p>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground/50">{turn.time}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {turn.lead && (
        <StreamingProse
          paragraphs={[turn.lead]}
          className="max-w-[640px] font-prose text-[15px] leading-relaxed text-foreground/90"
        />
      )}
      {turn.preface && <ActivitySequence steps={turn.preface} onComplete={() => setPrefaceDone(true)} />}
      {prefaceDone && turn.body && (
        <div className="flex max-w-[640px] flex-col gap-3">
          {turn.body.map((block, index) =>
            block.kind === "text" ? (
              <StreamingProse
                key={index}
                paragraphs={[block.text]}
                className="font-prose text-[15px] leading-relaxed text-foreground/90"
              />
            ) : (
              <CodeBlock
                key={index}
                path={block.path}
                lang={block.lang}
                code={block.code}
                startLine={block.startLine}
                highlightLines={block.highlightLines}
                comments={comments?.[block.path]}
                onCommentChange={
                  onCommentChange ? (line, text) => onCommentChange(block.path, line, text) : undefined
                }
              />
            ),
          )}
        </div>
      )}
      {prefaceDone && !turn.body && (
        <StreamingProse
          paragraphs={turn.paragraphs}
          className="max-w-[640px] font-prose text-[15px] leading-relaxed text-foreground/90"
        />
      )}
    </div>
  )
}
