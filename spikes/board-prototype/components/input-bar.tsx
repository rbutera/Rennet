"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { ArrowUp, FileCode, MessageSquare, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ComposerBadge } from "@/lib/composer-badges"

const MIN_TEXTAREA_HEIGHT = 36
const MAX_TEXTAREA_HEIGHT = 200

function ComposerBadgePill({ badge, onRemove }: { badge: ComposerBadge; onRemove: () => void }) {
  const [isHovered, setIsHovered] = useState(false)

  return (
    <span
      className="relative flex items-center gap-1.5 rounded-md border border-border bg-secondary/60 py-1 pl-1 pr-1.5 text-[12px] text-foreground/90"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {badge.kind === "image" ? (
        <img
          src={badge.thumbnailUrl || "/placeholder.svg"}
          alt=""
          className="size-4 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <MessageSquare className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="max-w-[160px] truncate">{badge.kind === "image" ? badge.name : "1 comment"}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${badge.kind === "image" ? badge.name : `comment on line ${badge.line}`} reference`}
        className="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
      >
        <X className="size-3" aria-hidden="true" />
      </button>

      {badge.kind === "comment" && isHovered && (
        <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 w-64 max-w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-2.5 text-foreground shadow-lg">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FileCode className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono">{badge.path}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-primary">L{badge.line}</div>
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">{badge.text}</p>
        </div>
      )}
    </span>
  )
}

export function InputBar({
  onSend,
  prefillMessage,
  badges,
  onRemoveBadge,
  onAddImage,
}: {
  onSend: (message: string) => void
  prefillMessage: string
  badges: ComposerBadge[]
  onRemoveBadge: (badge: ComposerBadge) => void
  onAddImage: (file: File) => void
}) {
  const [value, setValue] = useState("")
  const [hasPrefilled, setHasPrefilled] = useState(false)
  const composingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT)
    textarea.style.height = `${nextHeight}px`
  }, [value])

  function handleSubmit() {
    if (!value.trim()) return
    onSend(value.trim())
    setValue("")
    setHasPrefilled(false)
  }

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {badges.map((badge) => (
              <ComposerBadgePill key={badge.id} badge={badge} onRemove={() => onRemoveBadge(badge)} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              if (!hasPrefilled) {
                setHasPrefilled(true)
                setValue(prefillMessage)
                return
              }
              setValue(event.target.value)
            }}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return
              if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return
              event.preventDefault()
              handleSubmit()
            }}
            onPaste={(event) => {
              const items = event.clipboardData?.items
              if (!items) return
              for (const item of items) {
                if (item.type.startsWith("image/")) {
                  const file = item.getAsFile()
                  if (file) {
                    event.preventDefault()
                    onAddImage(file)
                  }
                  break
                }
              }
            }}
            placeholder="message the orchestrator"
            rows={1}
            aria-label="Message the orchestrator"
            className="flex-1 resize-none overflow-y-auto rounded-md border border-border bg-card/40 px-3 py-2 font-sans text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
            style={{ height: MIN_TEXTAREA_HEIGHT }}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim()}
            aria-label="Send"
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed",
              value.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
