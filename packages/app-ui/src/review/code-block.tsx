import type { CodeRef } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { Check, Copy, FileCode, MessageSquare, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Icon } from "../components/icon";
import { useFlightBatcher } from "../handoff/exit-flight";
import {
  codePositionKey,
  selectCodeComments,
  stagedAskCodePosition,
  useRennetStore,
} from "../store";
import { detectLanguage, tokenizeDiffLine } from "../syntax/shiki";
import { useCodeDestination } from "./code-destination";
import type { NumberedLine } from "./diff-parse";
import { LineCommentEditor } from "./line-comment-editor";
import { QuoteThreadPopover } from "./quote-thread-popover";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE code surface (C4): every code appearance in the product renders through here.
// Two load-bearing decisions: tokenization is SYNCHRONOUS (the existing syntax/shiki.ts —
// no async load, no skeleton, reconciliation 3), and comments/asks read and write the
// `review` slice DIRECTLY (no provider shim, no `store?.` guard — reconciliation 8).
// Header navigation comes from the route-scoped code destination. Explicit props can
// replace or suppress those defaults for tests and special callers.
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeBlockProps {
  /** The source lines to render (newline-joined). */
  readonly code: string;
  readonly rows?: readonly NumberedLine[];
  readonly previousPath?: string;
  /** File path — the header label and the language source (inferred by extension). */
  readonly path: string;
  /** Absolute line number of the first line, for a slice of a larger file. */
  readonly startLine?: number;
  /** Absolute line numbers to call out as the lines under discussion (evidence green). */
  readonly highlightLines?: readonly number[];
  /** Captured patchset identity when this block came from a citation. */
  readonly patchsetId?: string;
  /** The diff image this block renders. Code without explicit provenance defaults RIGHT. */
  readonly side?: "LEFT" | "RIGHT";
  /**
   * The impl↔test counterpart jump (R41, #492), rendered right of Copy. `undefined`
   * uses the route provider, a value overrides it, and `null` suppresses it.
   */
  readonly counterpart?: {
    readonly label: string;
    readonly path: string;
    onView(): void;
  } | null;
  /**
   * Header-path navigation for the Diff jump. `undefined` uses the route provider, a
   * function overrides it, and `null` keeps the path inert.
   */
  readonly onOpenPath?: ((path: string) => void) | null;
  readonly className?: string;
}

