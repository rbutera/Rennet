const WORD_STEP_MS = 22

/** Splits text into words, dropping whitespace (spaces are re-inserted separately during render). */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

/**
 * Renders paragraphs with each word fading/blurring in, staggered by a fast
 * per-word delay. All words mount at once and animate via CSS `animation-delay`,
 * so there's a single continuous reveal across paragraph breaks with no re-renders.
 */
export function StreamingProse({ paragraphs, className }: { paragraphs: string[]; className?: string }) {
  let wordIndex = 0

  return (
    <div className={className}>
      {paragraphs.map((paragraph, pIndex) => {
        const words = splitWords(paragraph)
        return (
          <p key={pIndex} className={pIndex > 0 ? "mt-3" : undefined}>
            {words.map((word, wIndex) => {
              const delay = wordIndex * WORD_STEP_MS
              wordIndex += 1
              return (
                <span key={wIndex}>
                  <span
                    className="animate-word-in inline-block opacity-0"
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    {word}
                  </span>
                  {wIndex < words.length - 1 ? " " : ""}
                </span>
              )
            })}
          </p>
        )
      })}
    </div>
  )
}
