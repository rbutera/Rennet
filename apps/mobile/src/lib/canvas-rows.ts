// Flatten the projected canvas into FlatList rows (issue #383 batch, finding 16). One element
// (a changed file) is NOT one row: a large file diff as a single row defeats virtualization —
// the whole hunk mounts at once. Instead each file becomes a header row followed by one row per
// hunk, so the FlatList windows individual hunks and a thousand-line file stays smooth. Pure and
// framework-free (unit-tested); the screen just renders the rows it returns.

/** One flattened canvas row: a file header, or a single hunk of that file's diff. */
export type CanvasRow =
  | { readonly type: "file"; readonly key: string; readonly path: string }
  | { readonly type: "hunk"; readonly key: string; readonly path: string; readonly diff: string };

/** A projected canvas element (a changed file) — key, path, and its unified-diff text. */
export interface CanvasElement {
  readonly key: string;
  readonly path: string;
  readonly diff: string;
}

/** Split a unified diff into its hunks (each `@@ … @@` block). A diff with no marker is one hunk. */
export function splitHunks(diff: string): string[] {
  const lines = diff.split("\n");
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@") && current.length > 0) {
      hunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) hunks.push(current.join("\n"));
  // An empty or marker-less diff collapses to a single hunk carrying the whole text.
  return hunks.length > 0 ? hunks : [diff];
}

/** Flatten canvas elements into header + per-hunk rows, in reading order (no truncation). */
export function flattenCanvasRows(elements: readonly CanvasElement[]): CanvasRow[] {
  const rows: CanvasRow[] = [];
  for (const element of elements) {
    rows.push({ type: "file", key: `file:${element.key}`, path: element.path });
    splitHunks(element.diff).forEach((diff, index) => {
      rows.push({ type: "hunk", key: `hunk:${element.key}:${index}`, path: element.path, diff });
    });
  }
  return rows;
}
