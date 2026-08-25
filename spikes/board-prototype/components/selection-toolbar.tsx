"use client"

import * as React from "react"
import { MessageSquare, Sparkles } from "lucide-react"
import { useCodeComments } from "@/components/code-comments"
import { EXPLAIN_OPENER, nextCannedReply } from "@/lib/quote-thread-demo"

/**
 * Text-selection controls for board prose: highlighting text shows a small
 * toolbar above the selection (Comment / Explain). Comment opens a mini
 * editor anchored to the same spot; saving stores a quote-anchored comment,
 * which mints a composer chip exactly like a code-line comment. Replaces the
 * old per-block hover Explain button, which covered content.
 */
export function ProseSelectionLayer({ children }: { children: React.ReactNode }) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = React.useState<{ top: number; left: number; quote: string } | null>(null)
  const [mode, setMode] = React.useState<"toolbar" | "comment">("toolbar")
  const [draft, setDraft] = React.useState("")
  const store = useCodeComments()

  const dismiss = React.useCallback(() => {
    setAnchor(null)
    setMode("toolbar")
    setDraft("")
  }, [])

  React.useEffect(() => {
    function handleMouseUp(event: MouseEvent) {
      // Clicks inside the floating panel must not re-anchor or dismiss.
      if (panelRef.current?.contains(event.target as Node)) return
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !containerRef.current) {
        dismiss()
        return
      }
      const range = selection.getRangeAt(0)
      if (!containerRef.current.contains(range.commonAncestorContainer)) {
        dismiss()
        return
      }
      const text = selection.toString().trim()
      if (text.length === 0) {
        dismiss()
        return
      }
      const rect = range.getBoundingClientRect()
      const wrapRect = containerRef.current.getBoundingClientRect()
      setMode("toolbar")
      setAnchor({
        top: rect.top - wrapRect.top,
        left: rect.left - wrapRect.left + rect.width / 2,
        quote: text,
      })
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") dismiss()
    }

    document.addEventListener("mouseup", handleMouseUp)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mouseup", handleMouseUp)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [dismiss])

  function startThread(opener: string) {
    if (!anchor || !store) return
    const id = store.addQuoteComment(anchor.quote, opener)
    store.focusThread(id)
    const reply = nextCannedReply()
    window.setTimeout(() => store.addQuoteReply(id, "orchestrator", reply), 1100)
    window.getSelection()?.removeAllRanges()
  }

  function handleSave() {
    const text = draft.trim()
    if (text.length > 0) startThread(text)
    dismiss()
  }

  return (
    // Positioned wrapper: the panel is absolute inside the board, so it
    // scrolls with the text it anchors to instead of dying on scroll.
    <div ref={containerRef} className="relative">
      {children}
      {anchor && (
        <div
          ref={panelRef}
          className="absolute z-50 -translate-x-1/2 -translate-y-full"
          style={{ top: anchor.top - 8, left: anchor.left }}
        >
          {mode === "toolbar" ? (
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-popover px-1 py-0.5 shadow-md">
              <button
                type="button"
                onClick={() => setMode("comment")}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-foreground/90 hover:bg-secondary"
              >
                <MessageSquare className="size-3" aria-hidden="true" />
                Comment
              </button>
              <button
                type="button"
                onClick={() => {
                  startThread(EXPLAIN_OPENER)
                  dismiss()
                }}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Sparkles className="size-3" aria-hidden="true" />
                Explain
              </button>
            </div>
          ) : (
            <div className="w-[340px] rounded-md border border-border bg-popover p-2.5 shadow-lg">
              <p className="mb-1.5 line-clamp-2 border-l-2 border-border pl-2 text-[11.5px] italic leading-snug text-muted-foreground">
                {anchor.quote}
              </p>
              <textarea
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    handleSave()
                  }
                }}
                placeholder="Ask a question or leave a comment…"
                rows={2}
                className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
              />
              <div className="mt-1.5 flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={dismiss}
                  className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
