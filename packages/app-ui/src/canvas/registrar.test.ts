import type { ParsedAnchor, RenderedHunkOccurrence } from "@rennet/protocol";
import { parseAnchor } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  buildRowRegistry,
  indexPlacements,
  type Mark,
  markIndexItems,
  placeMarks,
  resolveAnchorToRows,
  spanAnchorForRows,
} from "./registrar";

// A two-hunk unified diff over one file. Traced by hand so every row's identity
// is a fixed expectation the test can go red against.
//
//  raw  text                                  kind         side  fileLine sideOrd
//   0   --- a/src/foo.ts                       file-header   -       -       -
//   1   +++ b/src/foo.ts                       file-header   -       -       -
//   2   @@ -10,3 +10,4 @@ function foo() {      hunk-header   -       -       -
//   3      const a = 1;                        content      ctx     10      1
//   4   -  const b = 2;                        content      del     11      1
//   5   +  const b = 3;                        content      add     11      1
//   6   +  const c = 4;                        content      add     12      2
//   7      return a;                           content      ctx     13      2
//   8   @@ -40,2 +41,2 @@ function bar() {      hunk-header   -       -       -
//   9   -  old();                              content      del     40      1
//  10   +  new();                              content      add     41      1
const TWO_HUNK = [
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,4 @@ function foo() {",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "   return a;",
  "@@ -40,2 +41,2 @@ function bar() {",
  "-  old();",
  "+  new();",
].join("\n");

// The occurrence mapping for TWO_HUNK: one occurrence per rendered @@ hunk, in diff
// order — the shape the real projector (`ElementDiff.hunkOccurrences`) emits.
const TWO_HUNK_OCC: RenderedHunkOccurrence[][] = [
  [{ id: "H0", oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 }],
  [{ id: "H1", oldStart: 40, oldLines: 2, newStart: 41, newLines: 2 }],
];

// A single-occurrence mapping over one rendered hunk, with the occurrence's REAL line
// range (rows are partitioned by containment, so the range must cover them).
const mapOne = (
  id: string,
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): RenderedHunkOccurrence[][] => [[{ id, oldStart, oldLines, newStart, newLines }]];

function anchor(raw: string): ParsedAnchor {
  const parse = parseAnchor(raw);
  if (!parse.ok) throw new Error(`fixture anchor failed to parse: ${raw} (${parse.reason})`);
  return parse.anchor;
}

describe("buildRowRegistry — rows carry real file line + side + occurrence identity", () => {
  it("assigns real file lines per side from the @@ hunk headers, never diff-row indices", () => {
    const reg = buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC });
    const byRaw = new Map(reg.rows.map((row) => [row.rawIndex, row]));

    // Context row: shows the NEW-file line (right column), not its raw index (3).
    expect(byRaw.get(3)).toMatchObject({ side: "context", fileLine: 10, sideOrdinal: 1 });
    // Deletion shows the OLD-file line; addition on the same visual line shows NEW.
    expect(byRaw.get(4)).toMatchObject({ side: "deletions", fileLine: 11, sideOrdinal: 1 });
    expect(byRaw.get(5)).toMatchObject({ side: "additions", fileLine: 11, sideOrdinal: 1 });
    expect(byRaw.get(6)).toMatchObject({ side: "additions", fileLine: 12, sideOrdinal: 2 });
    expect(byRaw.get(7)).toMatchObject({ side: "context", fileLine: 13, sideOrdinal: 2 });
    // Second hunk advances independently from its own @@ header (old 40 / new 41).
    expect(byRaw.get(9)).toMatchObject({ side: "deletions", fileLine: 40, sideOrdinal: 1 });
    expect(byRaw.get(10)).toMatchObject({ side: "additions", fileLine: 41, sideOrdinal: 1 });
  });

  it("classifies +++ / --- / @@ rows as headers, never as add/del content", () => {
    const reg = buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC });
    const byRaw = new Map(reg.rows.map((row) => [row.rawIndex, row]));
    expect(byRaw.get(0)).toMatchObject({ kind: "file-header", side: null });
    expect(byRaw.get(1)).toMatchObject({ kind: "file-header", side: null });
    expect(byRaw.get(2)).toMatchObject({ kind: "hunk-header", side: null });
    // Header rows carry no side ordinal — they are not content.
    expect(byRaw.get(0)?.sideOrdinal).toBeNull();
  });

  it("maps each hunk to its occurrence id and groups per-side rows for resolution", () => {
    const reg = buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC });
    expect(reg.hunks).toHaveLength(2);
    // Each rendered hunk carries exactly its one occurrence.
    expect(reg.hunks[0]?.occurrences.map((o) => o.occurrenceId)).toEqual(["H0"]);
    expect(reg.hunks[1]?.occurrences.map((o) => o.occurrenceId)).toEqual(["H1"]);
    // Side arrays hold the raw indices in per-side order (ordinal = position + 1).
    expect(reg.hunks[0]?.occurrences[0]?.sides.additions).toEqual([5, 6]);
    expect(reg.hunks[0]?.occurrences[0]?.sides.deletions).toEqual([4]);
    expect(reg.hunks[0]?.occurrences[0]?.sides.context).toEqual([3, 7]);
    expect(reg.hunks[1]?.occurrences[0]?.sides.deletions).toEqual([9]);
    expect(reg.hunks[1]?.occurrences[0]?.sides.additions).toEqual([10]);
    // Rows also carry their occurrence identity directly.
    expect(reg.rows.find((r) => r.rawIndex === 5)?.occurrenceId).toBe("H0");
    expect(reg.rows.find((r) => r.rawIndex === 10)?.occurrenceId).toBe("H1");
  });

  it("treats a header-less diff as one implicit hunk seeded at line 1 (the fixture/demo shape)", () => {
    const reg = buildRowRegistry({
      diff: "   a\n+  b\n-  c\n   d",
      hunkOccurrences: mapOne("only", 1, 3, 1, 3),
    });
    const byRaw = new Map(reg.rows.map((row) => [row.rawIndex, row]));
    expect(reg.hunks).toHaveLength(1);
    expect(reg.hunks[0]?.header).toBeNull();
    expect(reg.hunks[0]?.occurrences.map((o) => o.occurrenceId)).toEqual(["only"]);
    expect(byRaw.get(0)).toMatchObject({ side: "context", fileLine: 1, sideOrdinal: 1 });
    expect(byRaw.get(1)).toMatchObject({ side: "additions", fileLine: 2, sideOrdinal: 1 });
    expect(byRaw.get(2)).toMatchObject({ side: "deletions", fileLine: 2, sideOrdinal: 1 });
    expect(byRaw.get(3)).toMatchObject({ side: "context", fileLine: 3, sideOrdinal: 2 });
  });

  it("an empty diff yields an empty registry", () => {
    const reg = buildRowRegistry({ diff: "", hunkOccurrences: mapOne("x", 1, 1, 1, 1) });
    expect(reg.rows).toHaveLength(0);
    expect(reg.hunks).toHaveLength(0);
  });

  it("the trailing '' of a newline-terminated diff is metadata, never a phantom context row", () => {
    // Real git diffs end in a newline, so `diff.split("\n")` yields a trailing "".
    // The substrate never counts it (its body filter needs first char +/-/space),
    // so it must NOT enter sides.context or an ordinal would shift and #Ln@context
    // resolve one row too far.
    const reg = buildRowRegistry({
      diff: "@@ -1,1 +1,1 @@\n context\n-old\n+new\n",
      hunkOccurrences: mapOne("H", 1, 1, 1, 1),
    });
    const trailing = reg.rows.at(-1);
    expect(trailing).toMatchObject({ text: "", kind: "meta", side: null, sideOrdinal: null });
    // Exactly one context row (the ' context' line); the '' is not among them.
    expect(reg.hunks[0]?.occurrences[0]?.sides.context).toHaveLength(1);
  });

  it("an in-hunk line reading '--- x' / '+++ x' is a real deletion / addition, not a header", () => {
    // A deleted source line `-- x` renders as diff line `--- x`; an added `++ y` as
    // `+++ y`. Only the PREAMBLE `--- `/`+++ ` path lines are headers — inside a
    // hunk these are content (first char -/+), exactly as the substrate counts them.
    const reg = buildRowRegistry({
      diff: "@@ -1,2 +1,2 @@\n--- x\n-keep\n+++ y\n+kept\n",
      hunkOccurrences: mapOne("H", 1, 2, 1, 2),
    });
    const byRaw = new Map(reg.rows.map((row) => [row.rawIndex, row]));
    expect(byRaw.get(1)).toMatchObject({ kind: "content", side: "deletions", sideOrdinal: 1 });
    expect(byRaw.get(2)).toMatchObject({ kind: "content", side: "deletions", sideOrdinal: 2 });
    expect(byRaw.get(3)).toMatchObject({ kind: "content", side: "additions", sideOrdinal: 1 });
    expect(byRaw.get(4)).toMatchObject({ kind: "content", side: "additions", sideOrdinal: 2 });
    expect(reg.hunks[0]?.occurrences[0]?.sides.deletions).toEqual([1, 2]);
    expect(reg.hunks[0]?.occurrences[0]?.sides.additions).toEqual([3, 4]);
  });
});

