import type { CodeRef, CommandOutput } from "@rennet/protocol";
import { type CommandResult, useCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// The span-read seam (C4, reconciliation 6): the ONE point every citation hydrates
// through, reading the CAPTURED patchset via `patchset.readSpan` — NEVER a filesystem
// read (no `node:fs`/`node:path` reachable here; grep-provable, verification 8.3).
// Dispatch is BOUND (`server/src/dispatch/patchset.ts`): the daemon serves the span out
// of the patchset's own patch text, so a citation resolves even when the repository is
// gone. A span the diff never captured cannot be served, and the daemon says which
// absence it hit — `CitationBlock` renders that sentence rather than a generic line.
// ─────────────────────────────────────────────────────────────────────────────

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
 * cannot drift, and the cited lines themselves highlighted.
 */
export function spanToBlock(
  ref: CodeRef,
  span: SpanRead,
): { code: string; startLine: number; highlightLines: number[] } {
  const code = [...span.contextBefore, ...span.lines, ...span.contextAfter].join("\n");
  const startLine = ref.startLine - span.contextBefore.length;
  const highlightLines: number[] = [];
  for (let line = ref.startLine; line <= ref.endLine; line++) highlightLines.push(line);
  return { code, startLine, highlightLines };
}
