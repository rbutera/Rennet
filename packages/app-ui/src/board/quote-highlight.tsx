import { cn } from "@rennet/ui";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAnchoredAsk } from "../review/anchored-ask";
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
  const askFailures = useRennetStore((s) => s.review.quoteAskFailures);
  const sendAnchoredAsk = useAnchoredAsk();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <span className="absolute bottom-full left-0 z-50 mb-1.5 block w-[360px] cursor-auto rounded-md border border-border bg-popover p-2.5 font-sans not-italic shadow-lg">
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
                  "block text-12-5 leading-relaxed",
                  message.author === "user"
                    ? "self-end max-w-[280px] rounded-lg bg-secondary px-2.5 py-1.5 text-foreground/95"
                    : "text-foreground/85",
                )}
              >
                {message.text}
              </span>
            ))}
          </span>
          {askFailures[id] === undefined ? null : (
            // The retraction. Every call site appends the reviewer's message and clears the
            // draft box BEFORE the send, so a failed ask leaves their question sitting in the
            // thread looking exactly like one that landed — the reviewer's own words used as
            // false evidence of delivery (#888). This says it did not go, and prints the
            // daemon's reason verbatim (`board-view.tsx`'s `board-failed` shape).
            //
            // A `<span>` with `role="alert"`, not a `<p>`: this stack renders inside a `<p>`
            // and a nested block element is invalid there. `role="alert"` is deliberate and
            // is what the `t3-chat-*` slots lack — a dropped question is not a muted notice,
            // and a reviewer who has already looked away needs it announced.
            <span
              data-slot="quote-ask-failed"
              role="alert"
              className="mb-1.5 block text-2xs leading-relaxed text-destructive"
            >
              <span className="block font-medium">This question was not sent.</span>
              <span className="block text-destructive/85">{askFailures[id]}</span>
            </span>
          )}
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
                void sendAnchoredAsk?.({
                  threadId: id,
                  question: text,
                  excerpt: thread.anchor,
                  ...(thread.target === undefined ? {} : { target: thread.target }),
                  ...(thread.generation === undefined ? {} : { generation: thread.generation }),
                });
              }
            }}
            placeholder="Reply…"
            rows={1}
            className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-12-5 leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
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
            : "bg-green/20 shadow-green/70 hover:bg-green/30",
          open && (explainOnly ? "bg-muted-foreground/25" : "bg-green/35"),
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

type AnchorLocator = (text: string, anchor: string) => RawTextRange | null;

function sameScope(a: readonly KeyedThread[], b: readonly KeyedThread[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]?.id && x.thread === b[i]?.thread);
}

/**
 * The threads anchored on THIS element in THIS generation, with a stable identity.
 *
 * A quote-thread write replaces the whole `quoteThreads` record, so every element on the
 * board recomputes its scope — but the scope of an element no thread just changed is
 * element-wise identical, and returning the previous array is what lets the range
 * derivation below (and the decorations built from it) skip (perf audit §5 H3: one thread
 * opened re-scanned ~700 elements). Thread objects are replaced on write, so a reply to a
 * thread THIS element carries does break the identity, and the popover updates.
 */
function useScopedThreads(elementId: string, generation: string): readonly KeyedThread[] {
  const quoteThreads = useRennetStore((s) => s.review.quoteThreads);
  const next = useMemo(
    () =>
      Object.entries(quoteThreads).flatMap(([id, thread]) =>
        thread.lifecycle === "detached" ||
        thread.target !== elementId ||
        thread.generation !== generation
          ? []
          : [{ id, thread }],
      ),
    [quoteThreads, elementId, generation],
  );
  const held = useRef(next);
  if (held.current !== next && !sameScope(held.current, next)) held.current = next;
  return held.current;
}

/** Locate each scoped thread's anchor in `text`. Exported for the perf test, which counts
 *  `locate` calls to prove an unrelated thread write does not re-derive this element. */
export function useRangedThreads(
  text: string,
  elementId: string,
  locate: AnchorLocator,
): readonly RangedThread[] {
  const generation = useBoardGeneration();
  const scoped = useScopedThreads(elementId, generation);
  return useMemo(
    () =>
      scoped.flatMap(({ id, thread }) => {
        const range = locate(text, thread.anchor);
        if (!range || /\n\n+/.test(text.slice(range.start, range.end))) return [];
        return [{ id, thread, ...range }];
      }),
    [scoped, text, locate],
  );
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

function decoratedPlainText(text: string, decorations: readonly RichTextDecoration[]): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const decoration of decorations) {
    if (decoration.start > cursor) {
      nodes.push(
        <Fragment key={`plain-${cursor}-${decoration.start}`}>
          {text.slice(cursor, decoration.start)}
        </Fragment>,
      );
    }
    nodes.push(
      <Fragment key={`quote-${decoration.start}-${decoration.end}`}>
        {decoration.render(text.slice(decoration.start, decoration.end))}
      </Fragment>,
    );
    cursor = decoration.end;
  }
  if (cursor < text.length) {
    nodes.push(<Fragment key={`plain-${cursor}-${text.length}`}>{text.slice(cursor)}</Fragment>);
  }
  return nodes;
}

export interface InlineQuoteHighlightProps {
  readonly text: string;
  readonly elementId: string;
  readonly className?: string;
  readonly onActivate?: () => void;
  readonly ariaLabel?: string;
  readonly ariaExpanded?: boolean;
}

/** Render a plain-text board field with the same durable scope and thread UI as prose. */
export function InlineQuoteHighlight({
  text,
  elementId,
  className,
  onActivate,
  ariaLabel,
  ariaExpanded,
}: InlineQuoteHighlightProps) {
  const matches = useRangedThreads(text, elementId, uniqueRawRange);
  const decorations = useMemo(() => decorationsFor(matches), [matches]);
  const interactive = onActivate !== undefined;
  return (
    <span
      data-quote-target={elementId}
      className={className}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": ariaLabel,
            "aria-expanded": ariaExpanded,
            onClick: (event: ReactMouseEvent<HTMLSpanElement>) => {
              if (event.target !== event.currentTarget) return;
              onActivate?.();
            },
            onKeyDown: (event: ReactKeyboardEvent<HTMLSpanElement>) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivate?.();
              }
            },
          }
        : {})}
    >
      {matches.length === 0 ? text : decoratedPlainText(text, decorations)}
    </span>
  );
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
  const matches = useRangedThreads(text, elementId, anchorRange);
  // Stable while the scope is: `RichText` memoizes its whole segmentation on this array.
  const decorations = useMemo(() => decorationsFor(matches), [matches]);
  return (
    <div data-quote-target={elementId} className="contents">
      {matches.length === 0 ? (
        <RichText
          text={text}
          patchsetId={patchsetId}
          className={className}
          paragraphClassName={paragraphClassName}
          keywords={keywords}
        />
      ) : (
        <RichText
          text={text}
          patchsetId={patchsetId}
          className={className}
          paragraphClassName={paragraphClassName}
          keywords={keywords}
          decorations={decorations}
        />
      )}
    </div>
  );
}
