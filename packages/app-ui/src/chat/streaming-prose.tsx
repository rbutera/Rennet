// ─────────────────────────────────────────────────────────────────────────────
// StreamingProse (C07, ported from the board-prototype spike). Renders paragraphs
// with each word fading/blurring in, staggered by a fast per-word CSS delay — all
// words mount at once and animate via `animation-delay`, so it is a single continuous
// reveal with no re-renders and no self-timed state. `animate=false` renders instantly:
// historical turns replay as records, never as arrivals (the record-vs-arrival law).
// The `.animate-word-in` utility + `word-in` keyframe live in `../index.css`.
// ─────────────────────────────────────────────────────────────────────────────

const WORD_STEP_MS = 22;

/** Split into words, dropping whitespace (spaces are re-inserted during render). */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export interface StreamingProseProps {
  readonly paragraphs: readonly string[];
  readonly className?: string;
  /** false renders instantly — historical turns replay as records, never as arrivals. */
  readonly animate?: boolean;
}

export function StreamingProse({ paragraphs, className, animate = true }: StreamingProseProps) {
  if (!animate) {
    return (
      <div className={className}>
        {paragraphs.map((paragraph, pIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are a fixed positional list.
          <p key={pIndex} className={pIndex > 0 ? "mt-3" : undefined}>
            {paragraph}
          </p>
        ))}
      </div>
    );
  }

  let wordIndex = 0;
  return (
    <div className={className}>
      {paragraphs.map((paragraph, pIndex) => {
        const words = splitWords(paragraph);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are a fixed positional list.
          <p key={pIndex} className={pIndex > 0 ? "mt-3" : undefined}>
            {words.map((word, wIndex) => {
              const delay = wordIndex * WORD_STEP_MS;
              wordIndex += 1;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: word order within a paragraph is stable and positional.
                <span key={wIndex}>
                  <span
                    className="animate-word-in inline-block opacity-0"
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    {word}
                  </span>
                  {wIndex < words.length - 1 ? " " : ""}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
