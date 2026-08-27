// Real-projector proof for #84: occurrence marks land on the RIGHT rows in the two
// shapes positional hunk→occurrence matching got wrong — a multi-file element and an
// oversize-split (R18) element. This is the ONLY package that sees both @rennet/core
// (the projector: decompose + buildElementDiffs) and @rennet/app-ui (the consumer: the
// anchor↔row registrar), so the whole seam is exercised end-to-end here.
//
// The diff text AND its occurrence mapping both come from the REAL `buildElementDiffs`
// output — never a hand-shaped `{ path, diff, hunkOccurrences }` literal. A fixture
// built one-element-per-file by hand would sidestep the very reorder/split the bug
// lives in; here `renderDiff`'s own file-sorting and split-dedupe produce the shapes,
// and the mark is placed over exactly what the UI would place it over in production.

import { buildRowRegistry, type Mark, placeMarks } from "@rennet/app-ui";
import { type AdmittedDocument, buildElementDiffs, decompose } from "@rennet/core";
import type { PatchFile, Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";

// Local test shapes — protocol's canvas-era state model (`AnalysisElement` family)
// was deleted (#489, B2). `buildElementDiffs` reads only each canvas's analysis
// elements (elementKey + anchor), so a minimal element + a plain angle→canvas record
// exercise the same seam.
type TestElement = {
  elementKey: string;
  docId: string;
  anchor: string;
  kind: string;
  title: string;
};
const ANGLES = ["spec", "sequence", "decisions", "noise", "flagged"] as const;

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base",
  headOid: "head",
};

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 4, deletions: 1, binary: false, patch };
}

