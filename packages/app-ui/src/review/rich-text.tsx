import { cn } from "@rennet/ui";
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { basename } from "../canvas/symbol";
import { lineRef } from "./citations";
import { CitationBlock } from "./code-tabs";

// ─────────────────────────────────────────────────────────────────────────────
// The R45 markdown subset, base tier (C4, reconciliation 6/7): a DELIBERATE subset, not
// a general parser — deliberately NOT react-markdown (reconciliation 5). Citations
// hydrate inline through the span-read seam. Durable quote highlights reuse this same
// token pipeline through raw-source decorations instead of flattening rendered prose.
// ─────────────────────────────────────────────────────────────────────────────

export const CitationAutolinkContext = createContext(true);

/** Matches a repo file citation like `packages/x/y.ts:244` or `y.ts:112-113`. */
const FILE_REF = /^[\w@./-]+\.[a-z]+:\d+(?:-\d+)?$/;
/** One tokenizer pass: backtick spans, or bare file:line(-line) citations. */
const TOKEN = /`[^`]+`|[\w@./-]+\.[a-z]+:\d+(?:-\d+)?/g;
/** The one markdown container this renderer supports. */
const BOLD = /\*\*[^*]+\*\*/g;
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

export interface RawTextRange {
  readonly start: number;
  readonly end: number;
}

/** A non-overlapping raw-source range whose children need an inline wrapper. */
export interface RichTextDecoration extends RawTextRange {
  readonly render: (children: ReactNode) => ReactNode;
}

type InlineSegmentKind = "text" | "code" | "citation";

interface InlineSegment extends RawTextRange {
  readonly kind: InlineSegmentKind;
  readonly display: string;
  /** Plain text, code contents, or the full citation path and line range. */
  readonly value: string;
  readonly bold: boolean;
}

function citationLabel(ref: string): string {
  const slash = ref.lastIndexOf("/");
  return slash < 0 ? ref : ref.slice(slash + 1);
}

function tokenizeSegment(
  text: string,
  offset: number,
  bold: boolean,
  autolink: boolean,
): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index;
    if (index > last) {
      const value = text.slice(last, index);
      segments.push({
        kind: "text",
        start: offset + last,
        end: offset + index,
        display: value,
        value,
        bold,
      });
    }

    const token = match[0];
    const inner = token.startsWith("`") ? token.slice(1, -1) : token;
    const citation = autolink && FILE_REF.test(inner);
    segments.push({
      kind: citation ? "citation" : token.startsWith("`") ? "code" : "text",
      start: offset + index,
      end: offset + index + token.length,
      display: citation ? citationLabel(inner) : inner,
      value: inner,
      bold,
    });
    last = index + token.length;
  }

  if (last < text.length) {
    const value = text.slice(last);
    segments.push({
      kind: "text",
      start: offset + last,
      end: offset + text.length,
      display: value,
      value,
      bold,
    });
  }
  return segments;
}

/** Tokenize raw board prose into the exact text the browser displays and its source span. */
function inlineSegments(rawText: string, offset = 0, autolink = true): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of rawText.matchAll(BOLD)) {
    const index = match.index;
    if (index > last) {
      segments.push(...tokenizeSegment(rawText.slice(last, index), offset + last, false, autolink));
    }
    const token = match[0];
    segments.push(...tokenizeSegment(token.slice(2, -2), offset + index + 2, true, autolink));
    last = index + token.length;
  }
  if (last < rawText.length) {
    segments.push(...tokenizeSegment(rawText.slice(last), offset + last, false, autolink));
  }
  return segments;
}

/**
 * Map one unique display-text quote back to raw board prose. Code and citation display
 * labels snap to their whole raw token; ordinary and bold text keep exact offsets.
 * Duplicate display matches and absent text return null rather than guessing.
 */
export function displayToRawRange(
  rawText: string,
  displayQuote: string,
  autolink = true,
): RawTextRange | null {
  if (displayQuote.length === 0) return null;

  let displayText = "";
  const segments = inlineSegments(rawText, 0, autolink).map((segment) => {
    const displayStart = displayText.length;
    displayText += segment.display;
    return { ...segment, displayStart, displayEnd: displayText.length };
  });
  const displayStart = displayText.indexOf(displayQuote);
  if (displayStart < 0 || displayText.indexOf(displayQuote, displayStart + 1) >= 0) return null;

  const displayEnd = displayStart + displayQuote.length;
  const first = segments.find(
    (segment) => displayStart >= segment.displayStart && displayStart < segment.displayEnd,
  );
  const last = segments.find(
    (segment) => displayEnd > segment.displayStart && displayEnd <= segment.displayEnd,
  );
  if (!first || !last) return null;

  return {
    start: first.kind === "text" ? first.start + (displayStart - first.displayStart) : first.start,
    end: last.kind === "text" ? last.start + (displayEnd - last.displayStart) : last.end,
  };
}

