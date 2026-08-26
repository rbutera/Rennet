// @vitest-environment happy-dom
//
// #84 P0-2 — the workspace mark index must be AUTHORITATIVE about placement, not
// coarse. A mark whose occurrence IS in the changeset (so the old global check called
// it placed) but which `placeMarks` orphans — an out-of-slice span, or an element whose
// `hunkOccurrences` mapping is empty (exactly what the stripped IPC field produced) —
// renders on NO row. Presenting it as "placed" is the silent loss the registrar's loud
// failure was meant to prevent. These mount the REAL CanvasWorkspace over a real diff
// and assert the orphan surfaces in the visible tray.
import type { Canvas, CanvasAngle, ElementDiff } from "@rennet/protocol";
import { CANVAS_ANGLES } from "@rennet/protocol";
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

// ── #250: agent-authored PROPOSAL CHUNK elements ─────────────────────────────
//
// `projectSequence` regroups floor hunks into proposal-chunk elements whose chunk
// anchor is NOT in the floor substrate. The old owner lookup resolved ownership
// from substrate-chunk membership, so a mark on a regrouped floor hunk found no
// owner, skipped the authoritative `placeMarks` pass, and rendered as placed on the
// coarse "is the hunk in the changeset" verdict — even when it was unplaceable.
//
// The canvas shape below (proposal element anchor `rennet:chunk/agent-group` outside
// the substrate; floor hunk `h1` inside it; the element's diff `hunkOccurrences`
// carrying `h1`) is the LIVE producer output, pinned by the real-producer test
// `element-diffs.test.ts › "REAL SHAPE (#250)"`. That test is the guarantee this
// component fixture matches the pipeline rather than agreeing with itself.
function proposalCanvasWith(annotationTarget: string): Record<CanvasAngle, Canvas> {
  const build = (angle: CanvasAngle): Canvas => ({
    canvasId: `cid-${angle}`,
    reviewId: "r1",
    patchsetId: "p1",
    angle,
    layers: {
      // The floor substrate contains h1 (so the coarse verdict says "placed") but NOT
      // the agent-group proposal chunk (proposal chunks never enter the floor substrate).
      substrate:
        angle === ACTIVE
          ? { chunks: [{ chunkId: "c1", hunkIds: ["h1"], filePaths: ["src/a.ts"] }] }
          : { chunks: [] },
      analysis:
        angle === ACTIVE
          ? {
              elements: [
                {
                  elementKey: "seq-el",
                  docId: "pdoc",
                  anchor: "rennet:chunk/agent-group",
                  kind: "chunk",
                  title: "Agent group",
                },
              ],
              cohorts: [],
              readingOrder: ["seq-el"],
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

/** The proposal element's real diff renders h1 (its `hunkOccurrences` carries it). */
function renderProposal(
  annotationTarget: string,
  diffForImpl: (elementKey: string) => ElementDiff | undefined,
) {
  return mount(
    <CanvasWorkspace
      canvases={proposalCanvasWith(annotationTarget)}
      store={createViewStore({ angle: ACTIVE })}
      diffFor={diffForImpl}
    />,
  );
}

const PROPOSAL_DIFF_FOR = (): ElementDiff => ({
  path: "src/a.ts",
  paths: ["src/a.ts"],
  diff: DIFF,
  hunkOccurrences: H1_OCC,
});

describe("CanvasWorkspace mark index — proposal-chunk regrouped hunks (#250)", () => {
  it("an OUT-of-slice mark on a regrouped hunk surfaces in the orphan tray, never as placed", () => {
    // h1 is in the floor substrate (coarse → placed), but the proposal element's diff
    // has one addition, so #L9@additions resolves to no row. Bug: shown as placed.
    const { container } = renderProposal("rennet:hunk/h1#L9@additions", PROPOSAL_DIFF_FOR);
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).not.toBeNull();
    expect(container.querySelector('[data-jump="ann-1"]')).toBeNull();
    expect(container.textContent).toContain("could not be placed");
  });

  it("an IN-slice mark on a regrouped hunk shows as a placed jump (positive control — no over-orphaning)", () => {
    const { container } = renderProposal("rennet:hunk/h1#L1@additions", PROPOSAL_DIFF_FOR);
    expect(container.querySelector('[data-jump="ann-1"]')).not.toBeNull();
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).toBeNull();
  });

  it("keeps the coarse verdict (placed, NOT a false orphan) when the element diff cannot be resolved (#250 invariant)", () => {
    // diffFor returns undefined (the demo host / an unresolved diff). Ownership can
    // only be recovered from a resolved diff, so the mark keeps the coarse verdict —
    // turning a hidden orphan into a false one would trade one lie for another. This
    // reddens if a missing diff ever produces a false orphan.
    const { container } = renderProposal("rennet:hunk/h1#L9@additions", () => undefined);
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).toBeNull();
    expect(container.querySelector('[data-jump="ann-1"]')).not.toBeNull();
  });

  it("an IN-slice mark on a regrouped hunk RENDERS its inline card and its jump zooms the element (#250 r2 F1)", async () => {
    // The prior positive control (:226) only checked that an index button exists. Two
    // separate call sites were still broken for a placeable proposal-chunk mark: the
    // shown-marks filter (substrate-derived ids) dropped the card, and navigateToMark
    // (anchor-id equality) could not resolve the owning element, so the jump was dead.
    const { container, user } = renderProposal("rennet:hunk/h1#L1@additions", PROPOSAL_DIFF_FOR);
    const jump = container.querySelector('[data-jump="ann-1"]');
    expect(jump).not.toBeNull();
    await user.click(jump as Element);
    // navigateToMark resolved the proposal element that RENDERS h1 and zoomed to its diff…
    expect(container.querySelector(".diff-zoom")).not.toBeNull();
    // …and the shown-marks filter now carries the h1 mark, so its inline card is present.
    expect(container.querySelector('[data-mark-card="ann-1"]')).not.toBeNull();
  });

  it("keeps the coarse verdict when a hunk-ANCHORED owner's diff is unresolved (#250 r2 F4, exercises the resolved-owner branch)", () => {
    // The prior invariant test (:232) used a proposal element and NO anchor ownership of
    // h1, so the mark found no owner and stopped at the missing-owner `continue`, never
    // reaching the resolved-owner branch it claimed to guard (mutating that branch to
    // orphan every owned mark left it green). Here h1 IS owned by a hunk-anchored element,
    // so the mark reaches the branch; diffFor returns undefined, so placeMarks cannot
    // adjudicate and the mark must keep the coarse verdict (placed), never a FALSE orphan.
    const { container } = mount(
      <CanvasWorkspace
        canvases={canvasWith("rennet:hunk/h1#L9@additions")}
        store={createViewStore({ angle: ACTIVE })}
        diffFor={() => undefined}
      />,
    );
    expect(container.querySelector('[data-orphan-mark="ann-1"]')).toBeNull();
    expect(container.querySelector('[data-jump="ann-1"]')).not.toBeNull();
  });
});
