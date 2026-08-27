import { cn } from "@rennet/ui";
import { Check, Copy, FileCode, MessageSquare, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Icon } from "../components/icon";
import { useFlightBatcher } from "../handoff/exit-flight";
import { selectCodeComments, useRennetStore } from "../store";
import { detectLanguage, tokenizeDiffLine } from "../syntax/shiki";
import { LineCommentEditor } from "./line-comment-editor";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE code surface (C4): every code appearance in the product renders through here.
// Two load-bearing decisions: tokenization is SYNCHRONOUS (the existing syntax/shiki.ts —
// no async load, no skeleton, reconciliation 3), and comments/asks read and write the
// `review` slice DIRECTLY (no provider shim, no `store?.` guard — reconciliation 8).
// Header-path navigation is host-supplied via `onOpenPath` (routing is a C5–C9 surface
// concern, not this component's — same seam shape as `counterpart`).
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeBlockProps {
  /** The source lines to render (newline-joined). */
  readonly code: string;
  /** File path — the header label and the language source (inferred by extension). */
  readonly path: string;
  /** Absolute line number of the first line, for a slice of a larger file. */
  readonly startLine?: number;
  /** Absolute line numbers to call out as the lines under discussion (evidence green). */
  readonly highlightLines?: readonly number[];
  /**
   * The impl↔test counterpart jump (R41, #492) — the SAME shape CodeView already
   * ships (`{ label, path, onView() }`), rendered right of Copy. Absent ⇒ no button.
   */
  readonly counterpart?: {
    readonly label: string;
    readonly path: string;
    onView(): void;
  };
  /**
   * Host-supplied header-path navigation (the Diff-view jump the docs promise). When
   * set, the header path is a button that calls this with the file path; absent ⇒ inert
   * label. Routing lives in the C5–C9 surface, not here — same pattern as `counterpart`.
   */
  readonly onOpenPath?: (path: string) => void;
  readonly className?: string;
}

