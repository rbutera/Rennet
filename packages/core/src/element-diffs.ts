/**
 * The per-element real diff slicer (issue #60).
 *
 * After #54 the canvas STATE is real, but zooming into an element to see the code
 * still rendered the `demoDiff` fixture. This module closes that last mile: it
 * resolves each canvas element's anchor to the REAL captured hunk text, sliced
 * VERBATIM from `patchset.files[].patch`.
 *
 * Why verbatim, not reconstructed: `decompose` (#7) stores a hunk's body as
 * SEPARATED `addedLines` / `deletedLines` / `contextLines` arrays — the
 * interleaved order is lost there. Rebuilding a diff from those arrays would
 * REORDER the lines (all deletions, then all additions), a plausible-but-wrong
 * render. So the slicer goes back to the source `@@` text and keeps it exactly as
 * git produced it: header line + interleaved body.
 *
 * Pure function of `(canvases, decomposition, patchset)`: no clock, no fs, no
 * model. Same inputs → byte-identical map. It is delivered ALONGSIDE the canvas
 * set (never embedded on the `Canvas`), so the canvas projection stays
 * byte-identical for replay (R17).
 */

import type {
  Canvas,
  CanvasAngle,
  Decomposition,
  ElementDiff,
  ElementDiffs,
  Hunk,
  Patchset,
  RenderedHunkOccurrence,
} from "@rennet/protocol";
import { parseAnchor } from "@rennet/protocol";
import { type AdmittedDocument, isProposalBody } from "./canvas";

/** A verbatim `@@` hunk sliced from a file patch: its line ranges + exact text. */
interface RawHunk {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The `@@` header line followed by its body lines, exactly as captured. */
  text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a file patch into its verbatim `@@` hunks. Only `+`/`-`/` `-prefixed
 * lines join the body (matching `decompose`'s own parser), so preamble and
 * "\ No newline at end of file" markers never bleed into the rendered text.
 */
function parseRawHunks(filePath: string, patch: string): RawHunk[] {
  const lines = patch.split("\n");
  const hunks: RawHunk[] = [];
  let meta: { oldStart: number; oldLines: number; newStart: number; newLines: number } | null =
    null;
  let body: string[] = [];
  const flush = (): void => {
    if (meta) hunks.push({ filePath, ...meta, text: body.join("\n") });
    meta = null;
    body = [];
  };
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      meta = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
      };
      body = [line];
      continue;
    }
    if (meta === null) continue; // preamble before the first hunk
    const first = line.charAt(0);
    if (first === "+" || first === "-" || first === " ") body.push(line);
  }
  flush();
  return hunks;
}

/**
 * Whether a decomposition hunk overlaps a raw hunk's line range (same file). A
 * non-split hunk matches its raw hunk exactly; an oversize split fragment
 * (`splitOf`) falls within its parent raw hunk. Both old- and new-side ranges are
 * tested so pure deletions (new-side empty) still resolve. A synthetic hunk
 * (0/0/0/0 — pure rename / mode-only / binary) overlaps nothing and falls to the
 * whole-file fallback.
 */
function overlaps(hunk: Hunk, raw: RawHunk): boolean {
  const newOverlap =
    hunk.newStart < raw.newStart + raw.newLines && raw.newStart < hunk.newStart + hunk.newLines;
  const oldOverlap =
    hunk.oldStart < raw.oldStart + raw.oldLines && raw.oldStart < hunk.oldStart + hunk.oldLines;
  return newOverlap || oldOverlap;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** What an element's anchor resolves to: the file path and the decomposition hunks. */
interface ResolvedElement {
  path: string;
  hunks: Hunk[];
}

/**
 * Precompute every chunk id's resolution (path + real hunks). TWO id spaces are
 * merged, because a chunk anchor can name either:
 *   - a deterministic floor chunk (`decomposition.chunks`) — the no-model path; or
 *   - an admitted `decomposition.proposal` chunk — the AGENTIC path, where the
 *     sequence canvas anchors its elements to the AGENT's regrouped chunk ids
 *     (canvas.ts `projectSequence`). Those ids are agent-authored and absent from
 *     the floor, so resolving against the floor alone leaves every agentic
 *     sequence element with no diff (zoom shows nothing in production).
 * A proposal chunk's `hunkIds` are real occurrence ids (agents reference, never
 * mint), so they resolve through the same `hunkById`. The floor grouping wins any
 * id collision — it is the canonical decomposition.
 */
function buildChunkResolutions(
  decomposition: Decomposition,
  admittedDocs: readonly AdmittedDocument[],
  hunkById: ReadonlyMap<string, Hunk>,
): Map<string, ResolvedElement> {
  const resolutions = new Map<string, ResolvedElement>();
  const resolve = (hunkIds: readonly string[], preferredPath: string): ResolvedElement => {
    const hunks = hunkIds
      .map((id) => hunkById.get(id))
      .filter((hunk): hunk is Hunk => hunk !== undefined);
    return { path: preferredPath || hunks[0]?.filePath || "", hunks };
  };
  for (const chunk of decomposition.chunks) {
    resolutions.set(chunk.chunkId, resolve(chunk.hunkIds, chunk.filePaths[0] ?? ""));
  }
  for (const doc of admittedDocs) {
    if (!isProposalBody(doc.body)) continue;
    for (const chunk of doc.body.chunks) {
      if (resolutions.has(chunk.chunkId)) continue; // the floor grouping is canonical
      resolutions.set(chunk.chunkId, resolve(chunk.hunkIds, ""));
    }
  }
  return resolutions;
}

/**
 * Resolve an element anchor to its file + decomposition hunks. `rennet:chunk/<id>`
 * → the chunk's hunks (floor or admitted-proposal); `rennet:hunk/<id>` → that one
 * hunk. Any other anchor kind (a flat-angle `doc`/`spec`/… element) has no code
 * diff and resolves to null.
 */
function resolveElement(
  anchor: string,
  chunkResolutions: ReadonlyMap<string, ResolvedElement>,
  hunkById: ReadonlyMap<string, Hunk>,
): ResolvedElement | null {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) return null;
  if (parsed.anchor.kind === "chunk") {
    return chunkResolutions.get(parsed.anchor.id) ?? null;
  }
  if (parsed.anchor.kind === "hunk") {
    const hunk = hunkById.get(parsed.anchor.id);
    if (!hunk) return null;
    return { path: hunk.filePath, hunks: [hunk] };
  }
  return null;
}