function patchsetOf(id: string, files: PatchFile[]): Patchset {
  return {
    id,
    createdAt: "2026-08-11T00:00:00.000Z",
    repository,
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

function blankCanvas(elements: readonly TestElement[]): {
  layers: { analysis: { elements: readonly TestElement[] } };
} {
  return { layers: { analysis: { elements } } };
}

function setWith(angle: string, elements: readonly TestElement[]) {
  return Object.fromEntries(ANGLES.map((a) => [a, blankCanvas(a === angle ? elements : [])]));
}

/** The registry row a single-row span resolved to, by its exact text — the strongest
 *  "landed on the right code" assertion (a wrong-file/wrong-fragment row reads wrong). */
function resolvedRowText(
  diff: NonNullable<ReturnType<typeof buildElementDiffs>[string]>,
  mark: Mark,
): string {
  const registry = buildRowRegistry({ diff: diff.diff, hunkOccurrences: diff.hunkOccurrences });
  const placement = placeMarks(registry, [mark]);
  const placed = placement.placed.find((p) => p.mark.markId === mark.markId);
  if (!placed) {
    const orphan = placement.orphans.find((o) => o.mark.markId === mark.markId);
    throw new Error(`mark ${mark.markId} did not place (orphan: ${orphan?.reason ?? "missing"})`);
  }
  const row = registry.rows.find((r) => r.rawIndex === placed.gutterRawIndex);
  if (!row) throw new Error(`no row at gutter raw index ${placed.gutterRawIndex}`);
  return row.text;
}

describe("#84 real projector — marks land on the right rows for a multi-file element", () => {
  // A proposal chunk that regroups an implementation AND its test into ONE element.
  // `renderDiff` sorts files, so the rendered order is [foo.test.ts, foo.ts] — the
  // REVERSE of the chunk's `hunkIds` order [impl, test]. Positional matching tagged
  // rendered hunk 0 (the test) with the impl's id, landing the impl's mark on the
  // test's code. Identity matching lands each on its own file.
  const IMPL = `@@ -1,2 +1,3 @@
 export function foo() {
-  return 1;
+  return bar();
 }`;
  const TEST = `@@ -1,2 +1,3 @@
 import { foo } from "./foo";
-test("foo", () => {});
+test("foo", () => expect(foo()).toBe(2));
+test("bar", () => {});`;

  const patchset = patchsetOf("patch", [file("src/foo.ts", IMPL), file("src/foo.test.ts", TEST)]);
  const decomposition = decompose(patchset);
  const implHunk = decomposition.hunks.find((h) => h.filePath === "src/foo.ts");
  const testHunk = decomposition.hunks.find((h) => h.filePath === "src/foo.test.ts");

  const admitted: AdmittedDocument[] = [
    {
      docId: "pdoc",
      docType: "decomposition.proposal",
      body: {
        chunks: [
          {
            chunkId: "merged",
            title: "Foo + its test",
            // impl FIRST — the order a positional array would have used.
            hunkIds: [implHunk?.id ?? "", testHunk?.id ?? ""],
            angles: ["sequence"],
            rationale: "cohesive change",
          },
        ],
        edges: [],
        readingOrder: ["merged"],
        residue: [],
      },
    },
  ];
  const set = setWith("sequence", [
    {
      elementKey: "merged-el",
      docId: "pdoc",
      anchor: "rennet:chunk/merged",
      kind: "chunk",
      title: "M",
    },
  ]);
  const diffs = buildElementDiffs(set, decomposition, patchset, admitted);
  const entry = diffs["merged-el"];

  it("the impl's mark lands on the impl's added line, not the test's (rendered order ≠ hunkIds order)", () => {
    expect(entry).toBeDefined();
    // Sanity: files really did render test-first, so a positional [impl,test] is wrong.
    expect(entry?.paths).toEqual(["src/foo.test.ts", "src/foo.ts"]);
    const implMark: Mark = {
      markId: "on-impl",
      markKind: "annotation",
      anchor: `rennet:hunk/${implHunk?.id ?? ""}#L1@additions`,
      body: "the changed impl line",
    };
    // Lands on the implementation's added line — proof it resolved to the foo.ts hunk.
    expect(resolvedRowText(entry as NonNullable<typeof entry>, implMark)).toContain("return bar()");
  });

  it("the test's mark lands on the test's added line (the other file, same element)", () => {
    const testMark: Mark = {
      markId: "on-test",
      markKind: "annotation",
      anchor: `rennet:hunk/${testHunk?.id ?? ""}#L1@additions`,
      body: "the changed test line",
    };
    const text = resolvedRowText(entry as NonNullable<typeof entry>, testMark);
    expect(text).toContain("expect(foo()).toBe(2)");
    expect(text).not.toContain("return bar()");
  });
});

describe("#84 real projector — marks land on the right rows within an oversize split", () => {
  // A single raw `@@` hunk that decompose (maxChunkLoc:1) splits into three fragments,
  // all overlapping it, so `renderDiff` shows the parent hunk ONCE while the element
  // carries three occurrences. Positional matching (1 rendered hunk, 3 ids) collapsed;
  // identity + line-range slicing lands each fragment's mark on ITS own line.
  const BIG = `@@ -1,2 +1,5 @@
 const header = 0;
+const alpha = 1;
+const bravo = 2;
+const charlie = 3;
 const footer = 9;`;
  const patchset = patchsetOf("patch", [file("src/big.ts", BIG)]);
  const decomposition = decompose(patchset, { maxChunkLoc: 1 });
  // Three real split fragments (splitOf set), identified by their recomputed new-side
  // starts: alpha at new 1-2, bravo at new 3, charlie at new 4-5.
  const fragments = decomposition.hunks.filter((h) => h.splitOf !== undefined);
  const fragByNewStart = (newStart: number) => fragments.find((h) => h.newStart === newStart);

  const admitted: AdmittedDocument[] = [
    {
      docId: "pdoc",
      docType: "decomposition.proposal",
      body: {
        chunks: [
          {
            chunkId: "grp",
            title: "The split hunk, regrouped",
            hunkIds: fragments.map((h) => h.id),
            angles: ["sequence"],
            rationale: "one cohesive change",
          },
        ],
        edges: [],
        readingOrder: ["grp"],
        residue: [],
      },
    },
  ];
  const set = setWith("sequence", [
    {
      elementKey: "split-el",
      docId: "pdoc",
      anchor: "rennet:chunk/grp",
      kind: "chunk",
      title: "S",
    },
  ]);
  const diffs = buildElementDiffs(set, decomposition, patchset, admitted);
  const entry = diffs["split-el"];

  it("decompose really split the hunk into three overlapping fragments rendered once", () => {
    expect(fragments).toHaveLength(3);
    // The parent hunk header appears exactly once (the `seen` dedupe), so all three
    // fragments genuinely share one rendered `@@`.
    expect((entry?.diff.match(/@@ -1,2 \+1,5 @@/g) ?? []).length).toBe(1);
    expect(entry?.hunkOccurrences).toHaveLength(1);
    expect(entry?.hunkOccurrences?.[0]).toHaveLength(3);
  });

  it("the middle fragment's mark lands on ITS line (bravo), not the first fragment's", () => {
    const bravo = fragByNewStart(3);
    expect(bravo).toBeDefined();
    const mark: Mark = {
      markId: "on-bravo",
      markKind: "annotation",
      anchor: `rennet:hunk/${bravo?.id ?? ""}#L1@additions`,
      body: "middle fragment",
    };
    // The row it resolves to is bravo's own added line — under the pre-fix behaviour a
    // lone-occurrence-owns-all (or positional) match would land it on alpha or orphan.
    expect(resolvedRowText(entry as NonNullable<typeof entry>, mark)).toContain("bravo");
  });

  it("each fragment's #L1@additions resolves to a DISTINCT line — no bleed across the split", () => {
    const alpha = fragByNewStart(1);
    const charlie = fragByNewStart(4);
    const alphaText = resolvedRowText(entry as NonNullable<typeof entry>, {
      markId: "on-alpha",
      markKind: "annotation",
      anchor: `rennet:hunk/${alpha?.id ?? ""}#L1@additions`,
      body: "first fragment",
    });
    const charlieText = resolvedRowText(entry as NonNullable<typeof entry>, {
      markId: "on-charlie",
      markKind: "annotation",
      anchor: `rennet:hunk/${charlie?.id ?? ""}#L1@additions`,
      body: "third fragment",
    });
    expect(alphaText).toContain("alpha");
    expect(charlieText).toContain("charlie");
  });

  // #84 P1-3 — the case discovered mid-implementation and previously unguarded: the
  // floor puts each split fragment in its OWN chunk, so an element can own a SINGLE
  // fragment yet render the whole parent `@@` around it. The occurrence must still be
  // sliced to its own lines — a "lone occurrence owns every row" shortcut would put its
  // mark on the wrong line while every focused test stayed green. This locks it: the
  // element is anchored to just the MIDDLE fragment (a hunk anchor, no regroup), the
  // whole parent hunk renders, and the mark must land on bravo, with alpha/charlie rows
  // identity-less (they belong to fragments this element does not own).
  it("a lone-fragment element renders the whole parent hunk but slices its mark to its own line", () => {
    const bravo = fragByNewStart(3);
    expect(bravo?.splitOf).toBeDefined();
    const loneSet = setWith("sequence", [
      {
        elementKey: "lone-el",
        docId: "d",
        anchor: `rennet:hunk/${bravo?.id ?? ""}`,
        kind: "hunk",
        title: "B",
      },
    ]);
    const loneEntry = buildElementDiffs(loneSet, decomposition, patchset)["lone-el"];
    expect(loneEntry).toBeDefined();
    // The whole parent hunk renders (all three fragments' lines are visible)…
    expect(loneEntry?.diff).toContain("alpha");
    expect(loneEntry?.diff).toContain("charlie");
    // …but the element owns ONLY the middle fragment (single occurrence on one hunk).
    expect(loneEntry?.hunkOccurrences).toHaveLength(1);
    expect(loneEntry?.hunkOccurrences?.[0]).toHaveLength(1);
    expect(loneEntry?.hunkOccurrences?.[0]?.[0]?.id).toBe(bravo?.id);

    // The mark on bravo lands on bravo's line, NOT the parent hunk's first addition.
    const mark: Mark = {
      markId: "on-lone-bravo",
      markKind: "annotation",
      anchor: `rennet:hunk/${bravo?.id ?? ""}#L1@additions`,
      body: "lone middle fragment",
    };
    expect(resolvedRowText(loneEntry as NonNullable<typeof loneEntry>, mark)).toContain("bravo");

    // Foreign fragments' rows stay identity-less — they are rendered but not owned, so
    // no stray mark could ever anchor onto alpha/charlie through this element.
    const registry = buildRowRegistry({
      diff: (loneEntry as NonNullable<typeof loneEntry>).diff,
      hunkOccurrences: (loneEntry as NonNullable<typeof loneEntry>).hunkOccurrences,
    });
    const alphaRow = registry.rows.find((r) => r.text.includes("alpha"));
    const charlieRow = registry.rows.find((r) => r.text.includes("charlie"));
    const bravoRow = registry.rows.find((r) => r.text.includes("bravo"));
    expect(alphaRow?.occurrenceId).toBeNull();
    expect(charlieRow?.occurrenceId).toBeNull();
    expect(bravoRow?.occurrenceId).toBe(bravo?.id);
  });
});