describe("resolveAnchorToRows — an anchor-grammar span resolves to exactly the side-aware rows", () => {
  const reg = buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC });

  it("resolves #L1-L2@additions to exactly the two addition rows of that occurrence", () => {
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H0#L1-L2@additions"));
    expect(res).toMatchObject({ outcome: "resolved", side: "additions", rawIndices: [5, 6] });
  });

  it("is side-aware: #L1@additions and #L1@deletions resolve to DIFFERENT rows", () => {
    const add = resolveAnchorToRows(reg, anchor("rennet:hunk/H0#L1@additions"));
    const del = resolveAnchorToRows(reg, anchor("rennet:hunk/H0#L1@deletions"));
    expect(add).toMatchObject({ outcome: "resolved", rawIndices: [5] });
    expect(del).toMatchObject({ outcome: "resolved", rawIndices: [4] });
  });

  it("resolves against the right occurrence — H1's #L1@additions is a different row than H0's", () => {
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H1#L1@additions"));
    expect(res).toMatchObject({ outcome: "resolved", rawIndices: [10] });
  });

  it("orphans out-of-bounds spans (mirrors the substrate's four-outcome resolver)", () => {
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H0#L3@additions"));
    expect(res).toEqual({ outcome: "orphan", reason: "out-of-bounds" });
  });

  it("orphans an unknown occurrence id", () => {
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/NOPE#L1@additions"));
    expect(res).toEqual({ outcome: "orphan", reason: "no-occurrence" });
  });

  it("a span on an existing-but-empty side is out-of-bounds, matching the substrate", () => {
    // H1 has no context rows. The substrate builds all three side arrays (empty or
    // not), so its resolver returns out-of-bounds — NOT no-such-side — here. Parity.
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H1#L1@context"));
    expect(res).toEqual({ outcome: "orphan", reason: "out-of-bounds" });
  });

  it("reserves no-such-side for a span with no side qualifier (mirrors the substrate)", () => {
    // `#L1` (no @side) parses as a span with side undefined; the substrate's
    // resolver hits no-such-side exactly when parsed.side is absent.
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H0#L1"));
    expect(res).toEqual({ outcome: "orphan", reason: "no-such-side" });
  });

  it("a spanless whole-occurrence anchor resolves to all the hunk's content rows", () => {
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H0"));
    expect(res).toMatchObject({ outcome: "resolved", side: null, rawIndices: [3, 4, 5, 6, 7] });
  });

  it("does not resolve a context ordinal past the last real row into a newline artifact", () => {
    // One real context row, then the trailing "" of a newline-terminated diff.
    // #L2@context must orphan (out-of-bounds), never land on the "" phantom.
    const nlReg = buildRowRegistry({
      diff: "@@ -1,1 +1,1 @@\n context\n-old\n+new\n",
      hunkOccurrences: mapOne("H", 1, 1, 1, 1),
    });
    const res = resolveAnchorToRows(nlReg, anchor("rennet:hunk/H#L2@context"));
    expect(res).toEqual({ outcome: "orphan", reason: "out-of-bounds" });
  });
});

