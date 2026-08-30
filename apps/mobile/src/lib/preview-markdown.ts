export type PreviewMarkdownInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string };

export interface PreviewMarkdownBlock {
  readonly kind: "heading" | "paragraph";
  readonly inlines: readonly PreviewMarkdownInline[];
}

const FINAL_REVIEW_MARKER = /\n*<!--\s*rennet:review:[0-9a-f]{64}\s*-->\s*$/;
const STRONG = /\*\*([^*\n]+)\*\*/g;

function inlineMarkdown(text: string): PreviewMarkdownInline[] {
  const inlines: PreviewMarkdownInline[] = [];
  let cursor = 0;
  for (const match of text.matchAll(STRONG)) {
    const index = match.index;
    const strong = match[1];
    if (index > cursor) inlines.push({ kind: "text", text: text.slice(cursor, index) });
    if (strong !== undefined) inlines.push({ kind: "strong", text: strong });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) inlines.push({ kind: "text", text: text.slice(cursor) });
  return inlines.length > 0 ? inlines : [{ kind: "text", text }];
}

/** The structural Markdown subset used by signing previews on the phone. */
export function previewMarkdownBlocks(
  markdown: string,
  options: { readonly hideFinalReviewMarker?: boolean } = {},
): PreviewMarkdownBlock[] {
  const blocks: PreviewMarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", inlines: inlineMarkdown(text) });
    paragraph = [];
  };

  const visible = options.hideFinalReviewMarker
    ? markdown.replace(FINAL_REVIEW_MARKER, "")
    : markdown;
  for (const line of visible.split("\n")) {
    if (line.startsWith("## ")) {
      flushParagraph();
      blocks.push({ kind: "heading", inlines: inlineMarkdown(line.slice(3).trim()) });
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  return blocks;
}
