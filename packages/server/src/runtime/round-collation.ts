// ─────────────────────────────────────────────────────────────────────────────
// The round collation bridge (C15 cluster 1, tasks 1.2–1.3). `runRound`'s
// `RoundInput` needs a flat `LintHunk[]` and a per-lens `lintContextFor` that the
// lens pipeline's coverage/lint consume; no production path built these before
// C15. These two PURE builders turn an (immutable) patchset + its `HunkIndex`
// into exactly those shapes. Pure and I/O-free — the trigger (1.5) supplies the
// patchset, these derive the collation universe.
// ─────────────────────────────────────────────────────────────────────────────

import type { DeltaPacketFile, HunkIndex, LintContext, LintHunk, LintTarget } from "@rennet/core";
import type { PatchFile, Patchset } from "@rennet/protocol";

/**
 * Map a patchset's `IndexedHunk`s (whose spans are `{ new: {start,lines}, old:
 * {start,lines} }`) to the FLAT `LintHunk` `{ id, path, newStart, newLines,
 * oldStart, oldLines, previousPath? }` shape the pipeline's `assertCoverage` and
 * lint consume (`lint.ts`). The base-side `previousPath` is set only for a RENAMED
 * file (a `side:"base"` code_ref then resolves against the old path); an
 * unrenamed file's base path defaults to `path` inside `codeRefTeaches`, so it is
 * omitted here. Pure.
 */
export function toLintHunks(
  hunks: HunkIndex,
  files: readonly (DeltaPacketFile | PatchFile)[],
): LintHunk[] {
  const previousPathByPath = new Map<string, string>();
  for (const file of files) {
    if (file.status === "renamed" && file.previousPath !== undefined) {
      previousPathByPath.set(file.path, file.previousPath);
    }
  }
  return hunks.hunks.map((hunk): LintHunk => {
    const previousPath = previousPathByPath.get(hunk.path);
    return {
      id: hunk.id,
      path: hunk.path,
      newStart: hunk.spans.new.start,
      newLines: hunk.spans.new.lines,
      oldStart: hunk.spans.old.start,
      oldLines: hunk.spans.old.lines,
      ...(previousPath === undefined ? {} : { previousPath }),
    };
  });
}

/**
 * The HEAD-side (post-image) file → line-count inventory a board's citations
 * resolve against. A patchset does not carry file line counts (it carries diffs),
 * so the head inventory is derived per file from its patch: the count of context
 * (` `) + added (`+`) lines across every hunk is the file's post-image line span
 * touched by the change. Deleted files contribute no head inventory. This is the
 * inventory `checkCitationResolves` needs to reject a citation past a file's end;
 * a citation inside a hunk's own range always resolves (the change is teachable).
 */
function headFileInventory(files: readonly PatchFile[]): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const file of files) {
    if (file.status === "deleted" || file.binary) continue;
    // The highest post-image line the patch reaches: a hunk covers
    // `newStart .. newStart + newLines - 1`, so the max end across hunks is the
    // head-side extent the citations can address.
    let maxLine = 0;
    for (const match of file.patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]);
      const lines = match[2] === undefined ? 1 : Number(match[2]);
      maxLine = Math.max(maxLine, start + Math.max(lines, 1) - 1);
    }
    inventory.set(file.path, maxLine);
  }
  return inventory;
}

/** The BASE-side (pre-image) inventory a `side:"base"` code_ref resolves against. */
function baseFileInventory(files: readonly PatchFile[]): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const file of files) {
    if (file.status === "added" || file.binary) continue;
    const basePath = file.previousPath ?? file.path;
    let maxLine = 0;
    for (const match of file.patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
      const start = Number(match[1]);
      const lines = match[2] === undefined ? 1 : Number(match[2]);
      maxLine = Math.max(maxLine, start + Math.max(lines, 1) - 1);
    }
    inventory.set(basePath, maxLine);
  }
  return inventory;
}

/**
 * Build the per-lens `lintContextFor` the round pipeline calls once per board. The
 * hunk list + file inventories + patchsetId are the SAME for every lens (a board
 * of any lens may cite or skip any patchset hunk — `ctx.hunks` gates skip
 * resolution and taught/skipped coherence, not a per-lens partition); only
 * `ctx.lens` varies. `scaffoldGlobs` is left to the lint default. Pure — returns a
 * `(lens) => LintContext` closure over the derived universe.
 */
export function buildLintContextFor(
  patchset: Patchset,
  hunks: readonly LintHunk[],
): (lens: LintTarget) => LintContext {
  const files = new Map(headFileInventory(patchset.files));
  const baseFiles = new Map(baseFileInventory(patchset.files));
  return (lens: LintTarget): LintContext => ({
    lens,
    hunks,
    files,
    baseFiles,
    patchsetId: patchset.id,
  });
}
