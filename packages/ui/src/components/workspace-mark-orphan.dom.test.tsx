// @vitest-environment happy-dom
//
// #84 P0-2 — the workspace mark index must be AUTHORITATIVE about placement, not
// coarse. A mark whose occurrence IS in the changeset (so the old global check called
// it placed) but which `placeMarks` orphans — an out-of-slice span, or an element whose
// `hunkOccurrences` mapping is empty (exactly what the stripped IPC field produced) —
// renders on NO row. Presenting it as "placed" is the silent loss the registrar's loud
// failure was meant to prevent. These mount the REAL CanvasWorkspace over a real diff
// and assert the orphan surfaces in the visible tray.
import type { Canvas, CanvasAngle, ElementDiff } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createViewStore } from "../canvas/store";
import { mount } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

const ACTIVE: CanvasAngle = "sequence";

// A one-file, one-hunk diff: a context line then a single addition. Occurrence "h1"
// spans it (new lines 1-2). `#L1@additions` is the lone addition; `#L9@additions` is
// out of bounds.
const DIFF = ["@@ -1,1 +1,2 @@", " const x = 1;", "+const y = 2;"].join("\n");
const H1_OCC: ElementDiff["hunkOccurrences"] = [
  [{ id: "h1", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
];

function canvasWith(annotationTarget: string): Record<CanvasAngle, Canvas> {
  const build = (angle: CanvasAngle): Canvas => ({
    canvasId: `cid-${angle}`,
    reviewId: "r1",
    patchsetId: "p1",
    angle,
    layers: {
      substrate:
        angle === ACTIVE
          ? { chunks: [{ chunkId: "c1", hunkIds: ["h1"], filePaths: ["src/a.ts"] }] }
          : { chunks: [] },
      analysis:
        angle === ACTIVE
          ? {
              elements: [
                {
                  elementKey: "e1",
                  docId: "d1",
                  anchor: "rennet:hunk/h1",
                  kind: "hunk",
                  title: "A",
                },
              ],
              cohorts: [],
              readingOrder: ["e1"],
            }
          : { elements: [], cohorts: [], readingOrder: [] },
      disposition: { dispositions: [] },
      annotation:
        angle === ACTIVE
          ? {
              annotations: [
                {
                  annotationId: "ann-1",
                  target: annotationTarget,
                  kind: "callout",
                  body: "look here",
                  pinned: false,
                },
              ],
              proposals: [],
            }
          : { annotations: [], proposals: [] },
    },
    overlay: [],
  });
  return Object.fromEntries(CANVAS_ANGLES.map((a) => [a, build(a)])) as Record<CanvasAngle, Canvas>;
}

function render(annotationTarget: string, hunkOccurrences: ElementDiff["hunkOccurrences"]) {
  const diffFor = (): ElementDiff => ({
    path: "src/a.ts",
    paths: ["src/a.ts"],
    diff: DIFF,
    hunkOccurrences,
  });
  return mount(
    <CanvasWorkspace
      canvases={canvasWith(annotationTarget)}
      store={createViewStore({ angle: ACTIVE })}
      diffFor={diffFor}
    />,
  );
}

describe("CanvasWorkspace mark index — authoritative placement surfaces fine orphans (#84 P0-2)", () => {
  it("a valid in-slice mark shows as a placed jump, never in the orphan tray (positive control)", () => {
    const { container } = render("rennet:hunk/h1#L1@additions", H1_OCC);
    expect(container.querySelector('[data-jump="ann-1"]')).not.toBeNull();
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).toBeNull();
  });

  it("an out-of-slice span on a PRESENT occurrence surfaces in the tray, never as placed", () => {
    // h1 is in the changeset (passes the old coarse check) but the diff has one
    // addition, so #L9@additions resolves to no row. Old code: shown as placed and
    // rendered nowhere. Now: loud in the tray.
    const { container } = render("rennet:hunk/h1#L9@additions", H1_OCC);
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).not.toBeNull();
    expect(container.querySelector('[data-jump="ann-1"]')).toBeNull();
    expect(container.textContent).toContain("could not be placed");
  });

  it("an empty hunkOccurrences mapping (the stripped-field case) surfaces in the tray", () => {
    // This is exactly what the IPC strip produced at the renderer: the occurrence is in
    // the changeset, the span is valid, but the element carries NO mapping — so every
    // row is identity-less and the mark resolves to nothing. It must be loud, not shown
    // sitting on a row it never reached.
    const { container } = render("rennet:hunk/h1#L1@additions", []);
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).not.toBeNull();
    expect(container.querySelector('[data-jump="ann-1"]')).toBeNull();
  });

  it("a mapping that does not carry the mark's occurrence surfaces in the tray", () => {
    // The diff renders some OTHER occurrence; h1 is nowhere in the mapping, so the mark
    // cannot resolve to a row even though h1 is in the changeset.
    const otherOcc: ElementDiff["hunkOccurrences"] = [
      [{ id: "other", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
    ];
    const { container } = render("rennet:hunk/h1#L1@additions", otherOcc);
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).not.toBeNull();
    expect(container.querySelector('[data-jump="ann-1"]')).toBeNull();
  });
});