export function CodeBlock({
  code,
  rows,
  previousPath,
  path,
  startLine = 1,
  highlightLines,
  patchsetId,
  side = "RIGHT",
  counterpart,
  onOpenPath,
  className,
}: CodeBlockProps) {
  const destination = useCodeDestination(path);
  const resolvedOpenPath =
    onOpenPath === undefined ? destination.onOpenPath : (onOpenPath ?? undefined);
  const resolvedCounterpart =
    counterpart === undefined ? destination.counterpart : (counterpart ?? undefined);
  const comments = useRennetStore(selectCodeComments(path));
  const quoteThreads = useRennetStore((s) => s.review.quoteThreads);
  const codeThreads = useMemo(
    () =>
      Object.entries(quoteThreads).flatMap(([id, thread]) =>
        thread.codeRef !== undefined &&
        thread.codeRef.patchsetId === patchsetId &&
        (thread.codeRef?.path === path || thread.codeRef?.path === previousPath)
          ? [{ id, thread }]
          : [],
      ),
    [quoteThreads, patchsetId, path, previousPath],
  );
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const {
    setCodeComment,
    clearCodeComment,
    stageAsk,
    addQuoteComment,
    addQuoteReply,
    removeQuoteComment,
  } = useRennetStore((s) => s.reviewActions);
  const flight = useFlightBatcher();

  const [copied, setCopied] = useState(false);
  const [openLine, setOpenLine] = useState<number | null>(null);

  const language = useMemo(() => detectLanguage(path), [path]);
  const tokenLines = useMemo(
    () =>
      (rows?.map((row) => row.text) ?? code.split("\n")).map((line) =>
        tokenizeDiffLine(line, language),
      ),
    [code, rows, language],
  );
  const highlightSet = useMemo(() => new Set(highlightLines ?? []), [highlightLines]);
  // Lines with a staged request-change ask at this exact side-qualified position read red.
  const askLines = useMemo(() => {
    const lines = new Set<number>();
    for (const ask of Object.values(stagedAsks)) {
      if (ask.type !== "request-change") continue;
      if (ask.codeRef !== undefined && ask.codeRef.patchsetId !== patchsetId) continue;
      const position = stagedAskCodePosition(ask);
      if (position?.path === path && position.side === side) lines.add(position.line);
    }
    return lines;
  }, [stagedAsks, patchsetId, path, side]);

  const lineCount = tokenLines.length;
  const endLine = rows?.at(-1)?.newLine ?? rows?.at(-1)?.oldLine ?? startLine + lineCount - 1;
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
          {resolvedOpenPath ? (
            <button
              type="button"
              title={path}
              onClick={() => resolvedOpenPath(path)}
              className="truncate font-mono text-foreground/80 text-xs underline-offset-2 transition-colors hover:text-foreground hover:underline hover:decoration-dotted"
            >
              {path}
            </button>
          ) : (
            <span title={path} className="truncate font-mono text-foreground/80 text-xs">
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
          {resolvedCounterpart ? (
            <button
              type="button"
              onClick={() => resolvedCounterpart.onView()}
              title={`Go to ${resolvedCounterpart.path}`}
              className="rounded-full border border-accent-line bg-accent-soft px-3 py-1 text-2xs text-accent transition-colors hover:bg-accent-surface"
            >
              {resolvedCounterpart.label}
            </button>
          ) : null}
        </div>
      </div>

      <div data-code-scroll className="overflow-x-auto">
        <div className="min-w-max py-1.5 font-mono text-12-5 leading-[1.7]">
          {tokenLines.map((lineTokens, i) => {
            const row = rows?.[i];
            const rowSide = row?.newLine === null ? "LEFT" : row ? "RIGHT" : side;
            const rowPath = rowSide === "LEFT" ? (previousPath ?? path) : path;
            const lineNumber = row?.newLine ?? row?.oldLine ?? startLine + i;
            const rowRef: CodeRef | undefined =
              patchsetId === undefined
                ? undefined
                : {
                    patchsetId,
                    path: rowPath,
                    side: rowSide === "LEFT" ? "base" : "head",
                    startLine: lineNumber,
                    endLine: lineNumber,
                  };
            const isHighlighted = highlightSet.has(lineNumber);
            const hasComment =
              (rowSide === "RIGHT" && comments?.[lineNumber] != null) ||
              Object.values(quoteThreads).some((thread) => {
                const ref = thread.codeRef;
                return (
                  ref !== undefined &&
                  ref.patchsetId === patchsetId &&
                  ref.path === rowPath &&
                  ref.side === (rowSide === "LEFT" ? "base" : "head") &&
                  ref.startLine <= lineNumber &&
                  ref.endLine >= lineNumber
                );
              });
            const hasAsk = row
              ? Object.values(stagedAsks).some((ask) => {
                  const ref = ask.codeRef;
                  return (
                    ask.type === "request-change" &&
                    ref !== undefined &&
                    ref.patchsetId === patchsetId &&
                    ref.path === rowPath &&
                    ref.side === (rowSide === "LEFT" ? "base" : "head") &&
                    ref.startLine <= lineNumber &&
                    ref.endLine >= lineNumber
                  );
                })
              : askLines.has(lineNumber);
            const existingThread = codeThreads.find(({ thread }) => {
              const ref = thread.codeRef;
              return (
                ref !== undefined &&
                ref.path === rowPath &&
                ref.side === (rowSide === "LEFT" ? "base" : "head") &&
                ref.startLine <= lineNumber &&
                ref.endLine >= lineNumber
              );
            });
            const isOpen = openLine === i;
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
                  data-diff-kind={row?.type}
                  data-line-state={state}
                  className={cn(
                    "group flex min-h-[1.7em]",
                    row?.type === "add" && "bg-add",
                    row?.type === "del" && "bg-del",
                    hasAsk
                      ? "bg-destructive/25"
                      : isHighlighted
                        ? "bg-green/15"
                        : (hasComment || isOpen) && "bg-blue/15",
                  )}
                >
                  <span
                    className={cn(
                      "sticky left-0 flex shrink-0 select-none items-center justify-end gap-1 border-r px-2.5 text-muted-foreground/50",
                      hasAsk
                        ? "border-destructive/60 bg-destructive/25"
                        : isHighlighted || hasComment || isOpen
                          ? "border-blue/50 bg-blue/15"
                          : "border-transparent bg-card",
                    )}
                    style={{ minWidth: `${gutterChars}ch` }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenLine(isOpen ? null : i)}
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
                          ? "flex bg-destructive text-on-danger hover:bg-destructive/90"
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
                      {row ? (
                        <>
                          <span className="inline-block w-8">{row.oldLine ?? ""}</span>
                          <span className="inline-block w-8">{row.newLine ?? ""}</span>
                        </>
                      ) : (
                        lineNumber
                      )}
                    </span>
                  </span>
                  {row && (
                    <span aria-hidden="true" className="w-4 shrink-0 select-none text-center">
                      {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
                    </span>
                  )}
                  <span
                    data-code-patchset={patchsetId}
                    data-code-path={rowPath}
                    data-code-side={rowSide === "LEFT" ? "base" : "head"}
                    data-code-line={lineNumber}
                    className="whitespace-pre px-3 text-foreground/90"
                  >
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
                      initialText={
                        existingThread?.thread.messages.at(-1)?.text ?? comments?.[lineNumber] ?? ""
                      }
                      hasComment={hasComment}
                      onCancel={() => setOpenLine(null)}
                      onSave={(text) => {
                        if (existingThread) {
                          if (text === null) removeQuoteComment(existingThread.id);
                          else addQuoteReply(existingThread.id, "user", text);
                        } else if (text === null) clearCodeComment(path, lineNumber);
                        else if (rowRef)
                          addQuoteComment(
                            `${rowPath}:${lineNumber}`,
                            text,
                            "comment",
                            undefined,
                            rowRef,
                          );
                        else setCodeComment(path, lineNumber, text);
                        setOpenLine(null);
                      }}
                      onRequestChanges={(text) => {
                        // A code line is a real diff position: the comment saves AND a
                        // request-change ask stages against `${path}:${line}` (R36).
                        if (!rowRef) setCodeComment(path, lineNumber, text);
                        const position = { path: rowPath, line: lineNumber, side: rowSide };
                        const codeRef: CodeRef | undefined = rowRef;
                        stageAsk({
                          id: codePositionKey(position),
                          anchor: `${rowPath}:${lineNumber}`,
                          type: "request-change",
                          body: text,
                          side: rowSide,
                          ...(codeRef === undefined ? {} : { codeRef }),
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
      {codeThreads.length > 0 && (
        <div className="border-t border-border p-2">
          <QuoteThreadPopover inline threads={codeThreads} />
        </div>
      )}
    </div>
  );
}
