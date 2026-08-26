"use client"

import { useShallow } from "zustand/react/shallow"
import { useAppStore } from "@/lib/store"

/**
 * App-wide per-line code comments, keyed by file path then absolute line.
 * One store serves every code block — chat tool output, board code elements,
 * excerpt tabs, click-to-reveal panels — so a comment made anywhere mints the
 * same composer reference chip and survives view switches. CodeBlock falls
 * back to this context when no comment props are passed.
 */
export type CodeComments = Record<string, Record<number, string>>

export interface QuoteMessage {
  author: "user" | "orchestrator"
  text: string
}

export interface QuoteComment {
  id: string
  /** The highlighted prose the thread anchors to. */
  quote: string
  /** The exchange: the opening comment/question and every reply. */
  messages: QuoteMessage[]
}

/** The staged unit of the hand-off (R29): anchor + text + intent + provenance. */
export interface Ask {
  id: string
  text: string
  intent: "comment" | "request-change"
  /** Where it came from, e.g. a finding title or a quoted span. */
  source: string
  /**
   * Diff position, when the provenance carries one. With it the ask posts as
   * a GitHub line comment; without it the ask travels in the review body
   * (board prose has no diff position to pin to).
   */
  codeAnchor?: { path: string; line: number }
  /** The quote thread this ask was staged from, so the pip counts one item, not two. */
  threadId?: string
}

/** A draft block retired by rework or Drop — ledgered, restorable (R32). */
export interface RetiredBlock {
  id: string
  text: string
  reason: string
}

interface CodeCommentsStore {
  comments: CodeComments
  quoteComments: QuoteComment[]
  setComment: (path: string, line: number, text: string | null) => void
  addQuoteComment: (quote: string, text: string) => string
  addQuoteReply: (id: string, author: "user" | "orchestrator", text: string) => void
  removeQuoteComment: (id: string) => void
  /** Thread to auto-open (set on creation so the tooltip shows immediately). */
  focusedThreadId: string | null
  focusThread: (id: string | null) => void
  /** Hand-off state: staged asks, the retired ledger, and rework triggers. */
  asks: Ask[]
  stageAsk: (
    text: string,
    intent: Ask["intent"],
    source: string,
    codeAnchor?: Ask["codeAnchor"],
    threadId?: string,
  ) => string
  unstageAsk: (id: string) => void
  retired: RetiredBlock[]
  retireBlock: (text: string, reason: string) => void
  restoreRetired: (id: string) => void
  clear: () => void
}

/**
 * Thin hook over the review slice of `useAppStore` — same shape the old
 * CodeCommentsProvider exposed, so no consumer changed. `useShallow` keeps the
 * assembled object stable across renders (fields are individually referenced).
 */
export function useCodeComments(): CodeCommentsStore {
  return useAppStore(
    useShallow((s) => ({
      comments: s.comments,
      quoteComments: s.quoteComments,
      setComment: s.setComment,
      addQuoteComment: s.addQuoteComment,
      addQuoteReply: s.addQuoteReply,
      removeQuoteComment: s.removeQuoteComment,
      focusedThreadId: s.focusedThreadId,
      focusThread: s.focusThread,
      asks: s.asks,
      stageAsk: s.stageAsk,
      unstageAsk: s.unstageAsk,
      retired: s.retired,
      retireBlock: s.retireBlock,
      restoreRetired: s.restoreRetired,
      clear: s.clear,
    })),
  )
}
