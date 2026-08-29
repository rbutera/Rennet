import { cn } from "@rennet/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  displayToRawRange,
  type RawTextRange,
  RichText,
  type RichTextDecoration,
} from "../review/rich-text";
import { type QuoteThread, useRennetStore } from "../store";
import { useBoardGeneration } from "./kinds/element-context";

// ─────────────────────────────────────────────────────────────────────────────
// Durable quote highlights (C05 cluster 5, Objective clause 4 / Reconciliation 5).
//
// C4's `RichText` renders plain prose and explicitly left the durable-highlight
// overlay to [ws:C5]. This layer WRAPS that output: anchored quote ranges come from
// the `review` slice's `quoteThreads` (keyed by thread id, `anchor` = the span text),
// so the highlight is DURABLE — driven by the store, not local state, it survives
// every rerender. Clicking a highlight opens the thread exchange with a reply input
// (`addQuoteReply`). An `explain` thread reads distinctly and never stages an ask, so
// it never raises an exit count. Overlapping anchors resolve to a readable stack: the
// covered segment carries every covering thread, all reachable from one popover.
//
// Ranges are located against RichText's display-to-raw map, then handed back to the
// same renderer as decorations. A highlight therefore keeps citation chips, code spans,
// bold text, and keyword styling instead of flattening the paragraph to a text node.
// ─────────────────────────────────────────────────────────────────────────────

/** A thread paired with its store id — what a highlight span needs to open the exchange. */
interface KeyedThread {
  readonly id: string;
  readonly thread: QuoteThread;
}

interface RangedThread extends KeyedThread, RawTextRange {}

/** The tooltip stack: one section per thread covering the clicked span, each with its
 *  exchange and a reply input. `explain` threads read distinctly (a question to the
 *  orchestrator, never a review verb). Spans, not divs — the highlight lives inside a
 *  `<p>` and nested block/button elements are invalid there (spike keep-list note). */
function QuoteThreadPopover({ threads }: { readonly threads: readonly KeyedThread[] }) {
  const addQuoteReply = useRennetStore((s) => s.reviewActions.addQuoteReply);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <span className="absolute bottom-full left-0 z-50 mb-1.5 block w-[340px] cursor-auto rounded-md border border-border bg-popover p-2.5 font-sans not-italic shadow-overlay">
      {threads.map(({ id, thread }) => (
        <span
          key={id}
          data-thread-id={id}
          data-thread-kind={thread.kind ?? "comment"}
          className="mb-2 block last:mb-0"
        >
          <span className="mb-1 block text-2xs uppercase tracking-wide text-muted-foreground">
            {thread.kind === "explain" ? "Explain" : "Comment"}
          </span>
          <span className="mb-1.5 flex flex-col gap-1.5">
            {thread.messages.map((message, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: an append-only exchange is a stable positional list.
                key={index}
                className={cn(
                  "block text-2xs leading-relaxed",
                  message.author === "user"
                    ? "self-end max-w-[260px] rounded-lg bg-secondary px-2.5 py-1.5 text-foreground/95"
                    : "text-foreground/85",
                )}
              >
                {message.text}
              </span>
            ))}
          </span>
          <textarea
            value={drafts[id] ?? ""}
            onChange={(event) => setDrafts((d) => ({ ...d, [id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const text = (drafts[id] ?? "").trim();
                if (text.length === 0) return;
                addQuoteReply(id, "user", text);
                setDrafts((d) => ({ ...d, [id]: "" }));
              }
            }}
            placeholder="Reply…"
            rows={1}
            className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-2xs leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
          />
        </span>
      ))}
    </span>
  );
}

/** One highlighted span over prose. Clicking toggles the thread stack. A span with
 *  `role="button"` (not `<button>`): the highlighted prose can carry citation-chip
 *  buttons, and nested buttons are invalid HTML. */
function QuoteHighlight({
  threads,
  children,
}: {
  readonly threads: readonly KeyedThread[];
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const explainOnly = threads.every(({ thread }) => thread.kind === "explain");
  const focusedThreadId = useRennetStore((s) => s.review.focusedThreadId);
  const setFocusedThread = useRennetStore((s) => s.reviewActions.setFocusedThread);

  // The selection-toolbar hand-off (Objective clause 5): Comment/Explain/Request-Changes
  // mint a thread and CALL `setFocusedThread(id)` — no separate toolbar logic here. When a
  // thread this highlight covers is focused, open the popover and release the focus, so the
  // reviewer lands straight in the exchange they just opened.
  useEffect(() => {
    if (focusedThreadId && threads.some(({ id }) => id === focusedThreadId)) {
      setOpen(true);
      setFocusedThread(null);
    }
  }, [focusedThreadId, threads, setFocusedThread]);

  // A usable popover: an outside click or Escape closes it (no gate — just close-on-blur).
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} className="relative">
      {/* biome-ignore lint/a11y/useSemanticElements: highlighted prose can carry citation-chip <button>s, and nested buttons are invalid HTML — a role="button" span is the keep-list pattern. */}
      <span
        role="button"
        tabIndex={0}
        data-quote-highlight
        data-thread-count={threads.length}
        data-explain={explainOnly ? "true" : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((v) => !v);
          }
        }}
        title="View thread"
        className={cn(
          "cursor-pointer rounded-sm px-0.5 shadow-[inset_0_-1.5px_0_0] transition-colors [box-decoration-break:clone]",
          explainOnly
            ? "bg-muted-foreground/15 shadow-muted-foreground/50 hover:bg-muted-foreground/25"
            : "bg-primary/15 shadow-primary/60 hover:bg-primary/25",
          open && (explainOnly ? "bg-muted-foreground/25" : "bg-primary/30"),
        )}
      >
        {children}
      </span>
      {open && <QuoteThreadPopover threads={threads} />}
    </span>
  );
}

