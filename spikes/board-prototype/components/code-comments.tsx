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

export interface QuoteComment {
  id: string
  /** The highlighted prose the comment anchors to. */
  quote: string
  text: string
}

interface CodeCommentsStore {
  comments: CodeComments
  quoteComments: QuoteComment[]
  setComment: (path: string, line: number, text: string | null) => void
  addQuoteComment: (quote: string, text: string) => void
  removeQuoteComment: (id: string) => void
  clear: () => void
}

const CodeCommentsContext = React.createContext<CodeCommentsStore | null>(null)

export function CodeCommentsProvider({ children }: { children: React.ReactNode }) {
  const [comments, setComments] = React.useState<CodeComments>({})
  const [quoteComments, setQuoteComments] = React.useState<QuoteComment[]>([])

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

  const addQuoteComment = React.useCallback((quote: string, text: string) => {
    setQuoteComments((previous) => [
      ...previous,
      { id: `quote-${previous.length}-${quote.slice(0, 12)}`, quote, text },
    ])
  }, [])

  const removeQuoteComment = React.useCallback((id: string) => {
    setQuoteComments((previous) => previous.filter((entry) => entry.id !== id))
  }, [])

  const clear = React.useCallback(() => {
    setComments({})
    setQuoteComments([])
  }, [])

  const store = React.useMemo(
    () => ({ comments, quoteComments, setComment, addQuoteComment, removeQuoteComment, clear }),
    [comments, quoteComments, setComment, addQuoteComment, removeQuoteComment, clear],
  )

  return <CodeCommentsContext.Provider value={store}>{children}</CodeCommentsContext.Provider>
}

export function useCodeComments(): CodeCommentsStore | null {
  return React.useContext(CodeCommentsContext)
}