describe("spanAnchorForRows — minting and resolving are exact inverses (#79)", () => {
  it("uses occurrence-relative side ordinals when the hunk does not start at line 1", () => {
    const reg = buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC });
    const minted = spanAnchorForRows(reg, { line: 11, endLine: 12, side: "additions" });
    expect(minted).toEqual({
      outcome: "minted",
      anchor: "rennet:hunk/H0#L1-L2@additions",
      rawIndices: [5, 6],
    });
    if (minted.outcome !== "minted") throw new Error("fixture selection did not mint");
    const parsed = parseAnchor(minted.anchor);
    if (!parsed.ok) throw new Error(`minted anchor did not parse: ${parsed.reason}`);
    expect(resolveAnchorToRows(reg, parsed.anchor)).toMatchObject({
      outcome: "resolved",
      rawIndices: minted.rawIndices,
    });
  });

  it("round-trips within the selected oversize-split occurrence", () => {
    const diff = [
      "@@ -101,6 +101,6 @@",
      " line one",
      "-old two",
      "+new two",
      " line three",
      "-old four",
      "+new four",
      " line five",
      " line six",
    ].join("\n");
    const reg = buildRowRegistry({
      diff,
      hunkOccurrences: [
        [
          { id: "frag-a", oldStart: 101, oldLines: 3, newStart: 101, newLines: 3 },
          { id: "frag-b", oldStart: 104, oldLines: 3, newStart: 104, newLines: 3 },
        ],
      ],
    });
    const minted = spanAnchorForRows(reg, { line: 104, side: "additions" });
    expect(minted).toEqual({
      outcome: "minted",
      anchor: "rennet:hunk/frag-b#L1@additions",
      rawIndices: [6],
    });
    if (minted.outcome !== "minted") throw new Error("fixture selection did not mint");
    const parsed = parseAnchor(minted.anchor);
    if (!parsed.ok) throw new Error(`minted anchor did not parse: ${parsed.reason}`);
    expect(resolveAnchorToRows(reg, parsed.anchor)).toMatchObject({
      outcome: "resolved",
      rawIndices: minted.rawIndices,
    });
  });

  it("returns distinguished failures instead of throwing or crossing occurrence identity", () => {
    const reg = buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC });
    expect(spanAnchorForRows(reg, { line: 999, side: "additions" })).toEqual({
      outcome: "failure",
      reason: "no-rows",
    });
    expect(spanAnchorForRows(reg, { line: 11, endLine: 41, side: "additions" })).toEqual({
      outcome: "failure",
      reason: "cross-occurrence",
    });
  });
});

