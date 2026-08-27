import type { PatchFile } from "@rennet/protocol";
import { HUNK_HEADER_RE } from "../canvas/registrar";

// ─────────────────────────────────────────────────────────────────────────────
// Unified-diff → hunks, pure (C6, reconciliation 1). `PatchFile.patch` is raw unified-diff
// text; this module parses it into the `{ oldStart, newStart, lines }` shape the renderer
// consumes, reusing the repo's ONE `@@` grammar (`HUNK_HEADER_RE`, lifted from
// `canvas/registrar.ts`) rather than hand-rolling a second regex. `hunkHeader`/`fileStats`
// are the spike's `lib/diff-data.ts` logic reborn over `PatchFile`. No React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export type DiffLineType = "context" | "add" | "del";

/** One hunk line: its kind and its content WITHOUT the leading `+`/`-`/` ` marker. */
export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
}

/** One `@@` hunk: the old/new starting line numbers, the raw `@@ … @@` header line
 *  exactly as git emitted it (section-heading context tail included), and the ordered
 *  body lines. */
export interface Hunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

/** A body line with its dual old/new line numbers resolved (add ⇒ no old, del ⇒ no new). */
export interface NumberedLine extends DiffLine {
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

/**
 * Parse one `PatchFile.patch` into its hunks. Preamble before the first `@@` (git file
 * headers, `+++`/`---`, `index …`) and inter-hunk metadata are skipped; the `\ No newline
 * at end of file` marker is dropped. A blank body line (a source blank whose trailing
 * space was stripped) counts as context so line numbering stays true. A binary or empty
 * patch parses to `[]`.
 */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Array<{ oldStart: number; newStart: number; header: string; lines: DiffLine[] }> =
    [];
  let current: { oldStart: number; newStart: number; header: string; lines: DiffLine[] } | null =
    null;
  // Strip exactly one trailing newline so the split does not mint a phantom blank line.
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  for (const raw of body.split("\n")) {
    const header = HUNK_HEADER_RE.exec(raw);
    if (header) {
      // Numbering comes from the parsed counts; the DISPLAYED header is the raw source
      // line verbatim, so git's trailing section-heading context survives (real git emits
      // `@@ -a,b +c,d @@ <function context>`, which a reconstruction from counts drops).
      current = {
        oldStart: Number(header[1]),
        newStart: Number(header[3]),
        header: raw,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble before the first @@ — file headers, skipped
    const marker = raw.charAt(0);
    if (marker === "+") current.lines.push({ type: "add", text: raw.slice(1) });
    else if (marker === "-") current.lines.push({ type: "del", text: raw.slice(1) });
    else if (marker === " ") current.lines.push({ type: "context", text: raw.slice(1) });
    else if (raw.length === 0) current.lines.push({ type: "context", text: "" });
    // "\ No newline…" and any stray metadata line carry no line number — skipped.
  }
  return hunks;
}

/** The hunk's `@@ … @@` header for display — the raw source line verbatim, so git's
 *  trailing section-heading context (`@@ -a,b +c,d @@ <function context>`) is preserved
 *  rather than dropped by reconstructing from the parsed line counts. */
export function hunkHeader(hunk: Hunk): string {
  return hunk.header;
}

/** Added/deleted line totals for a file. Prefers the projection's own counts
 *  (`additions`/`deletions`); when either is null, counts the parsed hunks. */
export function fileStats(file: PatchFile): { additions: number; deletions: number } {
  if (file.additions !== null && file.deletions !== null) {
    return { additions: file.additions, deletions: file.deletions };
  }
  let additions = 0;
  let deletions = 0;
  for (const hunk of parsePatch(file.patch)) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      else if (line.type === "del") deletions++;
    }
  }
  return { additions, deletions };
}

/** Resolve dual old/new line numbers across a hunk's body: an added line has no old
 *  number, a deleted line has no new number, context advances both. */
export function numberLines(hunk: Hunk): NumberedLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line) => ({
    ...line,
    oldLine: line.type === "add" ? null : oldLine++,
    newLine: line.type === "del" ? null : newLine++,
  }));
}
