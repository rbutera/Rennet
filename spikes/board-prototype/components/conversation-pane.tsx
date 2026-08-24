"use client"

import { useEffect, useRef } from "react"
import { Turn } from "@/components/turn"
import type { TurnData } from "@/lib/conversation-data"

export function ConversationPane({
  turns,
  comments,
  onCommentChange,
}: {
  turns: TurnData[]
  comments?: Record<string, Record<number, string>>
  onCommentChange?: (path: string, line: number, text: string | null) => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [turns.length])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-6 px-5 py-6">
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} comments={comments} onCommentChange={onCommentChange} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
