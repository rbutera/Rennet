// @vitest-environment happy-dom
//
// The blast-radius overlay INVARIANT (issue #35, F1/F2): if the reviewer can see
// amber, they can see what was NOT assessed. The not-assessed chips and the amber
// marks are both gated on the SAME overlay toggle, so they appear and disappear
// together — a reviewer never sees an amber mark whose "fan-in not assessed" caveat
// is hidden (which would read "File deleted; importers break" with nothing telling
// them fan-in — who imports it — was never computed).
//
// This is the workspace-level pin the reviewer asked for. It mounts BOTH lenses that
// paint amber — Decisions (`.cohort.is-blast`) AND Sequence (`.flat-element.is-blast`)
// — because each has its OWN toggle-passing call in workspace.tsx: hardcoding EITHER
// call's `overlayOn` prop (true → the shipped default-off-amber bug, false → amber
// suppressed) must redden a test here, in that lens's own path.
import type { Canvas, CanvasAngle } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createViewStore } from "../canvas/store";
import { mount } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

// The two DEFERRED signals the real producer always emits, plus one ASSESSED
// file-target (a.ts ∈ chunk c1 → that lens paints amber on the element covering c1).
function blastOverlay(): Canvas["overlay"] {
  return [
    {
      target: "rennet:file/a.ts",
      signal: "deletions",
      reason: "File deleted; anything importing it breaks.",
      assessed: true,
    },
    {
      target: "rennet:review/blast-radius",
      signal: "fan-in",
      reason: "Fan-in not assessed — the reference index is not wired into this overlay yet.",
      assessed: false,
    },
    {
      target: "rennet:review/blast-radius",
      signal: "contract-surface",
      reason: "Contract surface not assessed — exported-API impact is not computed here.",
      assessed: false,
    },
  ];
}

// The decisions canvas paints amber on a COHORT (chunk c1).
function decisionsWithBlast(): Canvas {
  return {
    canvasId: "cv-dec",
    reviewId: "r",
    patchsetId: "p",
    angle: "decisions",
    layers: {
      substrate: { chunks: [{ chunkId: "c1", hunkIds: ["h1"], filePaths: ["a.ts"] }] },
      analysis: {
        elements: [
          { elementKey: "e1", docId: "d1", anchor: "rennet:hunk/h1", kind: "decision", title: "D" },
        ],
        cohorts: [{ cohortKey: "cohort:c1", title: "First", elementKeys: ["e1"] }],
        readingOrder: ["cohort:c1"],
      },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: blastOverlay(),
  };
}

// The sequence canvas paints amber on a flat ELEMENT (chunk c1), a separate render
// path (FlatCanvas) with its own toggle-passing call in workspace.tsx.
function sequenceWithBlast(): Canvas {
  return {
    canvasId: "cv-seq",
    reviewId: "r",
    patchsetId: "p",
    angle: "sequence",
    layers: {
      substrate: { chunks: [{ chunkId: "c1", hunkIds: ["h1"], filePaths: ["a.ts"] }] },
      analysis: {
        elements: [
          { elementKey: "e1", docId: "d1", anchor: "rennet:chunk/c1", kind: "chunk", title: "A" },
        ],
        cohorts: [],
        readingOrder: ["e1"],
      },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: blastOverlay(),
  };
}

function canvasSet(): Record<CanvasAngle, Canvas> {
  const one = (angle: CanvasAngle): Canvas => ({
    canvasId: `cid-${angle}`,
    reviewId: "r",
    patchsetId: "p",
    angle,
    layers: {
      substrate: { chunks: [] },
      analysis: { elements: [], cohorts: [], readingOrder: [] },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  });
  const set = Object.fromEntries(CANVAS_ANGLES.map((angle) => [angle, one(angle)])) as Record<
    CanvasAngle,
    Canvas
  >;
  set.decisions = decisionsWithBlast();
  set.sequence = sequenceWithBlast();
  return set;
}

describe("CanvasWorkspace — blast-radius amber ⟹ not-assessed visible (#35 F1/F2)", () => {
  // ── Decisions lens (`.cohort.is-blast`) ─────────────────────────────────────
  it("Decisions: overlay ON ⟹ amber AND the not-assessed chips are BOTH present", () => {
    const store = createViewStore({ angle: "decisions", overlayOn: true });
    const { container } = mount(<CanvasWorkspace canvases={canvasSet()} store={store} />);
    expect(container.querySelector(".cohort.is-blast")).toBeTruthy();
    // The load-bearing implication: amber present ⟹ the not-assessed indicator present.
    expect(container.querySelector(".blast-not-assessed")).toBeTruthy();
    expect(container.querySelectorAll(".blast-chip")).toHaveLength(2);
  });

  it("Decisions: overlay OFF ⟹ NEITHER amber NOR the chips appear", () => {
    const store = createViewStore({ angle: "decisions", overlayOn: false });
    const { container } = mount(<CanvasWorkspace canvases={canvasSet()} store={store} />);
    expect(container.querySelector(".cohort.is-blast")).toBeNull();
    expect(container.querySelector(".blast-not-assessed")).toBeNull();
  });

  // ── Sequence lens (`.flat-element.is-blast`) — its OWN toggle-passing call ────
  // Hardcoding workspace.tsx's Sequence `overlayOn` prop to `true` recreates the
  // shipped bug (default-off amber, chips hidden) and reddens the OFF test; to
  // `false` suppresses the amber and reddens the ON test. Decisions-only coverage
  // could not see either.
  it("Sequence: overlay ON ⟹ amber AND the not-assessed chips are BOTH present", () => {
    const store = createViewStore({ angle: "sequence", overlayOn: true });
    const { container } = mount(<CanvasWorkspace canvases={canvasSet()} store={store} />);
    expect(container.querySelector(".flat-element.is-blast")).toBeTruthy();
    expect(container.querySelector(".blast-not-assessed")).toBeTruthy();
    expect(container.querySelectorAll(".blast-chip")).toHaveLength(2);
  });

  it("Sequence: overlay OFF ⟹ NEITHER amber NOR the chips appear", () => {
    const store = createViewStore({ angle: "sequence", overlayOn: false });
    const { container } = mount(<CanvasWorkspace canvases={canvasSet()} store={store} />);
    expect(container.querySelector(".flat-element.is-blast")).toBeNull();
    expect(container.querySelector(".blast-not-assessed")).toBeNull();
  });
});
