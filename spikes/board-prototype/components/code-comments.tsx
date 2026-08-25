"use client"

import * as React from "react"

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
  clear: () => void
}

const CodeCommentsContext = React.createContext<CodeCommentsStore | null>(null)

export function CodeCommentsProvider({ children }: { children: React.ReactNode }) {
  const [comments, setComments] = React.useState<CodeComments>({})
  const [quoteComments, setQuoteComments] = React.useState<QuoteComment[]>([])
  const [focusedThreadId, setFocusedThreadId] = React.useState<string | null>(null)

  const setComment = React.useCallback((path: string, line: number, text: string | null) => {
    setComments((previous) => {
      const next = { ...previous }
      const lineMap = { ...(next[path] ?? {}) }
      if (text === null) {
        delete lineMap[line]
      } else {
        lineMap[line] = text
      }
      if (Object.keys(lineMap).length > 0) {
        next[path] = lineMap
      } else {
        delete next[path]
      }
      return next
    })
  }, [])

  const quoteSeq = React.useRef(0)

  const addQuoteComment = React.useCallback((quote: string, text: string) => {
    const id = `quote-${quoteSeq.current++}`
    setQuoteComments((previous) => [
      ...previous,
      { id, quote, messages: [{ author: "user" as const, text }] },
    ])
    return id
  }, [])

  const addQuoteReply = React.useCallback((id: string, author: "user" | "orchestrator", text: string) => {
    setQuoteComments((previous) =>
      previous.map((entry) =>
        entry.id === id ? { ...entry, messages: [...entry.messages, { author, text }] } : entry,
      ),
    )
  }, [])

  const removeQuoteComment = React.useCallback((id: string) => {
    setQuoteComments((previous) => previous.filter((entry) => entry.id !== id))
  }, [])

  const focusThread = React.useCallback((id: string | null) => setFocusedThreadId(id), [])

  const clear = React.useCallback(() => {
    setComments({})
    setQuoteComments([])
    setFocusedThreadId(null)
  }, [])

  const store = React.useMemo(
    () => ({
      comments,
      quoteComments,
      setComment,
      addQuoteComment,
      addQuoteReply,
      removeQuoteComment,
      focusedThreadId,
      focusThread,
      clear,
    }),
    [comments, quoteComments, setComment, addQuoteComment, addQuoteReply, removeQuoteComment, focusedThreadId, focusThread, clear],
  )

  return <CodeCommentsContext.Provider value={store}>{children}</CodeCommentsContext.Provider>
}

export function useCodeComments(): CodeCommentsStore | null {
  return React.useContext(CodeCommentsContext)
}
