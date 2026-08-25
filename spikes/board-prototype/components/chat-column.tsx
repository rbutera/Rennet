"use client"

import { useEffect, useState } from "react"
import { PanelRight } from "lucide-react"
import { LocationTrail } from "@/components/location-trail"
import { ConversationPane } from "@/components/conversation-pane"
import { InputBar } from "@/components/input-bar"
import { followUpExchanges, type TurnData } from "@/lib/conversation-data"
import type { ComposerBadge } from "@/lib/composer-badges"
import { useCodeComments } from "@/components/code-comments"

function commentBadgeId(path: string, line: number) {
  return `comment-${path}-${line}`
}

export function ChatColumn({
  onCollapse,
  width = 420,
  transcript,
}: {
  onCollapse: () => void
  width?: number
  transcript: TurnData[]
}) {
  const [turns, setTurns] = useState<TurnData[]>(transcript)

  // A scenario switch replaces the whole conversation record.
  useEffect(() => setTurns(transcript), [transcript])
  const [exchangeIndex, setExchangeIndex] = useState(0)
  const [imageBadges, setImageBadges] = useState<ComposerBadge[]>([])
  const store = useCodeComments()
  const comments = store?.comments ?? {}

  const nextExchange = followUpExchanges[exchangeIndex] ?? followUpExchanges[followUpExchanges.length - 1]

  const commentBadges: ComposerBadge[] = Object.entries(comments).flatMap(([path, lineMap]) =>
    Object.entries(lineMap).map(([line, text]) => ({
      id: commentBadgeId(path, Number(line)),
      kind: "comment" as const,
      path,
      line: Number(line),
      text,
    })),
  )
  const quoteBadges: ComposerBadge[] = (store?.quoteComments ?? []).map((entry) => ({
    id: entry.id,
    kind: "quote" as const,
    quote: entry.quote,
    text: entry.messages[0]?.text ?? "",
  }))
  const badges: ComposerBadge[] = [...commentBadges, ...quoteBadges, ...imageBadges]

  function handleSend(message: string) {
    const now = Date.now()
    const userTurn: TurnData = {
      ...nextExchange.user,
      id: `user-${now}`,
      paragraphs: [message],
    }
    setTurns((prev) => [...prev, userTurn])
    setExchangeIndex((i) => Math.min(i + 1, followUpExchanges.length - 1))
    setImageBadges([])
    store?.clear()

    setTimeout(() => {
      setTurns((prev) => [...prev, { ...nextExchange.orchestrator, id: `orchestrator-${now}` }])
    }, 700)
  }

  function handleCommentChange(path: string, line: number, text: string | null) {
    store?.setComment(path, line, text)
  }

  function handleAddImage(file: File) {
    const thumbnailUrl = URL.createObjectURL(file)
    setImageBadges((prev) => [
      ...prev,
      {
        id: `image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind: "image",
        name: file.name || "image.png",
        thumbnailUrl,
      },
    ])
  }

  function handleRemoveBadge(badge: ComposerBadge) {
    if (badge.kind === "image") {
      URL.revokeObjectURL(badge.thumbnailUrl)
      setImageBadges((prev) => prev.filter((b) => b.id !== badge.id))
    } else if (badge.kind === "quote") {
      store?.removeQuoteComment(badge.id)
    } else {
      handleCommentChange(badge.path, badge.line, null)
    }
  }

  return (
    <div
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-border"
      style={{ width }}
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <LocationTrail />
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse chat"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <PanelRight className="size-3.5" aria-hidden="true" />
        </button>
      </header>
      <ConversationPane turns={turns} comments={comments} onCommentChange={handleCommentChange} />
      <InputBar
        onSend={handleSend}
        prefillMessage={nextExchange.user.paragraphs[0]}
        badges={badges}
        onRemoveBadge={handleRemoveBadge}
        onAddImage={handleAddImage}
      />
    </div>
  )
}
