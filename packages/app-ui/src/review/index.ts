// The review layer (C4, #489) — the shared machinery every review surface (C5–C9)
// renders through. Presentation ported from the board-prototype spike; state rewritten
// onto the real `review` store slice and the C01 data seam. Source hydration goes through
// the span-read seam (citations.ts), never a filesystem read.

// Public surface: the shared components, the CodeRef shape, and the span-read hook.
// `lineRef`/`spanToBlock`/`parseRef`/`CitationBlock` are module-private helpers — the
// review components below use them internally; nothing outside review/ imports them.
// The durable ask log binding for the open review — the client half of the `ask.*` write
// path. The review route mounts it; it is public so the app layer can mount a review surface
// against a real daemon dispatch.
export { useAskLog } from "./ask-log";
export type { CodeRef, SpanRead } from "./citations";
export { useSpanRead } from "./citations";
export { CodeBlock, type CodeBlockProps } from "./code-block";
export { AnchorReveal, CodeTabs } from "./code-tabs";
export { DiffView, type DiffViewProps } from "./diff-view";
export { DiffViewContainer } from "./diff-view-container";
export { LineCommentEditor, type LineCommentEditorProps } from "./line-comment-editor";
export { ReferenceChip, type ReferenceChipProps } from "./reference-chip";
export { RichText, type RichTextProps } from "./rich-text";
export { type DraftHandlers, ProseSelectionLayer } from "./selection-toolbar";
