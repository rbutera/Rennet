import { parseAnchor } from "@rennet/protocol";
import type { AnchorSide, ParsedAnchor, RenderedHunkOccurrence } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The anchor↔row registrar — the coordinate system that turns the CodeView from
// a text pane into an inhabited canvas (issue #77). The substrate below already
// speaks anchors: `@rennet/protocol`'s grammar expresses side-qualified line
// spans (`rennet:hunk/<id>#L4-L9@additions`) with byte-verified resolution, and
// L3 events are anchor-agnostic. What was missing was a way to land those anchors
// ON the rendered rows. This module is that seam, and it is PURE — no scroll, no
// window, no DOM — so a mark's placement can never move when a row recycles.
//
// Two coordinate systems live on every content row, and they are NOT the same:
//   • fileLine  — the real file line (parsed from the `@@ -a,b +c,d @@` header):
//                 additions/context read the NEW-file column, deletions the OLD.
//                 This is what the reviewer reads and what the #21 publish path
//                 needs (GitHub review threads want line/side).
//   • sideOrdinal — the 1-based position among rows of the SAME side within the
//                 hunk. This is what an `AnchorSpan` addresses: `#L4@additions`
//                 is the 4th addition line, mirroring the substrate resolver's
//                 index into `occurrence.sides[side]`.
// ─────────────────────────────────────────────────────────────────────────────

export type RowKind = "content" | "hunk-header" | "file-header" | "meta";

export interface RegistryRow {
  /** 0-based position in `diff.split("\n")` — the stable row identity. */
  rawIndex: number;
  text: string;
  kind: RowKind;
  /** 0-based hunk index; -1 for any preamble row before the first hunk. */
  hunkIndex: number;
  /** The stable occurrence id of this row's hunk, if a mapping was supplied. */
  occurrenceId: string | null;
  /** additions / deletions / context for content rows; null for header/meta. */
  side: AnchorSide | null;
  /** Real file line on this row's side; null for header/meta rows. */
  fileLine: number | null;
  /** 1-based ordinal among same-side content rows within the hunk; what a span addresses. */
  sideOrdinal: number | null;
}

export interface HunkHeader {
  oldStart: number;
  oldCount: number | null;
  newStart: number;
  newCount: number | null;
}

/**
 * One occurrence's slice of a rendered `@@` hunk. A hunk carries one occurrence in
 * the ordinary case; an oversize-split (R18) raw hunk carries several fragments, and
 * each gets its OWN per-side row arrays so a span (`#L4@additions`) indexes into the
 * fragment, never the whole raw hunk. Side arrays hold raw indices in order; a side
 * key is present only when that side has a row (a missing key is a genuine "no such
 * side"), mirroring the substrate's `occurrence.sides`.
 */
export interface RegistryOccurrence {
  occurrenceId: string;
  sides: Partial<Record<AnchorSide, number[]>>;
  /** All content rows of the occurrence, in order (for spanless whole-occurrence marks). */
  contentRawIndices: number[];
}

export interface RegistryHunk {
  hunkIndex: number;
  /** null for the implicit hunk of a header-less diff. */
  header: HunkHeader | null;
  headerRawIndex: number | null;
  /**
   * The occurrence(s) this rendered hunk carries, each with its own row slice, in the
   * order the producer emitted them. Empty when the caller supplied no mapping for
   * this hunk (identity-less rows — marks cannot resolve here).
   */
  occurrences: RegistryOccurrence[];
}

export interface RowRegistry {
  rows: RegistryRow[];
  hunks: RegistryHunk[];
}

