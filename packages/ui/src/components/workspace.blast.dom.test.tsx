// @vitest-environment happy-dom
//
// The blast-radius overlay INVARIANT (issue #35, F1/F2): if the reviewer can see
// amber, they can see what was NOT assessed. The not-assessed chips and the amber
// marks are both gated on the SAME overlay toggle, so they appear and disappear
// together — a reviewer never sees an amber mark whose "fan-in not assessed" caveat
// is hidden (which would read "File deleted; importers break" with nothing telling
// them fan-in — who imports it — was never computed).
//
// This is the workspace-level pin the reviewer asked for: the F1 bug shipped green
// because the amber was NOT gated on the toggle (the components painted it
// unconditionally) while the chips WERE — and no test mounted the two together.
import type { Canvas, CanvasAngle } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createViewStore } from "../canvas/store";
import { mount } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

// The decisions canvas carries a cohort on chunk c1; the overlay carries an ASSESSED
// file-target (a.ts ∈ c1 → the cohort paints amber) PLUS the two DEFERRED signals
// (fan-in / contract-surface) the real producer always emits.
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
    overlay: [
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
    ],
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
  return set;
}

describe("CanvasWorkspace — blast-radius amber ⟹ not-assessed visible (#35 F1/F2)", () => {
  it("with the overlay ON, amber AND the not-assessed chips are BOTH present", () => {
    // overlayOn seeded true via the store. The invariant: whenever a `.is-blast`
    // element renders, the `.blast-not-assessed` chips render too. Red-proof: gate the
    // amber on nothing (paint unconditionally) while suppressing line-913's chips and
    // this reddens — the exact F1 ship (amber with no caveat).
    const store = createViewStore({ overlayOn: true });
    const { container } = mount(<CanvasWorkspace canvases={canvasSet()} store={store} />);
    const amber = container.querySelector(".cohort.is-blast");
    const notAssessed = container.querySelector(".blast-not-assessed");
    expect(amber).toBeTruthy();
    // The load-bearing implication: amber present ⟹ the not-assessed indicator present.
    expect(notAssessed).toBeTruthy();
    expect(container.querySelectorAll(".blast-chip")).toHaveLength(2);
  });

  it("with the overlay OFF, NEITHER amber NOR the not-assessed chips appear (F1)", () => {
    // The default (overlayOn=false). Off means off for BOTH — a reviewer who has not
    // asked for blast radius sees no unlabelled amber. Red-proof: paint the amber
    // unconditionally (the shipped F1 bug) and `.cohort.is-blast` appears here.
    const store = createViewStore({ overlayOn: false });
    const { container } = mount(<CanvasWorkspace canvases={canvasSet()} store={store} />);
    expect(container.querySelector(".cohort.is-blast")).toBeNull();
    expect(container.querySelector(".blast-not-assessed")).toBeNull();
  });
});
