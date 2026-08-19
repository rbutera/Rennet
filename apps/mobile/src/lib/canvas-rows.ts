// Flatten the projected canvas into FlatList rows (issue #383 batch, finding 16). One element
// (a changed file) is NOT one row: a large file diff as a single row defeats virtualization —
// the whole hunk mounts at once. Instead each file becomes a header row followed by one row per
// hunk, so the FlatList windows individual hunks and a thousand-line file stays smooth. Pure and
// framework-free (unit-tested); the screen just renders the rows it returns.

/** One flattened canvas row: a cohort header, a file header, or a single hunk of that file's diff. */
export type CanvasRow =
  | {
      readonly type: "cohort";
      readonly key: string;
      readonly cohortKey: string;
      readonly title: string;
      readonly count: number;
      readonly collapsed: boolean;
    }
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

/** A canvas cohort: its key, title, and the element keys it groups (reading order within it). */
export interface CanvasCohort {
  readonly cohortKey: string;
  readonly title: string;
  readonly elementKeys: readonly string[];
}

/**
 * Flatten a canvas into cohort-grouped rows (issue #382 M2, task 6.3, wireframe 21): a cohort
 * header, then — unless the cohort is collapsed — its elements' file + hunk rows, in reading order.
 * A collapsed cohort (a judged cohort, or one the user folded) emits only its header, so the
 * FlatList never mounts its hunks — the virtualization discipline is kept. Elements not in any
 * cohort fall under a trailing "Other changes" group so nothing is dropped. `collapsed` is the set
 * of collapsed cohort keys (the screen seeds it from judged cohorts and toggles on tap).
 */
export function flattenCanvasByCohort(
  cohorts: readonly CanvasCohort[],
  elementsByKey: ReadonlyMap<string, CanvasElement>,
  collapsed: ReadonlySet<string>,
): CanvasRow[] {
  const rows: CanvasRow[] = [];
  const placed = new Set<string>();
  const emitElement = (element: CanvasElement): void => {
    rows.push({ type: "file", key: `file:${element.key}`, path: element.path });
    splitHunks(element.diff).forEach((diff, index) => {
      rows.push({ type: "hunk", key: `hunk:${element.key}:${index}`, path: element.path, diff });
    });
  };
  for (const cohort of cohorts) {
    const elements = cohort.elementKeys
      .map((key) => elementsByKey.get(key))
      .filter((e): e is CanvasElement => e !== undefined);
    const isCollapsed = collapsed.has(cohort.cohortKey);
    rows.push({
      type: "cohort",
      key: `cohort:${cohort.cohortKey}`,
      cohortKey: cohort.cohortKey,
      title: cohort.title,
      count: elements.length,
      collapsed: isCollapsed,
    });
    for (const element of elements) {
      placed.add(element.key);
      if (!isCollapsed) emitElement(element);
    }
  }
  // Anything the cohorts did not place (never dropped) — a trailing "Other changes" group.
  const leftovers = [...elementsByKey.values()].filter((e) => !placed.has(e.key));
  if (leftovers.length > 0) {
    const key = "__other__";
    const isCollapsed = collapsed.has(key);
    rows.push({
      type: "cohort",
      key: `cohort:${key}`,
      cohortKey: key,
      title: "Other changes",
      count: leftovers.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) for (const element of leftovers) emitElement(element);
  }
  return rows;
}
