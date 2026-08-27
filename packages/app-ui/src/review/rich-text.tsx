import { cn } from "@rennet/ui";
import { Fragment, type ReactNode, useState } from "react";
import { lineRef } from "./citations";
import { CitationBlock } from "./code-tabs";
import { ReferenceChip } from "./reference-chip";

// ─────────────────────────────────────────────────────────────────────────────
// The R45 markdown subset, base tier (C4, reconciliation 6/7). "A deliberate markdown
// subset… not a general parser" — deliberately NOT react-markdown (reconciliation 5).
// Renders: bold (**text** → real <strong>, never literal asterisks), bulleted paragraphs
// (every line starting "- "), normative-grammar bolding (SHALL/MUST/WHEN/…), backticked
// terms as plain monospace (never boxed pills), and `path:line` citations as reference
// chips that reveal the cited span inline (click hydrates via the span-read seam, a
// second click folds). An unreadable citation is one honest line, never a silent skip.
//
// Does NOT port the spike's QuoteHighlight (durable highlight + tooltip + reply +
// overlap resolution): INVENTORY tags that block [ws:C5]. C5 wraps this component's
// output with the highlight layer when it lands.
// ─────────────────────────────────────────────────────────────────────────────

/** Matches a repo file citation like `packages/x/y.ts:244` or `y.ts:112-113`. */
const FILE_REF = /^[\w@./-]+\.[a-z]+:\d+(?:-\d+)?$/;
/** One tokenizer pass: backtick spans, or bare file:line(-line) citations. */
const TOKEN = /`[^`]+`|[\w@./-]+\.[a-z]+:\d+(?:-\d+)?/g;
/** Normative grammar (SHALL, WHEN/THEN, EARS keywords) for spec prose. */
const SPEC_KEYWORD = /\b(WHEN|THEN|AND|IF|WHILE|WHERE|SHALL NOT|SHALL|MUST NOT|MUST)\b/g;

/** Parse a `path:line(-line)` citation into its path and 1-based span. */
export function parseRef(ref: string): { path: string; startLine: number; endLine: number } {
  const colon = ref.lastIndexOf(":");
  const path = ref.slice(0, colon);
  const range = ref.slice(colon + 1);
  const dash = range.indexOf("-");
  const startLine = Number.parseInt(dash < 0 ? range : range.slice(0, dash), 10);
  const endLine = dash < 0 ? startLine : Number.parseInt(range.slice(dash + 1), 10);
  return { path, startLine, endLine };
}

export interface RichTextProps {
  readonly text: string;
  /** The captured patchset a `path:line` citation resolves against. */
  readonly patchsetId: string;
  readonly className?: string;
  readonly paragraphClassName?: string;
  /** Bold the normative spec grammar (SHALL, WHEN/THEN, EARS keywords). */
  readonly keywords?: boolean;
}

export function RichText({
  text,
  patchsetId,
  className,
  paragraphClassName,
  keywords = false,
}: RichTextProps) {
  const [activeRef, setActiveRef] = useState<string | null>(null);
  const paragraphs = text.split(/\n\n+/);

  function keywordNodes(chunk: string, keyBase: string): ReactNode[] {
    if (!keywords) return [chunk];
    // Odd split parts are the captured keyword; even parts are the surrounding text.
    // A regex split is a stable positional list, so the segment position is the key.
    return chunk.split(SPEC_KEYWORD).map((part, index) => {
      const key = `${keyBase}-kw-${index}`;
      return index % 2 === 1 ? (
        <span key={key} className="font-semibold tracking-tight text-foreground">
          {part}
        </span>
      ) : (
        <Fragment key={key}>{part}</Fragment>
      );
    });
  }

  // `**bold**` is the one markdown feature board prose carries (the bold-lead form);
  // anything richer stays out of the pipeline deliberately.
  function plainNodes(chunk: string, keyBase: string): ReactNode[] {
    const segments = chunk.split(/(\*\*[^*]+\*\*)/);
    if (segments.length === 1) return keywordNodes(chunk, keyBase);
    return segments.flatMap((segment, index) => {
      const key = `${keyBase}-b-${index}`;
      return segment.startsWith("**") && segment.endsWith("**") ? (
        <strong key={key} className="font-semibold text-foreground">
          {keywordNodes(segment.slice(2, -2), key)}
        </strong>
      ) : (
        keywordNodes(segment, key)
      );
    });
  }

  function renderTokens(segment: string, paragraphIndex: number, keyOffset: number): ReactNode[] {
    const nodes: ReactNode[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    TOKEN.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: the canonical single-pass regex tokenizer loop.
    while ((match = TOKEN.exec(segment)) !== null) {
      if (match.index > last)
        nodes.push(...plainNodes(segment.slice(last, match.index), `${keyOffset}-${last}`));
      const token = match[0];
      const inner = token.startsWith("`") ? token.slice(1, -1) : token;
      const isRef = FILE_REF.test(inner);
      const key = `${keyOffset}-${match.index}`;
      if (isRef) {
        const refKey = `${paragraphIndex}:${inner}`;
        const parsed = parseRef(inner);
        nodes.push(
          <ReferenceChip
            key={key}
            path={parsed.path}
            startLine={parsed.startLine}
            endLine={parsed.endLine}
            active={activeRef === refKey}
            title={inner}
            className="inline-block underline decoration-dotted underline-offset-2"
            onClick={() => setActiveRef((current) => (current === refKey ? null : refKey))}
          />,
        );
      } else if (token.startsWith("`")) {
        nodes.push(
          <code key={key} className="font-mono text-foreground">
            {inner}
          </code>,
        );
      } else {
        nodes.push(token);
      }
      last = match.index + token.length;
    }
    if (last < segment.length)
      nodes.push(...plainNodes(segment.slice(last), `${keyOffset}-${last}`));
    return nodes;
  }

  function renderParagraph(paragraph: string, paragraphIndex: number) {
    const activeInParagraph = activeRef?.startsWith(`${paragraphIndex}:`)
      ? activeRef.slice(activeRef.indexOf(":") + 1)
      : null;
    const reveal = activeInParagraph
      ? (() => {
          const parsed = parseRef(activeInParagraph);
          return (
            <CitationBlock
              citation={lineRef(patchsetId, parsed.path, parsed.startLine, parsed.endLine)}
            />
          );
        })()
      : null;

    // A block whose lines all start with "- " is a bulleted list; each line keeps the
    // full token pipeline (citations, code, bold, keywords).
    const lines = paragraph.split("\n");
    if (lines.length > 1 && lines.every((line) => line.startsWith("- "))) {
      return (
        <Fragment key={paragraphIndex}>
          <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground/60">
            {lines.map((line, lineIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: bullet lines are a fixed positional list.
              <li key={lineIndex} className={paragraphClassName}>
                {renderTokens(line.slice(2), paragraphIndex, lineIndex * 100000)}
              </li>
            ))}
          </ul>
          {reveal}
        </Fragment>
      );
    }

    return (
      <Fragment key={paragraphIndex}>
        <p className={paragraphClassName}>{renderTokens(paragraph, paragraphIndex, 0)}</p>
        {reveal}
      </Fragment>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>{paragraphs.map(renderParagraph)}</div>
  );
}