export interface BuildRegistryInput {
  diff: string;
  /**
   * The occurrence identity of each rendered `@@` hunk, in diff order (issue #84).
   * Outer index aligns to the Nth `@@` hunk; the inner list is every occurrence that
   * hunk carries — one ordinarily, several for an oversize split. Emitted by the same
   * pass that assembles the diff text (`ElementDiff.hunkOccurrences`), so the mapping
   * cannot drift from the text the way a separately-derived positional array could.
   * Omit for identity-less rows.
   *
   * Rows are partitioned to their occurrence by line-range containment. An unsplit
   * whole hunk has one occurrence whose range is the hunk header's own extent, so it
   * claims every row. An oversize split has several occurrences, each claiming only
   * its own lines — and a fragment claims only its slice even when it is the element's
   * ONLY occurrence but the whole parent `@@` is rendered around it.
   */
  hunkOccurrences?: readonly (readonly RenderedHunkOccurrence[])[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** File-header / diff-metadata lines that must never be classified as add/del content. */
function isFileHeader(text: string): boolean {
  return (
    text.startsWith("+++ ") ||
    text.startsWith("--- ") ||
    text.startsWith("diff --git ") ||
    text.startsWith("index ") ||
    text.startsWith("new file mode") ||
    text.startsWith("deleted file mode") ||
    text.startsWith("rename from ") ||
    text.startsWith("rename to ") ||
    text.startsWith("similarity index ") ||
    text.startsWith("Binary files ")
  );
}

/**
 * Parse a diff string into a registry: every row gets a kind, side, real file
 * line, per-side ordinal, and occurrence identity. A header-less diff (the demo/
 * fixture shape) is treated as one implicit hunk seeded at line 1/1.
 */
export function buildRowRegistry(input: BuildRegistryInput): RowRegistry {
  const rows: RegistryRow[] = [];
  const hunks: RegistryHunk[] = [];
  if (input.diff.length === 0) return { rows, hunks };

  const lines = input.diff.split("\n");
  let hunk: RegistryHunk | null = null;
  let oldLine = 1;
  let newLine = 1;

  // Open a rendered-hunk registry entry, wiring in the occurrence(s) the producer
  // mapped to this hunk index (`input.hunkOccurrences[hunkIndex]`) and resetting the
  // per-hunk line cursors. Assigned to `hunk` in the main body so control-flow narrows it.
  function openHunk(header: HunkHeader | null, headerRawIndex: number | null): RegistryHunk {
    const mapped = input.hunkOccurrences?.[hunks.length] ?? [];
    const occurrences: RegistryOccurrence[] = mapped.map((occ) => ({
      occurrenceId: occ.id,
      sides: {},
      contentRawIndices: [],
    }));
    const created: RegistryHunk = {
      hunkIndex: hunks.length,
      header,
      headerRawIndex,
      occurrences,
    };
    hunks.push(created);
    oldLine = header ? header.oldStart : 1;
    newLine = header ? header.newStart : 1;
    return created;
  }

  // Which occurrence of hunk `hunkIndex` owns a content row on `side` at the current
  // (oldLine, newLine) cursor, by line-range containment: a deletion tests the OLD-side
  // range, an addition/context the NEW-side. Containment is used even for a lone
  // occurrence, because an element can render a raw hunk it only PARTLY owns — an
  // oversize split (R18) puts each fragment in its own floor chunk, yet the element
  // still renders the whole parent `@@` — so a fragment's span must land within ITS
  // slice, never the whole hunk. A row no occurrence claims (rendered context outside
  // this element's fragment) returns -1 and becomes identity-less, rather than
  // borrowing a neighbour's identity. An unsplit whole hunk has one occurrence whose
  // range is the header's own extent, so it claims every row — identical to before.
  function occurrenceIndexFor(hunkIndex: number, side: AnchorSide): number {
    const mapped = input.hunkOccurrences?.[hunkIndex] ?? [];
    const line = side === "deletions" ? oldLine : newLine;
    for (let i = 0; i < mapped.length; i += 1) {
      const occ = mapped[i];
      if (!occ) continue;
      const start = side === "deletions" ? occ.oldStart : occ.newStart;
      const count = side === "deletions" ? occ.oldLines : occ.newLines;
      if (line >= start && line < start + count) return i;
    }
    return -1;
  }

  function pushSide(occurrence: RegistryOccurrence, side: AnchorSide, rawIndex: number): number {
    let arr = occurrence.sides[side];
    if (!arr) {
      arr = [];
      occurrence.sides[side] = arr;
    }
    arr.push(rawIndex);
    occurrence.contentRawIndices.push(rawIndex);
    return arr.length;
  }

  for (let rawIndex = 0; rawIndex < lines.length; rawIndex += 1) {
    const text = lines[rawIndex] ?? "";

    const headerMatch = HUNK_HEADER_RE.exec(text);
    if (headerMatch) {
      const header: HunkHeader = {
        oldStart: Number(headerMatch[1]),
        oldCount: headerMatch[2] === undefined ? null : Number(headerMatch[2]),
        newStart: Number(headerMatch[3]),
        newCount: headerMatch[4] === undefined ? null : Number(headerMatch[4]),
      };
      hunk = openHunk(header, rawIndex);
      rows.push({
        rawIndex,
        text,
        kind: "hunk-header",
        hunkIndex: hunk.hunkIndex,
        occurrenceId: null,
        side: null,
        fileLine: null,
        sideOrdinal: null,
      });
      continue;
    }

    // A body line is content ONLY when its first char is `+`, `-`, or a space —
    // exactly the substrate's rule (decomposition.ts addedOf/deletedOf/contextOf
    // filter on the first char). Everything else — a stray `""` (the trailing
    // element of `diff.split("\n")` on a newline-terminated diff), a `\ No newline`
    // marker, inter-file `diff --git`/`index` lines — is metadata that must NOT
    // enter a side array, or an ordinal would shift and a mark land on the wrong
    // row. `isFileHeader` runs ONLY in the preamble (before the first hunk): once
    // a hunk is open, a body line reading `--- x` / `+++ x` is a real deletion /
    // addition (its content happens to start with `--`/`++`), never a header —
    // classifying it by first char is what keeps the UI's side arrays identical
    // to the substrate's `occurrence.sides[side]`.
    const first = text.charAt(0);
    const isContentPrefix = first === "+" || first === "-" || first === " ";

    if (hunk === null) {
      // Preamble. Real file headers (`diff --git`, `index`, `+++`/`--- ` path
      // lines) live here; a content-prefixed line with no `@@` yet is the header-
      // less fixture/demo shape and opens one implicit hunk seeded at line 1/1.
      if (isFileHeader(text) || !isContentPrefix) {
        rows.push({
          rawIndex,
          text,
          kind: isFileHeader(text) ? "file-header" : "meta",
          hunkIndex: -1,
          occurrenceId: null,
          side: null,
          fileLine: null,
          sideOrdinal: null,
        });
        continue;
      }
      hunk = openHunk(null, null);
    } else if (!isContentPrefix) {
      // Inside a hunk, a non-body line: metadata the substrate ignores. Rendered
      // (so the surface is faithful) but carries no side, ordinal, or file line.
      rows.push({
        rawIndex,
        text,
        kind: "meta",
        hunkIndex: hunk.hunkIndex,
        occurrenceId: null,
        side: null,
        fileLine: null,
        sideOrdinal: null,
      });
      continue;
    }

    // Content (hunk is non-null and `first` is one of `+`/`-`/space). Assign the row
    // to its owning occurrence (a single occurrence owns all; a split partitions by
    // line range), then push it into THAT occurrence's side array so its ordinal is
    // 1-based within the occurrence — exactly what `#Ln@side` addresses. A row no
    // occurrence claims (defensive: the producer should map every rendered row) gets
    // a null occurrence + ordinal rather than shifting a neighbour's index.
    const side: AnchorSide = first === "+" ? "additions" : first === "-" ? "deletions" : "context";
    const fileLine = side === "deletions" ? oldLine : newLine;
    const occIndex = occurrenceIndexFor(hunk.hunkIndex, side);
    const occurrence = occIndex >= 0 ? hunk.occurrences[occIndex] : undefined;
    const occurrenceId = occurrence?.occurrenceId ?? null;
    const sideOrdinal = occurrence ? pushSide(occurrence, side, rawIndex) : null;
    if (side === "additions") newLine += 1;
    else if (side === "deletions") oldLine += 1;
    else {
      oldLine += 1;
      newLine += 1;
    }

    rows.push({
      rawIndex,
      text,
      kind: "content",
      hunkIndex: hunk.hunkIndex,
      occurrenceId,
      side,
      fileLine,
      sideOrdinal,
    });
  }

  return { rows, hunks };
}

// ── Resolution ────────────────────────────────────────────────────────────────
// A total function mirroring the substrate's four outcomes: resolved, or an
// orphan carrying one of no-occurrence / no-such-side / out-of-bounds.

export type OrphanReason = "no-occurrence" | "no-such-side" | "out-of-bounds";

export type RowResolution =
  | {
      outcome: "resolved";
      hunkIndex: number;
      side: AnchorSide | null;
      rawIndices: number[];
      startOrdinal: number | null;
      endOrdinal: number | null;
    }
  | { outcome: "orphan"; reason: OrphanReason };

export type SpanAnchorResult =
  | { outcome: "minted"; anchor: string; rawIndices: number[] }
  | { outcome: "failure"; reason: "no-rows" | "cross-occurrence" };

/** Mint a side-qualified occurrence span from the CodeView's file-line selection. */
export function spanAnchorForRows(
  registry: RowRegistry,
  selection: { line: number; side: AnchorSide; endLine?: number },
): SpanAnchorResult {
  const startLine = Math.min(selection.line, selection.endLine ?? selection.line);
  const endLine = Math.max(selection.line, selection.endLine ?? selection.line);
  const rows = registry.rows.filter(
    (row) =>
      row.kind === "content" &&
      row.side === selection.side &&
      row.fileLine !== null &&
      row.fileLine >= startLine &&
      row.fileLine <= endLine &&
      row.occurrenceId !== null,
  );
  if (rows.length === 0) return { outcome: "failure", reason: "no-rows" };
  const occurrenceId = rows[0]?.occurrenceId;
  if (!occurrenceId || rows.some((row) => row.occurrenceId !== occurrenceId)) {
    return { outcome: "failure", reason: "cross-occurrence" };
  }
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last || first.sideOrdinal === null || last.sideOrdinal === null) {
    return { outcome: "failure", reason: "no-rows" };
  }
  const span =
    first.sideOrdinal === last.sideOrdinal
      ? `L${first.sideOrdinal}`
      : `L${first.sideOrdinal}-L${last.sideOrdinal}`;
  return {
    outcome: "minted",
    anchor: `rennet:hunk/${occurrenceId}#${span}@${selection.side}`,
    rawIndices: rows.map((row) => row.rawIndex),
  };
}

/** Resolve a parsed anchor onto the registry's rendered rows, side-aware. */
export function resolveAnchorToRows(registry: RowRegistry, anchor: ParsedAnchor): RowResolution {
  // Find the occurrence SLICE whose id the anchor names, across every rendered hunk.
  // A rendered hunk can carry several occurrences (an oversize split), so the id — not
  // the hunk position — is the identity, and the span resolves within that slice's own
  // side arrays. This is the structural cure for #84: the anchor's id, not a positional
  // guess, decides where a mark lands.
  let hunkIndex = -1;
  let occurrence: RegistryOccurrence | undefined;
  for (const h of registry.hunks) {
    const found = h.occurrences.find((o) => o.occurrenceId === anchor.id);
    if (found) {
      hunkIndex = h.hunkIndex;
      occurrence = found;
      break;
    }
  }
  if (!occurrence) return { outcome: "orphan", reason: "no-occurrence" };

  if (anchor.span) {
    // Spans are always side-qualified (§3.2) — a span without a side cannot land;
    // this mirrors the substrate resolver, whose `no-such-side` fires exactly when
    // `parsed.side` is absent. An occurrence's side that merely has no rows is an
    // EMPTY side (the substrate builds all three side arrays, empty or not), so an
    // out-of-range span there is `out-of-bounds`, never `no-such-side`.
    if (!anchor.side) return { outcome: "orphan", reason: "no-such-side" };
    const sideRows = occurrence.sides[anchor.side] ?? [];
    const start = anchor.span.startLine;
    const end = anchor.span.endLine ?? start;
    if (start > sideRows.length || end > sideRows.length) {
      return { outcome: "orphan", reason: "out-of-bounds" };
    }
    return {
      outcome: "resolved",
      hunkIndex,
      side: anchor.side,
      rawIndices: sideRows.slice(start - 1, end),
      startOrdinal: start,
      endOrdinal: end,
    };
  }

  // Spanless. A side-only anchor glows that whole side (an empty side resolves to
  // no rows — placeMarks then routes such a mark to the tray, never silently); a
  // bare occurrence anchor marks all the occurrence's content rows.
  if (anchor.side) {
    return {
      outcome: "resolved",
      hunkIndex,
      side: anchor.side,
      rawIndices: [...(occurrence.sides[anchor.side] ?? [])],
      startOrdinal: null,
      endOrdinal: null,
    };
  }
  return {
    outcome: "resolved",
    hunkIndex,
    side: null,
    rawIndices: [...occurrence.contentRawIndices],
    startOrdinal: null,
    endOrdinal: null,
  };
}

// ── Mark placement ──────────────────────────────────────────────────────────
// The agent's hand: an L3 annotation or proposal, addressed by an anchor string.
// `placeMarks` partitions marks into those that land at their anchor and those
// whose anchor is unresolvable — the orphans, surfaced, never silently dropped.

export interface Mark {
  markId: string;
  markKind: "annotation" | "proposal";
  /** The raw `rennet:` anchor string (an L3 `target`). */
  anchor: string;
  /** Display text (annotation body or proposal payload). */
  body: string;
}

export interface PlacedMark {
  mark: Mark;
  hunkIndex: number;
  side: AnchorSide | null;
  /** Every row the mark's span covers (glows). */
  rawIndices: number[];
  /** The mark's home row — the FIRST spanned row, where the ◇ glyph + card render. */
  gutterRawIndex: number;
}

export interface OrphanMark {
  mark: Mark;
  reason: "malformed" | OrphanReason;
}

export interface MarkPlacement {
  placed: PlacedMark[];
  orphans: OrphanMark[];
}

/** Partition L3 marks into placed-at-their-anchor vs orphaned. Pure. */
export function placeMarks(registry: RowRegistry, marks: readonly Mark[]): MarkPlacement {
  const placed: PlacedMark[] = [];
  const orphans: OrphanMark[] = [];
  for (const mark of marks) {
    const parse = parseAnchor(mark.anchor);
    if (!parse.ok) {
      orphans.push({ mark, reason: "malformed" });
      continue;
    }
    const res = resolveAnchorToRows(registry, parse.anchor);
    if (res.outcome === "orphan") {
      orphans.push({ mark, reason: res.reason });
      continue;
    }
    const gutterRawIndex = res.rawIndices[0];
    if (gutterRawIndex === undefined) {
      // A resolved-but-empty span (nothing to glow) is treated as an orphan — the
      // mark still surfaces in the tray, never silently vanishes.
      orphans.push({ mark, reason: "out-of-bounds" });
      continue;
    }
    placed.push({
      mark,
      hunkIndex: res.hunkIndex,
      side: res.side,
      rawIndices: res.rawIndices,
      gutterRawIndex,
    });
  }
  return { placed, orphans };
}

export interface PlacementIndex {
  /** rawIndex → the placed marks that glow that row. */
  glow: Map<number, PlacedMark[]>;
  /** rawIndex → the placed marks whose home (gutter glyph + card) is that row. */
  gutter: Map<number, PlacedMark[]>;
}

/**
 * Build the row lookups the CodeView renders from. Keyed by rawIndex (a stable
 * row identity independent of the scroll window), so a row scrolling out and back
 * finds the same marks — the recycle-safety guarantee, expressed as data.
 */
export function indexPlacements(placement: MarkPlacement): PlacementIndex {
  const glow = new Map<number, PlacedMark[]>();
  const gutter = new Map<number, PlacedMark[]>();
  for (const placed of placement.placed) {
    for (const rawIndex of placed.rawIndices) {
      const bucket = glow.get(rawIndex) ?? [];
      bucket.push(placed);
      glow.set(rawIndex, bucket);
    }
    const home = gutter.get(placed.gutterRawIndex) ?? [];
    home.push(placed);
    gutter.set(placed.gutterRawIndex, home);
  }
  return { glow, gutter };
}

// ── The demoted strip: a navigating index ─────────────────────────────────────
// "Marks live at their anchors, never in a list." The strip becomes an INDEX: a
// jump-list to the in-code mark. Placed marks carry a target row to navigate to;
// orphans are present and flagged (routed to the tray), never silently dropped.

export interface MarkIndexItem {
  markId: string;
  markKind: "annotation" | "proposal";
  label: string;
  anchor: string;
  placed: boolean;
  /** The row to navigate to (a placed mark's gutter row); null for an orphan. */
  targetRawIndex: number | null;
  orphanReason: string | null;
}

export function markIndexItems(placement: MarkPlacement): MarkIndexItem[] {
  const items: MarkIndexItem[] = [];
  for (const placed of placement.placed) {
    items.push({
      markId: placed.mark.markId,
      markKind: placed.mark.markKind,
      label: placed.mark.body,
      anchor: placed.mark.anchor,
      placed: true,
      targetRawIndex: placed.gutterRawIndex,
      orphanReason: null,
    });
  }
  for (const orphan of placement.orphans) {
    items.push({
      markId: orphan.mark.markId,
      markKind: orphan.mark.markKind,
      label: orphan.mark.body,
      anchor: orphan.mark.anchor,
      placed: false,
      targetRawIndex: null,
      orphanReason: orphan.reason,
    });
  }
  return items;
}
