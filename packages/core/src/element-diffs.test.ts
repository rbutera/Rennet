import type {
  AnalysisElement,
  Canvas,
  CanvasAngle,
  Decomposition,
  Hunk,
  PatchFile,
  Patchset,
} from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { type AdmittedDocument, buildCanvas } from "./canvas";
import { decompose } from "./decomposition";
import { buildElementDiffs } from "./element-diffs";
import { buildReviewCanvases } from "./pipeline";

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
    createdAt: "2026-08-07T00:00:00.000Z",
    repository,
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

// A real captured hunk. Its content is distinctive (harvest/audit/oldValue) and
// carries NONE of demoDiff's signature tokens (demoDiff emits `legacy…` lines).
const WIDGET = `@@ -1,3 +1,6 @@
 export function widget() {
-  return oldValue;
+  const next = harvest(41);
+  audit(next);
+  return next;
 }
+export const helper = () => widget();`;

function blankCanvas(
  angle: CanvasAngle,
  elements: Canvas["layers"]["analysis"]["elements"],
): Canvas {
  return {
    canvasId: `cid-${angle}`,
    reviewId: "r1",
    patchsetId: "patch-1",
    angle,
    layers: {
      substrate: { chunks: [] },
      analysis: { elements, cohorts: [], readingOrder: elements.map((el) => el.elementKey) },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  };
}

function setWith(
  angle: CanvasAngle,
  elements: Canvas["layers"]["analysis"]["elements"],
): Record<CanvasAngle, Canvas> {
  return Object.fromEntries(
    CANVAS_ANGLES.map((a) => [a, blankCanvas(a, a === angle ? elements : [])]),
  ) as Record<CanvasAngle, Canvas>;
}

describe("buildReviewCanvases delivers real element diffs", () => {
  it("delivers the real captured hunk for a sequence chunk element (not demoDiff)", async () => {
    const patchset = patchsetOf("patch-1", [file("src/widget.ts", WIDGET)]);
    const result = await buildReviewCanvases({ reviewId: "r1", patchset, dispositions: [] });

    const element = result.canvases.sequence.layers.analysis.elements[0];
    expect(element).toBeDefined();
    const entry = result.elementDiffs[element?.elementKey ?? ""];

    expect(entry).toBeDefined();
    expect(entry?.path).toBe("src/widget.ts");
    // BYTE-EXACT to the captured patch: header + interleaved body, verbatim. This
    // is the load-bearing faithfulness assertion — a reordered or fabricated diff
    // (all dels then all adds, or a line changed) is NOT byte-equal to WIDGET and
    // fails here, which the earlier per-line `toContain` checks could not detect.
    expect(entry?.diff).toBe(WIDGET);
    // The demoDiff fixture is gone from the real path.
    expect(entry?.diff).not.toContain("legacy");
  });
});

describe("buildElementDiffs", () => {
  const patchset = patchsetOf("patch-1", [file("src/widget.ts", WIDGET)]);
  const decomposition = decompose(patchset);

  it("resolves a hunk anchor to that single hunk and skips doc-anchored elements", () => {
    const hunkId = decomposition.hunks[0]?.id ?? "";
    expect(hunkId).not.toBe("");
    const set = setWith("claims", [
      { elementKey: "eh", docId: "d", anchor: `rennet:hunk/${hunkId}`, kind: "hunk", title: "H" },
      { elementKey: "ed", docId: "d2", anchor: "rennet:doc/d2", kind: "claim", title: "D" },
    ]);

    const diffs = buildElementDiffs(set, decomposition, patchset);

    expect(diffs.eh).toBeDefined();
    expect(diffs.eh?.path).toBe("src/widget.ts");
    // Byte-exact: the single hunk resolves to the whole verbatim raw hunk.
    expect(diffs.eh?.diff).toBe(WIDGET);
    // A document-anchored element has no code diff — no entry, never a fixture.
    expect(diffs.ed).toBeUndefined();
  });

  it("is a pure function of its inputs", () => {
    const set = setWith("sequence", [
      { elementKey: "ec", docId: "d", anchor: "rennet:chunk/c1", kind: "chunk", title: "C" },
    ]);
    expect(buildElementDiffs(set, decomposition, patchset)).toEqual(
      buildElementDiffs(set, decomposition, patchset),
    );
  });

  // A two-hunk file: proves the slicer selects the RIGHT raw hunk for an element's
  // hunk, with no bleed from its neighbour. A single-hunk fixture cannot detect
  // wrong-hunk selection (the whole file is the only hunk).
  const HUNK_A = `@@ -1,3 +1,4 @@
 export function alpha() {
-  return old_a;
+  return new_a;
+  const marker_a = 1;
 }`;
  const HUNK_B = `@@ -20,3 +21,4 @@
 export function beta() {
-  return old_b;
+  return new_b;
+  const marker_b = 2;
 }`;
  const TWO_HUNK = `${HUNK_A}\n${HUNK_B}`;

  it("selects exactly the anchored hunk from a multi-hunk file (no neighbour bleed)", () => {
    const twoHunkPatchset = patchsetOf("patch-2", [file("src/two.ts", TWO_HUNK)]);
    const twoHunkDecomp = decompose(twoHunkPatchset);
    // The second decomposition hunk is the one whose new-side starts at 21 (HUNK_B).
    const second = twoHunkDecomp.hunks.find((hunk) => hunk.newStart === 21);
    expect(second).toBeDefined();
    const set = setWith("claims", [
      {
        elementKey: "e2",
        docId: "d",
        anchor: `rennet:hunk/${second?.id ?? ""}`,
        kind: "hunk",
        title: "B",
      },
    ]);

    const diffs = buildElementDiffs(set, twoHunkDecomp, twoHunkPatchset);

    // Exactly HUNK_B, byte-for-byte — and NONE of HUNK_A's distinctive tokens.
    expect(diffs.e2?.diff).toBe(HUNK_B);
    expect(diffs.e2?.diff).not.toContain("marker_a");
    expect(diffs.e2?.diff).not.toContain("alpha");
  });

  // Issue #60 on the AGENTIC path: when a harness adapter runs the decomposition
  // angle, the sequence canvas anchors its elements to the admitted proposal's
  // chunk ids (canvas.ts `projectSequence`), which are agent-authored regroupings
  // NOT present in the deterministic floor's `decomposition.chunks`. The slicer
  // must resolve those through the admitted proposal's chunk→hunk binding (the
  // hunk ids ARE real occurrences), or zoom on the primary reading surface shows
  // NOTHING in production. The floor path alone is not enough.
  it("resolves an agentic proposal chunk id (not in the floor) via the admitted docs", () => {
    const hunkId = decomposition.hunks[0]?.id ?? "";
    expect(hunkId).not.toBe("");
    const element: AnalysisElement = {
      elementKey: "seq-el",
      docId: "pdoc",
      anchor: "rennet:chunk/agent-group",
      kind: "chunk",
      title: "Agent group",
    };
    const set = setWith("sequence", [element]);
    const admitted: AdmittedDocument[] = [
      {
        docId: "pdoc",
        docType: "decomposition.proposal",
        body: {
          chunks: [
            {
              chunkId: "agent-group",
              title: "Agent group",
              hunkIds: [hunkId],
              angles: ["sequence"],
              rationale: "regrouped",
            },
          ],
          edges: [],
          readingOrder: ["agent-group"],
          residue: [],
        },
      },
    ];

    // Without the admitted docs the agentic chunk id resolves to nothing.
    expect(buildElementDiffs(set, decomposition, patchset)["seq-el"]).toBeUndefined();
    // With them, zoom shows the real captured hunk, byte-exact.
    const diffs = buildElementDiffs(set, decomposition, patchset, admitted);
    expect(diffs["seq-el"]?.path).toBe("src/widget.ts");
    expect(diffs["seq-el"]?.diff).toBe(WIDGET);
  });

  // #250 real-shape PROVENANCE: this pins the exact producer output the workspace
  // mark index (packages/ui) must own — a proposal chunk element whose anchor is
  // NOT in the floor substrate, the floor hunk that IS in the substrate (so the
  // coarse verdict says "placed"), and the diff's `hunkOccurrences` carrying that
  // floor hunk (the ownership signal the fix reads). The UI component test
  // (workspace-mark-orphan.dom.test.tsx) asserts the orphan behavior over exactly
  // this shape; this test is why that fixture is faithful to the live pipeline and
  // not a self-agreeing hand-shape.
  it("REAL SHAPE (#250): a proposal element sits outside the substrate while its diff carries the floor hunk", () => {
    const floorHunkId = decomposition.hunks[0]?.id ?? "";
    expect(floorHunkId).not.toBe("");
    const admitted: AdmittedDocument[] = [
      {
        docId: "pdoc",
        docType: "decomposition.proposal",
        body: {
          chunks: [
            {
              chunkId: "agent-group",
              title: "Agent group",
              hunkIds: [floorHunkId],
              angles: ["sequence"],
              rationale: "regrouped",
            },
          ],
          edges: [],
          readingOrder: ["agent-group"],
          residue: [],
        },
      },
    ];
    // The REAL sequence canvas from the REAL producer.
    const sequence = buildCanvas({
      reviewId: "r1",
      patchsetId: "patch-1",
      angle: "sequence",
      admittedDocs: admitted,
      decomposition,
      dispositions: [],
      canvasEvents: [],
    });
    const element = sequence.layers.analysis.elements[0];
    // (1) The proposal element anchors to the agent chunk id — NOT a substrate chunk.
    expect(element?.anchor).toBe("rennet:chunk/agent-group");
    expect(sequence.layers.substrate.chunks.map((chunk) => chunk.chunkId)).not.toContain(
      "agent-group",
    );
    // (2) The floor hunk IS in the substrate (so the workspace coarse verdict says placed).
    expect(sequence.layers.substrate.chunks.flatMap((chunk) => chunk.hunkIds)).toContain(
      floorHunkId,
    );
    // (3) The diff producer maps the regrouped floor hunk onto the proposal element —
    // the ownership signal the mark index must read but the substrate lookup misses.
    const set = Object.fromEntries(
      CANVAS_ANGLES.map((angle) => [
        angle,
        angle === "sequence" ? sequence : blankCanvas(angle, []),
      ]),
    ) as Record<CanvasAngle, Canvas>;
    const diffs = buildElementDiffs(set, decomposition, patchset, admitted);
    // Pin the COMPLETE occurrence descriptor (ranges included), derived from the source
    // hunk, not just its id. The prior `.map(occ => occ.id)` reduction let a producer
    // GEOMETRY drift stay green (a `newStart + 10` at the emission keeps the id, so both
    // this test and the UI's own hard-coded-geometry fixture agreed) while a real
    // cross-layer probe false-orphaned a valid mark. Deriving the expected ranges from
    // the source hunk makes any geometry drift at the producer redden here. #250 r2 F3.
    const floorHunk = decomposition.hunks.find((hunk) => hunk.id === floorHunkId);
    expect(floorHunk).toBeDefined();
    const occurrence = element
      ? diffs[element.elementKey]?.hunkOccurrences.flat().find((occ) => occ.id === floorHunkId)
      : undefined;
    expect(occurrence).toEqual({
      id: floorHunkId,
      oldStart: floorHunk?.oldStart,
      oldLines: floorHunk?.oldLines,
      newStart: floorHunk?.newStart,
      newLines: floorHunk?.newLines,
    });
    // Opus caveat folded in: pin that the proposal element is the SOLE owner of the floor
    // hunk, not merely that elements[0] carries it. A producer change that duplicated the
    // hunk onto a second element's diff would redden here rather than slip past a
    // single-element check. #250 r2 F3.
    const ownersOfFloorHunk = Object.entries(diffs)
      .filter(([, entry]) => entry?.hunkOccurrences.flat().some((occ) => occ.id === floorHunkId))
      .map(([key]) => key);
    expect(ownersOfFloorHunk).toEqual([element?.elementKey]);
  });

  // Oversize-split fragments: two decomposition hunks (splitOf fragments) that
  // both fall inside ONE raw `@@` hunk must render that parent hunk ONCE (the
  // `seen` dedupe), never twice.
  it("renders a split parent raw hunk exactly once for multiple fragments", () => {
    const BIG = `@@ -1,6 +1,6 @@
 line one
-old two
+new two
 line three
-old four
+new four
 line five
 line six`;
    const bigPatchset = patchsetOf("patch-3", [file("src/big.ts", BIG)]);
    const fragmentA: Hunk = {
      id: "frag-a",
      filePath: "src/big.ts",
      fileStatus: "modified",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      addedLines: ["new two"],
      deletedLines: ["old two"],
      contextLines: ["line one", "line three"],
      changedLoc: 2,
      splitOf: { index: 1, total: 2 },
    };
    const fragmentB: Hunk = {
      ...fragmentA,
      id: "frag-b",
      oldStart: 4,
      newStart: 4,
      addedLines: ["new four"],
      deletedLines: ["old four"],
      contextLines: ["line five", "line six"],
      splitOf: { index: 2, total: 2 },
    };
    const splitDecomp: Decomposition = {
      patchsetId: "patch-3",
      hunks: [fragmentA, fragmentB],
      classifications: [],
      chunks: [
        {
          chunkId: "csplit",
          kind: "substantive",
          title: "Split",
          layer: 2,
          filePaths: ["src/big.ts"],
          hunkIds: ["frag-a", "frag-b"],
          changedLoc: 4,
        },
      ],
      edges: [],
      readingOrder: ["csplit"],
      residue: [],
      blockingStates: [],
    };
    const set = setWith("sequence", [
      { elementKey: "es", docId: "d", anchor: "rennet:chunk/csplit", kind: "chunk", title: "S" },
    ]);

    const diffs = buildElementDiffs(set, splitDecomp, bigPatchset);

    // The whole parent hunk, shown once (its header appears exactly one time).
    expect(diffs.es?.diff).toBe(BIG);
    const headerCount = (diffs.es?.diff.match(/@@ -1,6 \+1,6 @@/g) ?? []).length;
    expect(headerCount).toBe(1);
    // #84 — the ONE rendered @@ hunk carries BOTH fragments, in file order, each with
    // its own line range so a mark on either lands within its slice. A positional
    // `occurrenceIds` array (2 ids, 1 rendered hunk) could not express this.
    expect(diffs.es?.hunkOccurrences).toHaveLength(1);
    expect(diffs.es?.hunkOccurrences?.[0]?.map((o) => o.id)).toEqual(["frag-a", "frag-b"]);
    expect(diffs.es?.hunkOccurrences?.[0]?.[1]).toMatchObject({
      id: "frag-b",
      oldStart: 4,
      newStart: 4,
    });
  });

  // A proposal chunk that REGROUPS hunks from an implementation AND its test into ONE
  // element (the real live shape). `path` is only the first file, but `paths` MUST
  // carry BOTH — that is what lets the counterpart resolver find the test by
  // membership instead of a single-path compare that would miss it.
  it("carries EVERY rendered file path when a proposal chunk merges multiple files", () => {
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
    const multiPatchset = patchsetOf("patch-4", [
      file("src/foo.ts", IMPL),
      file("src/foo.test.ts", TEST),
    ]);
    const decomp = decompose(multiPatchset);
    const implHunk = decomp.hunks.find((h) => h.filePath === "src/foo.ts");
    const testHunk = decomp.hunks.find((h) => h.filePath === "src/foo.test.ts");
    expect(implHunk).toBeDefined();
    expect(testHunk).toBeDefined();

    // The admitted proposal merges both files' hunks into ONE chunk/element.
    const admitted: AdmittedDocument[] = [
      {
        docId: "pdoc",
        docType: "decomposition.proposal",
        body: {
          chunks: [
            {
              chunkId: "merged",
              title: "Foo + its test",
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

    const diffs = buildElementDiffs(set, decomp, multiPatchset, admitted);
    const entry = diffs["merged-el"];
    expect(entry).toBeDefined();
    // `path` alone is only the first file — a single-path check would MISS the test.
    expect(entry?.path).toBe("src/foo.ts");
    // `paths` carries BOTH files, so membership resolution finds the test.
    expect(entry?.paths).toEqual(["src/foo.test.ts", "src/foo.ts"]);
    expect(entry?.paths).toContain("src/foo.test.ts");
    // and the rendered diff really does include both files' hunks.
    expect(entry?.diff).toContain("export function foo()");
    expect(entry?.diff).toContain('import { foo } from "./foo"');
    // #84 — the crux: `hunkOccurrences` is in RENDERED (sorted-file) order, NOT the
    // chunk's `hunkIds` order. `hunkIds` is [impl, test] but files sort test-first, so
    // rendered hunk 0 is the TEST and hunk 1 is the impl. A positional array that
    // reused `hunkIds` would tag the test's rows with the impl's id — the multi-file
    // misplacement bug. Here the mapping tracks the text.
    expect(entry?.hunkOccurrences).toHaveLength(2);
    expect(entry?.hunkOccurrences?.[0]?.[0]?.id).toBe(testHunk?.id);
    expect(entry?.hunkOccurrences?.[1]?.[0]?.id).toBe(implHunk?.id);
  });
});