/**
 * Render a resolved element to its real diff: the distinct raw `@@` hunks its
 * decomposition hunks overlap, rendered verbatim in file order. When nothing
 * matches (a synthetic-only element — pure rename / binary), fall back to the
 * file's verbatim patch. Returns null when there is nothing real to show.
 */
function renderDiff(
  resolved: ResolvedElement,
  rawByFile: ReadonlyMap<string, RawHunk[]>,
  patchByFile: ReadonlyMap<string, string>,
): ElementDiff | null {
  if (resolved.hunks.length === 0) return null;
  const selected: RawHunk[] = [];
  const seen = new Set<string>();
  const files = [...new Set(resolved.hunks.map((hunk) => hunk.filePath))].sort(compare);
  for (const filePath of files) {
    const raws = rawByFile.get(filePath) ?? [];
    const fileHunks = resolved.hunks.filter((hunk) => hunk.filePath === filePath);
    raws.forEach((raw, index) => {
      const key = `${filePath}#${index}`;
      if (seen.has(key)) return;
      if (fileHunks.some((hunk) => overlaps(hunk, raw))) {
        seen.add(key);
        selected.push(raw);
      }
    });
  }
  if (selected.length > 0) {
    // The occurrence identity of each rendered `@@` hunk, built in the SAME order the
    // hunks are joined into `diff` (issue #84). Every occurrence overlapping a raw
    // hunk maps onto it — one for an ordinary hunk, several for an oversize split (R18)
    // — so a mark anchored to any of them resolves within THIS hunk, never a
    // positionally-guessed neighbour. The rendered text and this mapping come from one
    // iteration over `selected`, so they cannot drift.
    const hunkOccurrences: RenderedHunkOccurrence[][] = selected.map((raw) =>
      resolved.hunks
        .filter((hunk) => hunk.filePath === raw.filePath && overlaps(hunk, raw))
        .sort((a, b) => a.newStart - b.newStart || a.oldStart - b.oldStart)
        .map((hunk) => ({
          id: hunk.id,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
        })),
    );
    // `files` is EVERY file this element's hunks span (a proposal chunk can regroup
    // several) — carried so a consumer can test file membership, not just `path`.
    return {
      path: resolved.path,
      paths: files,
      diff: selected.map((raw) => raw.text).join("\n"),
      hunkOccurrences,
    };
  }
  const patch = patchByFile.get(resolved.path);
  if (patch && patch.trim().length > 0) {
    // A synthetic-only element (pure rename / mode-only / binary): its hunks overlap
    // no raw `@@`, so the whole-file patch is shown but no occurrence anchors onto it.
    return { path: resolved.path, paths: [resolved.path], diff: patch, hunkOccurrences: [] };
  }
  return null;
}

/**
 * Build the per-element real diff map for a canvas set. Keyed by `elementKey`;
 * an element with no resolvable code diff (a doc-anchored flat element) simply has
 * no entry, so the UI's zoom surface renders nothing rather than a fixture. The
 * same `elementKey` across canvases resolves to the same anchor, so it is computed
 * once — the map is deterministic regardless of canvas iteration order.
 */
export function buildElementDiffs(
  canvases: Record<CanvasAngle, Canvas>,
  decomposition: Decomposition,
  patchset: Patchset,
  admittedDocs: readonly AdmittedDocument[] = [],
): ElementDiffs {
  const rawByFile = new Map<string, RawHunk[]>();
  const patchByFile = new Map<string, string>();
  for (const file of patchset.files) {
    rawByFile.set(file.path, parseRawHunks(file.path, file.patch));
    patchByFile.set(file.path, file.patch);
  }
  const hunkById = new Map(decomposition.hunks.map((hunk) => [hunk.id, hunk]));
  const chunkResolutions = buildChunkResolutions(decomposition, admittedDocs, hunkById);

  const diffs: ElementDiffs = {};
  for (const canvas of Object.values(canvases)) {
    for (const element of canvas.layers.analysis.elements) {
      if (diffs[element.elementKey]) continue;
      const resolved = resolveElement(element.anchor, chunkResolutions, hunkById);
      if (!resolved) continue;
      const diff = renderDiff(resolved, rawByFile, patchByFile);
      if (diff) diffs[element.elementKey] = diff;
    }
  }
  return diffs;
}