// #84 — the structural fix: identity, never position, decides where a mark lands.
// These two shapes are exactly where positional `occurrenceIds[hunkIndex]` misfired.
describe("resolveAnchorToRows — identity survives multi-file order and oversize splits (#84)", () => {
  it("a multi-file element resolves by occurrence id even when rendered @@ order ≠ decomposition order", () => {
    // Two files' hunks concatenated with byte-IDENTICAL @@ headers and NO file marker
    // between them — the registrar cannot tell them apart from text. Only the producer's
    // per-@@ occurrence mapping can, and the second rendered hunk carries occurrence B.
    // A positional array that put B first (its decomposition order) would land B's mark
    // on the FIRST file's rows.
    const diff = [
      "@@ -1,1 +1,2 @@",
      " export function a() {}",
      "+const fromFileA = 1;",
      "@@ -1,1 +1,2 @@",
      " export function b() {}",
      "+const fromFileB = 2;",
    ].join("\n");
    const hunkOccurrences: RenderedHunkOccurrence[][] = [
      [{ id: "occA", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
      [{ id: "occB", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
    ];
    const reg = buildRowRegistry({ diff, hunkOccurrences });

    // occA's addition is raw index 2 (file A's `+const fromFileA`); occB's is raw 5.
    expect(resolveAnchorToRows(reg, anchor("rennet:hunk/occA#L1@additions"))).toMatchObject({
      outcome: "resolved",
      rawIndices: [2],
    });
    expect(resolveAnchorToRows(reg, anchor("rennet:hunk/occB#L1@additions"))).toMatchObject({
      outcome: "resolved",
      rawIndices: [5],
    });
    // And the rows carry the right identity — occB's added line, never occA's.
    expect(reg.rows.find((r) => r.rawIndex === 2)?.occurrenceId).toBe("occA");
    expect(reg.rows.find((r) => r.rawIndex === 5)?.occurrenceId).toBe("occB");
  });

  it("an oversize-split raw hunk hosts BOTH fragments, each span within its own slice", () => {
    // One raw @@ carries two split fragments (R18). Positional matching gave the whole
    // hunk to frag-a and orphaned frag-b, though frag-b's line is right there. With the
    // fragment line ranges, frag-b#L1@additions must land on ITS addition ("new four"),
    // the raw hunk's SECOND addition — not frag-a's, and not orphaned.
    //
    //  raw  text          side  oldLn newLn  fragment
    //   0   @@ -1,6 +1,6   hdr
    //   1    line one      ctx   1     1      a
    //   2   -old two       del   2            a
    //   3   +new two       add         2      a
    //   4    line three    ctx   3     3      a
    //   5   -old four      del   4            b
    //   6   +new four      add         4      b
    //   7    line five     ctx   5     5      b
    //   8    line six      ctx   6     6      b
    const diff = [
      "@@ -1,6 +1,6 @@",
      " line one",
      "-old two",
      "+new two",
      " line three",
      "-old four",
      "+new four",
      " line five",
      " line six",
    ].join("\n");
    const hunkOccurrences: RenderedHunkOccurrence[][] = [
      [
        { id: "frag-a", oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 },
        { id: "frag-b", oldStart: 4, oldLines: 3, newStart: 4, newLines: 3 },
      ],
    ];
    const reg = buildRowRegistry({ diff, hunkOccurrences });

    // ONE rendered hunk, but it carries BOTH occurrences.
    expect(reg.hunks).toHaveLength(1);
    expect(reg.hunks[0]?.occurrences.map((o) => o.occurrenceId)).toEqual(["frag-a", "frag-b"]);

    // Each fragment's span indexes into ITS OWN slice, so ordinal 1 means different rows.
    expect(resolveAnchorToRows(reg, anchor("rennet:hunk/frag-a#L1@additions"))).toMatchObject({
      outcome: "resolved",
      rawIndices: [3], // "+new two"
    });
    expect(resolveAnchorToRows(reg, anchor("rennet:hunk/frag-b#L1@additions"))).toMatchObject({
      outcome: "resolved",
      rawIndices: [6], // "+new four" — the raw hunk's 2nd addition, NOT orphaned
    });
    expect(resolveAnchorToRows(reg, anchor("rennet:hunk/frag-b#L1@deletions"))).toMatchObject({
      outcome: "resolved",
      rawIndices: [5], // "-old four"
    });
    // Rows partitioned to the right fragment by line-range containment.
    expect(reg.rows.find((r) => r.rawIndex === 3)?.occurrenceId).toBe("frag-a");
    expect(reg.rows.find((r) => r.rawIndex === 6)?.occurrenceId).toBe("frag-b");
    expect(reg.rows.find((r) => r.rawIndex === 8)?.occurrenceId).toBe("frag-b");
  });
});

describe("placeMarks — L3 marks land AT their anchors; unresolvable ones orphan, never drop", () => {
  const reg = buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC });

  const marks: Mark[] = [
    {
      markId: "a1",
      markKind: "annotation",
      anchor: "rennet:hunk/H0#L1-L2@additions",
      body: "new lines",
    },
    { markId: "p1", markKind: "proposal", anchor: "rennet:hunk/H1#L1@additions", body: "approve" },
    {
      markId: "orphan-oob",
      markKind: "annotation",
      anchor: "rennet:hunk/H0#L9@additions",
      body: "gone",
    },
    { markId: "orphan-bad", markKind: "annotation", anchor: "not-an-anchor", body: "malformed" },
  ];

  it("partitions marks into placed (with a gutter row) and orphaned (with a reason)", () => {
    const placement = placeMarks(reg, marks);
    expect(placement.placed.map((p) => p.mark.markId)).toEqual(["a1", "p1"]);
    expect(placement.orphans.map((o) => o.mark.markId)).toEqual(["orphan-oob", "orphan-bad"]);

    const a1 = placement.placed.find((p) => p.mark.markId === "a1");
    expect(a1).toMatchObject({ rawIndices: [5, 6], gutterRawIndex: 5, side: "additions" });

    const oob = placement.orphans.find((o) => o.mark.markId === "orphan-oob");
    expect(oob?.reason).toBe("out-of-bounds");
    const bad = placement.orphans.find((o) => o.mark.markId === "orphan-bad");
    expect(bad?.reason).toBe("malformed");
  });

  it("recycle-safety: placement is keyed by anchor identity, not by any window/scroll input", () => {
    // The registrar and placeMarks take NO scroll/window parameter — placement is a
    // pure function of (diff, hunkOccurrences, marks). Building the registry twice and
    // placing yields byte-identical row identities, so a row scrolling out and back
    // (a CodeView window recycle) can never move a mark.
    const placementA = placeMarks(
      buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC }),
      marks,
    );
    const placementB = placeMarks(
      buildRowRegistry({ diff: TWO_HUNK, hunkOccurrences: TWO_HUNK_OCC }),
      marks,
    );
    expect(placementA).toEqual(placementB);
    // The glow lookup is keyed by rawIndex (a stable row identity), and both addition
    // rows glow for the span mark — the highlight never lives on a recycled row object.
    const { glow, gutter } = indexPlacements(placementA);
    expect(glow.get(5)?.map((p) => p.mark.markId)).toContain("a1");
    expect(glow.get(6)?.map((p) => p.mark.markId)).toContain("a1");
    expect(gutter.get(5)?.map((p) => p.mark.markId)).toContain("a1");
    // The gutter (mark's home) is the FIRST spanned row only, never every glowed row.
    expect(gutter.get(6) ?? []).toHaveLength(0);
  });

  it("a spanless side-only anchor on an EMPTY side orphans, never a phantom placement (#84 P2)", () => {
    // `rennet:hunk/H1@context` resolves (H1 exists) but to ZERO rows — H1 has no
    // context lines. resolveAnchorToRows returns `resolved` with an empty rawIndices,
    // so the mark has no home row. placeMarks MUST route it to the tray; the guard that
    // catches a resolved-but-empty span is what stops it rendering as `placed: true`
    // with an undefined gutter row (deleting that guard reddens exactly this).
    const emptySideMark: Mark = {
      markId: "empty-side",
      markKind: "annotation",
      anchor: "rennet:hunk/H1@context",
      body: "whole context side (which is empty)",
    };
    const placement = placeMarks(reg, [emptySideMark]);
    expect(placement.placed.map((p) => p.mark.markId)).not.toContain("empty-side");
    const orphan = placement.orphans.find((o) => o.mark.markId === "empty-side");
    expect(orphan).toBeDefined();
    expect(orphan?.reason).toBe("out-of-bounds");
  });

  it("markIndexItems builds a navigating index: placed marks carry a target row, orphans are flagged", () => {
    const placement = placeMarks(reg, marks);
    const items = markIndexItems(placement);
    const byId = new Map(items.map((item) => [item.markId, item]));

    // A placed mark navigates to its in-code anchor (its gutter row) — the strip is
    // an index, never the mark's home.
    expect(byId.get("a1")).toMatchObject({ placed: true, targetRawIndex: 5, orphanReason: null });
    // An orphan is present and flagged (routed to the tray), never silently dropped.
    expect(byId.get("orphan-oob")).toMatchObject({ placed: false, targetRawIndex: null });
    expect(byId.get("orphan-oob")?.orphanReason).toBe("out-of-bounds");
    // Every mark survives into the index — nothing vanishes.
    expect(items).toHaveLength(marks.length);
  });
});
