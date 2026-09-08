import { Fragment, type ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// A heading is not a paragraph. Board titles — a finding's claim line, a decision's
// heading, a section title, a preview row — arrive as the first line of a markdown
// field, and a seat writing that line will reach for `**bold**` or a `#` mark because
// nothing tells it the line is already a heading. Printing those bytes raw put
// `**Valid patterns can collapse distinct workspaces**` in a Flagged header (2026-09-08).
//
// So every heading renders through here: backticks become real inline code (a heading
// names code tokens constantly and they must read as code), `**` and `__` emphasis is
// UNWRAPPED rather than rendered (the heading already carries its weight; a bold run
// inside it is noise), and a leading `#` run is dropped. Nothing else is interpreted.
// ─────────────────────────────────────────────────────────────────────────────

const HEADING_MARK_RE = /^#{1,6}\s+/;
const INLINE_RE = /`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|[^`*_]+|[`*_]/g;

/**
 * The plain-text reading of a heading: heading marks and bold wrappers gone, backticks
 * kept (they are the one mark the renderer turns into structure). Used wherever a heading
 * is compared or measured rather than painted — preview de-duplication, nav labels.
 */
export function stripHeadingMarkup(text: string): string {
  return text
    .replace(HEADING_MARK_RE, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .trim();
}

/** Render one heading string: inline code as `<code>`, emphasis unwrapped, marks dropped. */
export function headingNodes(text: string, keyPrefix = ""): ReactNode[] {
  const source = text.replace(HEADING_MARK_RE, "");
  return [...source.matchAll(INLINE_RE)].map((match) => {
    const part = match[0];
    const key = `${keyPrefix}${match.index}`;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={key} className="rounded-sm bg-secondary/70 px-1 font-mono font-normal">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <Fragment key={key}>{headingNodes(part.slice(2, -2), `${key}-`)}</Fragment>;
    }
    if (part.length > 4 && part.startsWith("__") && part.endsWith("__")) {
      return <Fragment key={key}>{headingNodes(part.slice(2, -2), `${key}-`)}</Fragment>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function HeadingText({ text }: { readonly text: string }) {
  return <>{headingNodes(text)}</>;
}
