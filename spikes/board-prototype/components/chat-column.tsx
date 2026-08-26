"use client"

import { useEffect, useRef, useState } from "react"
import { PanelRight } from "lucide-react"
import { SessionTrail } from "@/components/location-trail"
import { ConversationPane } from "@/components/conversation-pane"
import { InputBar } from "@/components/input-bar"
import { followUpExchanges, type TurnData } from "@/lib/conversation-data"
import type { SessionItem } from "@/lib/sidebar-data"
import type { ComposerBadge } from "@/lib/composer-badges"
import { useCodeComments } from "@/components/code-comments"

function commentBadgeId(path: string, line: number) {
  return `comment-${path}-${line}`
}

export function ChatColumn({
  onCollapse,
  width = 420,
  transcript,
  projectName,
  session,
}: {
  onCollapse: () => void
  width?: number
  transcript: TurnData[]
  projectName: string
  session: SessionItem
}) {
  const [turns, setTurns] = useState<TurnData[]>(transcript)
  // Turns appended after mount animate in; everything else is a record.
  const liveIds = useRef(new Set<string>())

  // A scenario switch replaces the whole conversation record.
  useEffect(() => {
    liveIds.current = new Set()
    setTurns(transcript)
  }, [transcript])
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
    liveIds.current.add(userTurn.id)
    setTurns((prev) => [...prev, userTurn])
    setExchangeIndex((i) => Math.min(i + 1, followUpExchanges.length - 1))
    setImageBadges([])
    store?.clear()

    setTimeout(() => {
      liveIds.current.add(`orchestrator-${now}`)
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
      <ChatHeader projectName={projectName} session={session} onCollapse={onCollapse} />
      <ConversationPane
        turns={turns}
        comments={comments}
        onCommentChange={handleCommentChange}
        liveIds={liveIds.current}
      />
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

/**
 * The one chat-pane header: trail + collapse. Every chat surface (scenario
 * sessions AND the minted new-chat run) renders this — never a bespoke bar.
 */
export function ChatHeader({
  projectName,
  session,
  onCollapse,
}: {
  projectName: string
  session: SessionItem
  onCollapse: () => void
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
      <SessionTrail projectName={projectName} session={session} />
      <button
        type="button"
        onClick={onCollapse}
        aria-label="Collapse chat"
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <PanelRight className="size-3.5" aria-hidden="true" />
      </button>
    </header>
  )
}
