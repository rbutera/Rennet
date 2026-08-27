import { useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// StreamingProse (C07, ported from the board-prototype spike). Renders paragraphs
// with each word fading/blurring in, staggered by a fast per-word CSS delay. Only
// NEWLY-ARRIVED words animate: as a live turn grows delta by delta, already-revealed
// words render settled (no `.animate-word-in`, no restart) while the freshly-appended
// words fade in, staggered relative to the new batch — so a word never sits invisible
// waiting out an absolute-index delay, and the reveal never restarts on each delta.
// `animate=false` renders instantly: historical turns replay as records, never as
// arrivals (the record-vs-arrival law). The `.animate-word-in` utility + `word-in`
// keyframe (fill `both`, landing on opacity 1) live in `../index.css`.
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
  const paragraphWords = paragraphs.map(splitWords);
  const totalWords = paragraphWords.reduce((sum, words) => sum + words.length, 0);

  // How many words were already on screen at the previous render. Words at or beyond this
  // count are the delta that just arrived — only those animate. Records (animate=false)
  // treat everything as already-revealed. Bumped AFTER paint so the next delta measures right.
  const revealedRef = useRef(0);
  const alreadyRevealed = animate ? Math.min(revealedRef.current, totalWords) : totalWords;
  useEffect(() => {
    // Only accumulate revealed words WHILE animating. A record (animate=false) leaves the
    // count at 0, so if this same prose later arrives live (record → arrival), its whole
    // reveal plays — the record-vs-arrival law.
    revealedRef.current = animate ? totalWords : 0;
  });

  if (!animate) {
    return (
      <div className={className}>
        {paragraphWords.map((_words, pIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are a fixed positional list.
          <p key={pIndex} className={pIndex > 0 ? "mt-3" : undefined}>
            {paragraphs[pIndex]}
          </p>
        ))}
      </div>
    );
  }

  let wordIndex = 0;
  return (
    <div className={className}>
      {paragraphWords.map((words, pIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are a fixed positional list.
        <p key={pIndex} className={pIndex > 0 ? "mt-3" : undefined}>
          {words.map((word, wIndex) => {
            const globalIndex = wordIndex;
            wordIndex += 1;
            const isNew = globalIndex >= alreadyRevealed;
            const delay = isNew ? (globalIndex - alreadyRevealed) * WORD_STEP_MS : 0;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: word order within a paragraph is stable and positional.
              <span key={wIndex}>
                <span
                  className={isNew ? "animate-word-in inline-block opacity-0" : "inline-block"}
                  style={isNew ? { animationDelay: `${delay}ms` } : undefined}
                >
                  {word}
                </span>
                {wIndex < words.length - 1 ? " " : ""}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}
