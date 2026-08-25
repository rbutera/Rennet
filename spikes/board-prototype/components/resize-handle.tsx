"use client"

import * as React from "react"

const MIN_CHAT_WIDTH = 320
const MIN_SURFACE_WIDTH = 400

export const DEFAULT_CHAT_WIDTH = 420

/**
 * The draggable divider between the chat column and the main surface.
 * Pointer-capture drag adjusts the chat width. Both panes have a minimum;
 * the chat's maximum is simply whatever the container leaves once the main
 * surface keeps its minimum — no arbitrary cap.
 */
export function ResizeHandle({
  value,
  onChange,
}: {
  value: number
  onChange: (width: number) => void
}) {
  const dragging = React.useRef<{ startX: number; startWidth: number; maxWidth: number } | null>(null)

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // The chat's left edge = the handle's position minus the current width
    // (robust even when the direct parent is a display:contents wrapper).
    const chatLeft = event.currentTarget.getBoundingClientRect().left + 3 - value
    dragging.current = {
      startX: event.clientX,
      startWidth: value,
      maxWidth: Math.max(MIN_CHAT_WIDTH, window.innerWidth - chatLeft - MIN_SURFACE_WIDTH),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    const next = dragging.current.startWidth + (event.clientX - dragging.current.startX)
    onChange(Math.min(dragging.current.maxWidth, Math.max(MIN_CHAT_WIDTH, next)))
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragging.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    document.body.style.userSelect = ""
    document.body.style.cursor = ""
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat column"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => onChange(DEFAULT_CHAT_WIDTH)}
      className="-mx-[3px] z-10 w-[6px] shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40 active:bg-primary/60"
    />
  )
}
