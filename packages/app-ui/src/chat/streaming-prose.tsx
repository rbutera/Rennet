import { Fragment, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// StreamingProse (C07, ported from the board-prototype spike). Renders paragraphs
// with each word fading/blurring in, staggered by a fast per-word CSS delay. Only
// NEWLY-ARRIVED words animate: as a live turn grows delta by delta, already-revealed
// words render settled (no `.animate-word-in`, no restart) while the freshly-appended
// words fade in, staggered relative to the new batch — so a word never sits invisible
// waiting out an absolute-index delay, and the reveal never restarts on each delta.
// `animate=false` renders instantly: historical turns replay as records, never as
// arrivals (the record-vs-arrival law). `animate-word-in` is a real utility, generated
// from `--animate-word-in` in `../index.css`'s `@theme` (fill `forwards`, landing on
// opacity 1). The `opacity-0` class below is load-bearing for that fill: it holds a word
// invisible until its delay elapses, which `forwards` does not do — which is also why
// this call site must NOT carry `motion-reduce:animate-none`. Killing the animation would
// leave every streamed word at `opacity-0` forever; the base reduced-motion rule collapses
// the duration instead, so the `forwards` fill lands on the settled frame immediately.
//
// PERF (audit §5 H9). Settled words are TEXT, not spans. The reveal only ever needs an
// element for the batch that is currently animating: once a word is revealed its span
// carries no animation, no delay and no distinguishing class, so it can collapse into the
// paragraph's settled prefix — which is exactly how the same prose renders as a record.
// That takes a live turn from two DOM nodes per word (rebuilt element-by-element on every
// delta, each with a fresh inline style object) to one text node plus the arriving batch,
// so a delta costs the batch instead of the whole turn. `memo` on this component was tried
// and REVERTED: a live-marked turn settles its words on the next render with unchanged
// paragraphs, so skipping that render leaves a restored transcript animating as an arrival —
// `routes/app.dom.test.tsx` pins that a reopened session replays as a RECORD. Bounding the
// per-delta work is `Turn`'s memo's job; this component stays plain.
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

  let paragraphStart = 0;
  return (
    <div className={className}>
      {paragraphWords.map((words, pIndex) => {
        const start = paragraphStart;
        paragraphStart += words.length;
        // The settled prefix of THIS paragraph, clamped into it: earlier paragraphs may be
        // entirely revealed and later ones not started.
        const settledCount = Math.min(words.length, Math.max(0, alreadyRevealed - start));
        const settled = words.slice(0, settledCount).join(" ");
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are a fixed positional list.
          <p key={pIndex} className={pIndex > 0 ? "mt-3" : undefined}>
            {settledCount > 0 ? (settledCount < words.length ? `${settled} ` : settled) : null}
            {words.slice(settledCount).map((word, index) => {
              const wIndex = settledCount + index;
              return (
                // Keyed by position in the PARAGRAPH, not in the arriving batch: a word
                // keeps its key as the batch behind it settles, so its animation does not
                // restart on the next delta.
                <Fragment key={wIndex}>
                  <span
                    className="animate-word-in inline-block opacity-0"
                    style={{
                      animationDelay: `${(start + wIndex - alreadyRevealed) * WORD_STEP_MS}ms`,
                    }}
                  >
                    {word}
                  </span>
                  {wIndex < words.length - 1 ? " " : ""}
                </Fragment>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
