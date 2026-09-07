import type { CodeRef, CommandOutput } from "@rennet/protocol";
import { type CommandResult, useCommand } from "../data";

// Compatibility span reader for persisted citations and older daemons. Current boards
// use readEvidence for complete diff hunks; both commands read immutable reviewed content.

export type { CodeRef };

/** The cited span plus a little orientation context, from the captured patch text. */
export type SpanRead = CommandOutput<"patchset.readSpan">;

// A never-valid ref, used only to give a DISABLED read a stable cache key. `enabled:
// false` means it is never invoked, so the empty patchsetId never reaches dispatch.
const NO_REF: CodeRef = { patchsetId: "", path: "", side: "head", startLine: 1, endLine: 1 };

/** A stable string identity over the WHOLE CodeRef — patchset, side, path, and span.
 *  Used as a React key/remount key so distinct legal refs never collide and a citation
 *  switch remounts the code surface (dropping any open line-comment draft). */
export function refKey(ref: CodeRef): string {
  return `${ref.patchsetId}\u0000${ref.side}\u0000${ref.path}\u0000${ref.startLine}-${ref.endLine}`;
}

/** Build a CodeRef for a `path:line(-line)` citation against the review's patchset. */
export function lineRef(
  patchsetId: string,
  path: string,
  startLine: number,
  endLine: number = startLine,
  side: CodeRef["side"] = "head",
): CodeRef {
  return { patchsetId, path, side, startLine, endLine };
}

/**
 * Read the cited span for `ref`, or nothing when `ref` is null (a folded citation).
 * Every citation-resolving component in the review layer calls exactly this — the
 * read dedupes and caches by ref through the data seam, so a re-opened chip does not
 * refetch, and a rejection surfaces as `error`, never a thrown render.
 */
export function useSpanRead(ref: CodeRef | null): CommandResult<SpanRead> {
  return useCommand("patchset.readSpan", ref ?? NO_REF, { enabled: ref !== null });
}

/**
 * Fold a fetched span into a code-block's props: the cited lines plus their
 * orientation context, with absolute line numbering derived from the ref so it
 * cannot drift. Citations never create reviewer selections.
 */
export function spanToBlock(
  ref: CodeRef,
  span: SpanRead,
): { code: string; startLine: number; highlightLines: number[] } {
  const code = [...span.contextBefore, ...span.lines, ...span.contextAfter].join("\n");
  const startLine = ref.startLine - span.contextBefore.length;
  const highlightLines: number[] = [];

  return { code, startLine, highlightLines };
}