function uniqueRawRange(rawText: string, rawQuote: string): RawTextRange | null {
  if (rawQuote.length === 0) return null;
  const start = rawText.indexOf(rawQuote);
  if (start < 0 || rawText.indexOf(rawQuote, start + 1) >= 0) return null;
  return { start, end: start + rawQuote.length };
}

function anchorRange(rawText: string, anchor: string): RawTextRange | null {
  return displayToRawRange(rawText, anchor) ?? uniqueRawRange(rawText, anchor);
}

/** Convert possibly overlapping thread ranges to disjoint decorated spans. */
function decorationsFor(ranges: readonly RangedThread[]): RichTextDecoration[] {
  const points = [...new Set(ranges.flatMap((range) => [range.start, range.end]))].sort(
    (a, b) => a - b,
  );
  const decorations: RichTextDecoration[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (start == null || end == null || end <= start) continue;
    const covering = ranges.filter((range) => range.start <= start && range.end >= end);
    if (covering.length === 0) continue;
    const threads = covering.map(({ id, thread }) => ({ id, thread }));
    decorations.push({
      start,
      end,
      render: (children) => <QuoteHighlight threads={threads}>{children}</QuoteHighlight>,
    });
  }
  return decorations;
}

export interface QuoteHighlightLayerProps {
  readonly text: string;
  /** The element id this field belongs to — half the durable-highlight scope key
   *  (finding 2): only threads targeting THIS element in THIS generation match, so a
   *  span repeated on another element/lens/generation is never fabricated. */
  readonly elementId: string;
  readonly patchsetId: string;
  readonly className?: string;
  readonly paragraphClassName?: string;
  readonly keywords?: boolean;
}

/**
 * Render board prose with durable quote highlights. When no thread is anchored on THIS
 * element in THIS generation, this is `RichText` verbatim. Matching anchors become
 * raw-source decorations on that same renderer, so highlighted and unhighlighted prose
 * use one token pipeline.
 *
 * Matching is scoped by `(elementId, generation)` — the protocol-shaped anchor identity
 * (`quote_target` + board generation, finding 2). Raw-range resolution only locates the
 * span after identity has narrowed the thread to this element; it never widens across
 * elements or generations.
 */
export function QuoteHighlightLayer({
  text,
  elementId,
  patchsetId,
  className,
  paragraphClassName,
  keywords,
}: QuoteHighlightLayerProps) {
  const quoteThreads = useRennetStore((s) => s.review.quoteThreads);
  const generation = useBoardGeneration();
  const matches: RangedThread[] = Object.entries(quoteThreads).flatMap(([id, thread]) => {
    if (thread.target !== elementId || thread.generation !== generation) return [];
    const range = anchorRange(text, thread.anchor);
    if (!range || /\n\n+/.test(text.slice(range.start, range.end))) return [];
    return [{ id, thread, ...range }];
  });

  if (matches.length === 0) {
    return (
      <RichText
        text={text}
        patchsetId={patchsetId}
        className={className}
        paragraphClassName={paragraphClassName}
        keywords={keywords}
      />
    );
  }

  return (
    <RichText
      text={text}
      patchsetId={patchsetId}
      className={className}
      paragraphClassName={paragraphClassName}
      keywords={keywords}
      decorations={decorationsFor(matches)}
    />
  );
}