interface ParagraphSource {
  readonly text: string;
  readonly start: number;
}

type TextBlock =
  | { readonly kind: "paragraph"; readonly source: ParagraphSource }
  | { readonly kind: "list"; readonly items: ParagraphSource[] };

function splitBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let offset = 0;
  let current: TextBlock | undefined;
  for (const line of text.split("\n")) {
    const bullet = /^[-*+] +/.exec(line);
    if (!line.trim()) {
      current = undefined;
    } else if (bullet) {
      if (current?.kind !== "list") {
        current = { kind: "list", items: [] };
        blocks.push(current);
      }
      current.items.push({ text: line.slice(bullet[0].length), start: offset + bullet[0].length });
    } else if (current?.kind === "list" && /^ {2,}\S/.test(line)) {
      const last = current.items.at(-1);
      if (last)
        current.items[current.items.length - 1] = { ...last, text: `${last.text}\n${line}` };
    } else if (current?.kind === "paragraph") {
      const source = { ...current.source, text: `${current.source.text}\n${line}` };
      current = { kind: "paragraph", source };
      blocks[blocks.length - 1] = current;
    } else {
      current = { kind: "paragraph", source: { text: line, start: offset } };
      blocks.push(current);
    }
    offset += line.length + 1;
  }
  return blocks;
}

export interface RichTextProps {
  readonly text: string;
  /** The captured patchset a `path:line` citation resolves against. */
  readonly patchsetId: string;
  readonly className?: string;
  readonly paragraphClassName?: string;
  /** Bold the normative spec grammar (SHALL, WHEN/THEN, EARS keywords). */
  readonly keywords?: boolean;
  /** Non-overlapping raw-source ranges rendered through the normal token pipeline. */
  readonly decorations?: readonly RichTextDecoration[];
}

/** One shared empty list, so an undecorated `RichText` keeps a stable `decorations`
 *  identity and its segmentation memo survives its parent's re-renders. */
const NO_DECORATIONS: readonly RichTextDecoration[] = [];

