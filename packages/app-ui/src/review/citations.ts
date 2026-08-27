import type { CodeRef, CommandOutput } from "@rennet/protocol";
import { type CommandResult, useCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// The span-read seam (C4, reconciliation 6) — the ONE resolution point every
// citation hydrates through. A code-tabs anchor reveal, a rich-text citation click:
// all read the CAPTURED patchset via `patchset.readSpan`, NEVER a filesystem read.
// `/api/source` (the spike's Next.js route) has no successor. No `node:fs`/`node:path`
// read API is reachable from this module (grep-provable, verification 8.3).
//
// B3 registered the command's shape; `packages/server/src/dispatch.ts` still throws
// "patchset.readSpan is not bound yet (B4/B10 bind dispatch)". Until dispatch binds,
// production renders the command's honest `error` state (an unreadable citation "says
// so in one honest line"); tests supply MemoryBridge handlers. When dispatch binds,
// THIS FILE is the only one that changes.
// ─────────────────────────────────────────────────────────────────────────────

export type { CodeRef };

/** The cited span plus a little orientation context, from the captured patch text. */
export type SpanRead = CommandOutput<"patchset.readSpan">;

// A never-valid ref, used only to give a DISABLED read a stable cache key. `enabled:
// false` means it is never invoked, so the empty patchsetId never reaches dispatch.
const NO_REF: CodeRef = { patchsetId: "", path: "", side: "head", startLine: 1, endLine: 1 };

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
