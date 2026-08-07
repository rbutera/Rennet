import { parseAnchor } from "@rennet/protocol";
import type { AnchorSide, ParsedAnchor } from "@rennet/types";

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

export interface RegistryHunk {
  hunkIndex: number;
  occurrenceId: string | null;
  /** null for the implicit hunk of a header-less diff. */
  header: HunkHeader | null;
  headerRawIndex: number | null;
  /**
   * Per-side raw-index arrays in order. A side key is present only when that side
   * has at least one row (mirrors the manifest's `Partial<Record<AnchorSide,…>>`),
   * so a missing key is a genuine "no such side" for resolution.
   */
  sides: Partial<Record<AnchorSide, number[]>>;
  /** All content rows of the hunk, in order (for spanless whole-occurrence marks). */
  contentRawIndices: number[];
}

export interface RowRegistry {
  rows: RegistryRow[];
  hunks: RegistryHunk[];
}

export interface BuildRegistryInput {
  diff: string;
  /**
   * Occurrence id per hunk in diff order. A single string maps every hunk to it
   * (the single-occurrence element view, where the anchor id names one hunk); an
   * array maps hunk `i` to `occurrenceIds[i]`. Omit for identity-less rows.
   */
  occurrenceIds?: readonly string[] | string;
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

function occurrenceForHunk(
  occurrenceIds: readonly string[] | string | undefined,
  hunkIndex: number,
): string | null {
  if (occurrenceIds === undefined) return null;
  if (typeof occurrenceIds === "string") return occurrenceIds;
  return occurrenceIds[hunkIndex] ?? null;
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
  const sideCount: Record<AnchorSide, number> = { additions: 0, deletions: 0, context: 0 };

  // Returns the new hunk (assigned to `hunk` in the main body so control-flow
  // narrows it), and resets the per-hunk line counters + side ordinals.
  function openHunk(header: HunkHeader | null, headerRawIndex: number | null): RegistryHunk {
    const created: RegistryHunk = {
      hunkIndex: hunks.length,
      occurrenceId: occurrenceForHunk(input.occurrenceIds, hunks.length),
      header,
      headerRawIndex,
      sides: {},
      contentRawIndices: [],
    };
    hunks.push(created);
    oldLine = header ? header.oldStart : 1;
    newLine = header ? header.newStart : 1;
    sideCount.additions = 0;
    sideCount.deletions = 0;
    sideCount.context = 0;
    return created;
  }

  function pushSide(currentHunk: RegistryHunk, side: AnchorSide, rawIndex: number): number {
    let arr = currentHunk.sides[side];
    if (!arr) {
      arr = [];
      currentHunk.sides[side] = arr;
    }
    arr.push(rawIndex);
    currentHunk.contentRawIndices.push(rawIndex);
    sideCount[side] += 1;
    return sideCount[side];
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
        occurrenceId: hunk.occurrenceId,
        side: null,
        fileLine: null,
        sideOrdinal: null,
      });
      continue;
    }

    if (isFileHeader(text)) {
      rows.push({
        rawIndex,
        text,
        kind: "file-header",
        hunkIndex: hunk?.hunkIndex ?? -1,
        occurrenceId: hunk?.occurrenceId ?? null,
        side: null,
        fileLine: null,
        sideOrdinal: null,
      });
      continue;
    }

    if (text.startsWith("\\")) {
      // "\ No newline at end of file" and kin — metadata, not content.
      rows.push({
        rawIndex,
        text,
        kind: "meta",
        hunkIndex: hunk?.hunkIndex ?? -1,
        occurrenceId: hunk?.occurrenceId ?? null,
        side: null,
        fileLine: null,
        sideOrdinal: null,
      });
      continue;
    }

    // Content. A diff with no `@@` header (the fixture/demo shape) still has real
    // content rows — open one implicit hunk seeded at line 1/1 so they get identity.
    if (hunk === null) hunk = openHunk(null, null);

    const first = text.charAt(0);
    const side: AnchorSide = first === "+" ? "additions" : first === "-" ? "deletions" : "context";
    const fileLine = side === "deletions" ? oldLine : newLine;
    const sideOrdinal = pushSide(hunk, side, rawIndex);
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
      occurrenceId: hunk.occurrenceId,
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

/** Resolve a parsed anchor onto the registry's rendered rows, side-aware. */
export function resolveAnchorToRows(registry: RowRegistry, anchor: ParsedAnchor): RowResolution {
  const hunk = registry.hunks.find((h) => h.occurrenceId !== null && h.occurrenceId === anchor.id);
  if (!hunk) return { outcome: "orphan", reason: "no-occurrence" };

  if (anchor.span) {
    // Spans are always side-qualified (§3.2) — a span without a side cannot land.
    if (!anchor.side) return { outcome: "orphan", reason: "no-such-side" };
    const sideRows = hunk.sides[anchor.side];
    if (!sideRows) return { outcome: "orphan", reason: "no-such-side" };
    const start = anchor.span.startLine;
    const end = anchor.span.endLine ?? start;
    if (start > sideRows.length || end > sideRows.length) {
      return { outcome: "orphan", reason: "out-of-bounds" };
    }
    return {
      outcome: "resolved",
      hunkIndex: hunk.hunkIndex,
      side: anchor.side,
      rawIndices: sideRows.slice(start - 1, end),
      startOrdinal: start,
      endOrdinal: end,
    };
  }

  // Spanless. A side-only anchor glows that whole side; a bare occurrence anchor
  // marks all the hunk's content rows.
  if (anchor.side) {
    const sideRows = hunk.sides[anchor.side];
    if (!sideRows) return { outcome: "orphan", reason: "no-such-side" };
    return {
      outcome: "resolved",
      hunkIndex: hunk.hunkIndex,
      side: anchor.side,
      rawIndices: [...sideRows],
      startOrdinal: null,
      endOrdinal: null,
    };
  }
  return {
    outcome: "resolved",
    hunkIndex: hunk.hunkIndex,
    side: null,
    rawIndices: [...hunk.contentRawIndices],
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
