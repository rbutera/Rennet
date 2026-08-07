import { parseAnchor } from "@rennet/protocol";
import type { ParsedAnchor } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  buildRowRegistry,
  indexPlacements,
  type Mark,
  markIndexItems,
  placeMarks,
  resolveAnchorToRows,
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

function anchor(raw: string): ParsedAnchor {
  const parse = parseAnchor(raw);
  if (!parse.ok) throw new Error(`fixture anchor failed to parse: ${raw} (${parse.reason})`);
  return parse.anchor;
}

describe("buildRowRegistry — rows carry real file line + side + occurrence identity", () => {
  it("assigns real file lines per side from the @@ hunk headers, never diff-row indices", () => {
    const reg = buildRowRegistry({ diff: TWO_HUNK, occurrenceIds: ["H0", "H1"] });
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
    const reg = buildRowRegistry({ diff: TWO_HUNK, occurrenceIds: ["H0", "H1"] });
    const byRaw = new Map(reg.rows.map((row) => [row.rawIndex, row]));
    expect(byRaw.get(0)).toMatchObject({ kind: "file-header", side: null });
    expect(byRaw.get(1)).toMatchObject({ kind: "file-header", side: null });
    expect(byRaw.get(2)).toMatchObject({ kind: "hunk-header", side: null });
    // Header rows carry no side ordinal — they are not content.
    expect(byRaw.get(0)?.sideOrdinal).toBeNull();
  });

  it("maps each hunk to its occurrence id and groups per-side rows for resolution", () => {
    const reg = buildRowRegistry({ diff: TWO_HUNK, occurrenceIds: ["H0", "H1"] });
    expect(reg.hunks).toHaveLength(2);
    expect(reg.hunks[0]).toMatchObject({ occurrenceId: "H0" });
    expect(reg.hunks[1]).toMatchObject({ occurrenceId: "H1" });
    // Side arrays hold the raw indices in per-side order (ordinal = position + 1).
    expect(reg.hunks[0]?.sides.additions).toEqual([5, 6]);
    expect(reg.hunks[0]?.sides.deletions).toEqual([4]);
    expect(reg.hunks[0]?.sides.context).toEqual([3, 7]);
    expect(reg.hunks[1]?.sides.deletions).toEqual([9]);
    expect(reg.hunks[1]?.sides.additions).toEqual([10]);
    // Rows also carry their occurrence identity directly.
    expect(reg.rows.find((r) => r.rawIndex === 5)?.occurrenceId).toBe("H0");
    expect(reg.rows.find((r) => r.rawIndex === 10)?.occurrenceId).toBe("H1");
  });

  it("treats a header-less diff as one implicit hunk seeded at line 1 (the fixture/demo shape)", () => {
    const reg = buildRowRegistry({ diff: "   a\n+  b\n-  c\n   d", occurrenceIds: "only" });
    const byRaw = new Map(reg.rows.map((row) => [row.rawIndex, row]));
    expect(reg.hunks).toHaveLength(1);
    expect(reg.hunks[0]).toMatchObject({ occurrenceId: "only", header: null });
    expect(byRaw.get(0)).toMatchObject({ side: "context", fileLine: 1, sideOrdinal: 1 });
    expect(byRaw.get(1)).toMatchObject({ side: "additions", fileLine: 2, sideOrdinal: 1 });
    expect(byRaw.get(2)).toMatchObject({ side: "deletions", fileLine: 2, sideOrdinal: 1 });
    expect(byRaw.get(3)).toMatchObject({ side: "context", fileLine: 3, sideOrdinal: 2 });
  });

  it("an empty diff yields an empty registry", () => {
    const reg = buildRowRegistry({ diff: "", occurrenceIds: "x" });
    expect(reg.rows).toHaveLength(0);
    expect(reg.hunks).toHaveLength(0);
  });
});

describe("resolveAnchorToRows — an anchor-grammar span resolves to exactly the side-aware rows", () => {
  const reg = buildRowRegistry({ diff: TWO_HUNK, occurrenceIds: ["H0", "H1"] });

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

  it("orphans a side that has no rows in the hunk", () => {
    // H1 has no context rows.
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H1#L1@context"));
    expect(res).toEqual({ outcome: "orphan", reason: "no-such-side" });
  });

  it("a spanless whole-occurrence anchor resolves to all the hunk's content rows", () => {
    const res = resolveAnchorToRows(reg, anchor("rennet:hunk/H0"));
    expect(res).toMatchObject({ outcome: "resolved", side: null, rawIndices: [3, 4, 5, 6, 7] });
  });
});

describe("placeMarks — L3 marks land AT their anchors; unresolvable ones orphan, never drop", () => {
  const reg = buildRowRegistry({ diff: TWO_HUNK, occurrenceIds: ["H0", "H1"] });

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
    // pure function of (diff, occurrenceIds, marks). Building the registry twice and
    // placing yields byte-identical row identities, so a row scrolling out and back
    // (a CodeView window recycle) can never move a mark.
    const placementA = placeMarks(
      buildRowRegistry({ diff: TWO_HUNK, occurrenceIds: ["H0", "H1"] }),
      marks,
    );
    const placementB = placeMarks(
      buildRowRegistry({ diff: TWO_HUNK, occurrenceIds: ["H0", "H1"] }),
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