export function CodeBlock({
  code,
  path,
  startLine = 1,
  highlightLines,
  counterpart,
  onOpenPath,
  className,
}: CodeBlockProps) {
  const comments = useRennetStore(selectCodeComments(path));
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const { setCodeComment, clearCodeComment, stageAsk } = useRennetStore((s) => s.reviewActions);
  const flight = useFlightBatcher();

  const [copied, setCopied] = useState(false);
  const [openLine, setOpenLine] = useState<number | null>(null);

  const language = useMemo(() => detectLanguage(path), [path]);
  const tokenLines = useMemo(
    () => code.split("\n").map((line) => tokenizeDiffLine(line, language)),
    [code, language],
  );
  const highlightSet = useMemo(() => new Set(highlightLines ?? []), [highlightLines]);
  // Lines with a staged request-change ask (anchor `${path}:${line}`) read danger red.
  const askLines = useMemo(() => {
    const lines = new Set<number>();
    for (const [anchor, ask] of Object.entries(stagedAsks)) {
      if (ask.type !== "request-change") continue;
      const colon = anchor.lastIndexOf(":");
      if (colon < 0 || anchor.slice(0, colon) !== path) continue;
      const line = Number.parseInt(anchor.slice(colon + 1), 10);
      if (!Number.isNaN(line)) lines.add(line);
    }
    return lines;
  }, [stagedAsks, path]);

  const lineCount = tokenLines.length;
  const endLine = startLine + lineCount - 1;
  const gutterChars = String(endLine).length + 1;

  async function handleCopy() {
    // Silent no-op when the clipboard API is unavailable (insecure context, denied).
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Copy simply does nothing on failure — never a thrown render.
    }
  }

  return (
    <div
      className={cn(
        "w-full max-w-[640px] overflow-hidden rounded-lg border border-border bg-card [container-type:inline-size]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary/50 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon icon={FileCode} className="size-3.5 shrink-0 text-muted-foreground" />
          {onOpenPath ? (
            <button
              type="button"
              title={path}
              onClick={() => onOpenPath(path)}
              className="truncate font-mono text-2xs text-foreground/80 hover:text-foreground hover:underline"
            >
              {path}
            </button>
          ) : (
            <span title={path} className="truncate font-mono text-2xs text-foreground/80">
              {path}
            </span>
          )}
          <span className="shrink-0 text-2xs text-muted-foreground">
            {lineCount > 1 ? `L${startLine}–${endLine}` : `L${startLine}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Icon icon={copied ? Check : Copy} className="size-3" />
            {copied ? "Copied" : "Copy"}
          </button>
          {counterpart ? (
            <button
              type="button"
              onClick={() => counterpart.onView()}
              title={`Go to ${counterpart.path}`}
              className="rounded-full border border-accent-line bg-accent-soft px-3 py-1 text-2xs text-accent transition-colors hover:bg-accent-surface"
            >
              {counterpart.label}
            </button>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-max py-1.5 font-mono text-xs leading-[1.7]">
          {tokenLines.map((lineTokens, i) => {
            const lineNumber = startLine + i;
            const isHighlighted = highlightSet.has(lineNumber);
            const hasComment = comments?.[lineNumber] != null;
            const hasAsk = askLines.has(lineNumber);
            const isOpen = openLine === lineNumber;
            const state = hasAsk
              ? "ask"
              : hasComment
                ? "comment"
                : isHighlighted
                  ? "cited"
                  : "plain";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are a fixed positional list; the index is the line offset.
              <div key={i}>
                <div
                  data-line={lineNumber}
                  data-line-state={state}
                  className={cn(
                    "group flex min-h-[1.7em]",
                    hasAsk
                      ? "bg-destructive/25"
                      : (isHighlighted || hasComment || isOpen) && "bg-green/15",
                  )}
                >
                  <span
                    className={cn(
                      "sticky left-0 flex shrink-0 select-none items-center justify-end gap-1 border-r px-2.5 text-muted-foreground/50",
                      hasAsk
                        ? "border-destructive/60 bg-destructive/25"
                        : isHighlighted || hasComment || isOpen
                          ? "border-green/50 bg-green/15"
                          : "border-transparent bg-card",
                    )}
                    style={{ minWidth: `${gutterChars}ch` }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenLine(isOpen ? null : lineNumber)}
                      aria-label={
                        hasComment
                          ? `Edit comment on line ${lineNumber}`
                          : `Comment on line ${lineNumber}`
                      }
                      title={
                        hasComment
                          ? `Edit comment on line ${lineNumber}`
                          : `Comment on line ${lineNumber}`
                      }
                      className={cn(
                        "size-4 shrink-0 items-center justify-center rounded transition-colors",
                        hasAsk
                          ? "flex bg-destructive text-primary-foreground hover:bg-destructive/90"
                          : hasComment || isOpen
                            ? "flex bg-primary text-primary-foreground hover:bg-primary/90"
                            : "hidden bg-primary text-primary-foreground hover:bg-primary/90 group-hover:flex",
                      )}
                    >
                      <Icon
                        icon={hasComment ? MessageSquare : Plus}
                        className={hasComment ? "size-2.5" : "size-3"}
                      />
                    </button>
                    <span
                      className={cn("tabular-nums", !hasComment && !isOpen && "group-hover:hidden")}
                    >
                      {lineNumber}
                    </span>
                  </span>
                  <span className="whitespace-pre px-3 text-foreground/90">
                    {lineTokens.length === 0
                      ? " "
                      : lineTokens.map((token, ti) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: token order within a line is stable and positional.
                          <span key={ti} className={`rtok rtok-${token.type}`}>
                            {token.text}
                          </span>
                        ))}
                  </span>
                </div>
                {isOpen && (
                  <div className="sticky left-0 w-[100cqw] border-y border-border bg-secondary/40 px-3 py-2.5 font-sans">
                    <LineCommentEditor
                      lineLabel={`L${lineNumber}`}
                      initialText={comments?.[lineNumber] ?? ""}
                      hasComment={hasComment}
                      onCancel={() => setOpenLine(null)}
                      onSave={(text) => {
                        if (text === null) clearCodeComment(path, lineNumber);
                        else setCodeComment(path, lineNumber, text);
                        setOpenLine(null);
                      }}
                      onRequestChanges={(text) => {
                        // A code line is a real diff position: the comment saves AND a
                        // request-change ask stages against `${path}:${line}` (R36).
                        setCodeComment(path, lineNumber, text);
                        stageAsk({
                          anchor: `${path}:${lineNumber}`,
                          type: "request-change",
                          body: text,
                        });
                        flight.signal(); // the staging act flies one bubble to the FAB
                        setOpenLine(null);
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