export function RichText({
  text,
  patchsetId,
  className,
  paragraphClassName,
  keywords = false,
  decorations = NO_DECORATIONS,
}: RichTextProps) {
  const autolink = useContext(CitationAutolinkContext);
  const [activeRef, setActiveRef] = useState<string | null>(null);
  // The revealed citation is keyed by paragraph index + ref; when the prose or the
  // patchset it resolves against changes, that identity is stale — drop it so an old
  // citation can never render below unrelated replacement text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text/patchsetId/autolink are the invalidation keys; activeRef is intentionally reset, not a dep.
  useEffect(() => setActiveRef(null), [text, patchsetId, autolink]);

  // Tokenizing the prose and building its node tree is the per-element cost a big board
  // pays ~700 times (perf audit §5 H4), and it used to run in the render body — so any
  // store write anywhere re-parsed every element on the board. It depends on nothing but
  // the props and the revealed citation, so it is memoized whole.
  const body = useMemo(() => {
    const blocks = splitBlocks(text);

    function decorationFor(start: number, end: number): RichTextDecoration | undefined {
      return decorations.find((decoration) => decoration.start <= start && decoration.end >= end);
    }

    function decorate(children: ReactNode, start: number, end: number, key: string): ReactNode {
      const decoration = decorationFor(start, end);
      return <Fragment key={key}>{decoration ? decoration.render(children) : children}</Fragment>;
    }

    function formatText(value: string, bold: boolean, keyword: boolean): ReactNode {
      let node: ReactNode = value;
      if (keyword) {
        node = <span className="font-semibold tracking-tight text-foreground">{node}</span>;
      }
      if (bold) node = <strong className="font-semibold text-foreground">{node}</strong>;
      return node;
    }

    function renderTextRun(
      value: string,
      start: number,
      bold: boolean,
      keyword: boolean,
    ): ReactNode[] {
      const end = start + value.length;
      const points = [
        ...new Set([
          start,
          end,
          ...decorations.flatMap((decoration) => [decoration.start, decoration.end]),
        ]),
      ]
        .filter((point) => point >= start && point <= end)
        .sort((a, b) => a - b);

      const nodes: ReactNode[] = [];
      for (let index = 0; index < points.length - 1; index++) {
        const partStart = points[index];
        const partEnd = points[index + 1];
        if (partStart == null || partEnd == null || partEnd <= partStart) continue;
        const part = value.slice(partStart - start, partEnd - start);
        nodes.push(
          decorate(formatText(part, bold, keyword), partStart, partEnd, `${partStart}:${partEnd}`),
        );
      }
      return nodes;
    }

    function renderTextSegment(segment: InlineSegment): ReactNode[] {
      if (!keywords) return renderTextRun(segment.value, segment.start, segment.bold, false);

      const nodes: ReactNode[] = [];
      let last = 0;
      for (const match of segment.value.matchAll(SPEC_KEYWORD)) {
        const index = match.index;
        if (index > last) {
          nodes.push(
            ...renderTextRun(
              segment.value.slice(last, index),
              segment.start + last,
              segment.bold,
              false,
            ),
          );
        }
        nodes.push(...renderTextRun(match[0], segment.start + index, segment.bold, true));
        last = index + match[0].length;
      }
      if (last < segment.value.length) {
        nodes.push(
          ...renderTextRun(segment.value.slice(last), segment.start + last, segment.bold, false),
        );
      }
      return nodes;
    }

    function renderTokenSegment(segment: InlineSegment, paragraphIndex: number): ReactNode {
      let node: ReactNode;
      if (segment.kind === "citation") {
        const refId = `${paragraphIndex}:${segment.value}`;
        const parsed = parseRef(segment.value);
        // Inline and borderless: a citation is a word in the sentence, and a bordered chip
        // broke the line it sat in (prototype `rich-text.tsx:298-301`). The prototype sizes
        // this em-relative (0.86em) so it tracks whatever prose holds it; the design ramp
        // admits no arbitrary bracketed size, so this takes the nearest ramp step below the
        // 14px body — and does NOT shrink with a smaller run the way the prototype's does.
        node = (
          <button
            type="button"
            aria-pressed={activeRef === refId}
            title={segment.value}
            onClick={() => setActiveRef((current) => (current === refId ? null : refId))}
            className={cn(
              "rounded bg-secondary/60 px-1 py-px font-mono text-xs underline decoration-dotted underline-offset-2 transition-colors",
              activeRef === refId
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {basename(parsed.path)}:
            {parsed.endLine !== parsed.startLine
              ? `${parsed.startLine}-${parsed.endLine}`
              : parsed.startLine}
          </button>
        );
      } else {
        // Same em-relative caveat: the prototype's 0.9em becomes the nearest ramp step.
        node = <code className="font-mono text-12-5 text-foreground">{segment.display}</code>;
      }
      if (segment.bold) node = <strong className="font-semibold text-foreground">{node}</strong>;
      return decorate(node, segment.start, segment.end, `${segment.start}:${segment.end}`);
    }

    function renderInline(segment: string, paragraphIndex: number, rawOffset: number): ReactNode[] {
      return inlineSegments(segment, rawOffset, autolink).flatMap((source) =>
        source.kind === "text"
          ? renderTextSegment(source)
          : [renderTokenSegment(source, paragraphIndex)],
      );
    }

    function renderBlock(block: TextBlock, paragraphIndex: number) {
      const activeInParagraph =
        autolink && activeRef?.startsWith(`${paragraphIndex}:`)
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

      if (block.kind === "list") {
        return (
          <Fragment key={paragraphIndex}>
            <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">
              {block.items.map((line, lineIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: bullet lines are a fixed positional list.
                <li key={lineIndex} className={cn("pl-1", paragraphClassName)}>
                  {renderInline(line.text, paragraphIndex, line.start)}
                </li>
              ))}
            </ul>
            {reveal}
          </Fragment>
        );
      }

      return (
        <Fragment key={paragraphIndex}>
          <p className={paragraphClassName}>
            {renderInline(block.source.text, paragraphIndex, block.source.start)}
          </p>
          {reveal}
        </Fragment>
      );
    }

    return blocks.map(renderBlock);
  }, [text, patchsetId, autolink, decorations, keywords, paragraphClassName, activeRef]);

  return (
    <div
      data-rich-text-raw={text}
      data-citation-autolink={autolink}
      className={cn("flex flex-col gap-2", className)}
    >
      {body}
    </div>
  );
}
