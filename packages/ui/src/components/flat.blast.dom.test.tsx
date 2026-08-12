// @vitest-environment happy-dom
//
// The blast-radius overlay on a FLAT (sequence) canvas (issue #35). Two properties:
//   F3 — the deterministic signals target `rennet:file/<path>`, which never equals a
//        sequence element's `rennet:chunk/<id>` anchor. The old code matched the raw
//        target against the anchor, so the Sequence lens painted NO amber and NO
//        reason. This resolves file targets through the substrate the way Decisions
//        does, so an element whose chunk covers a targeted file is amber, with the
//        covering chunk's one-line reason beside it.
//   F1 — amber FOLLOWS the overlay toggle: overlayOn=false paints nothing.
import type { Canvas } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../test/dom";
import { FlatCanvas } from "./flat";

// A sequence canvas: one chunk element (anchored `rennet:chunk/c1`), substrate chunk
// c1 covers a.ts, and the overlay targets `rennet:file/a.ts` (a file-grained signal).
function sequenceCanvas(): Canvas {
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
    overlay: [
      {
        target: "rennet:file/a.ts",
        signal: "deletions",
        reason: "File deleted (12 lines); anything importing it breaks.",
        assessed: true,
      },
    ],
  };
}

describe("FlatCanvas — blast-radius amber on the Sequence lens (#35 F1/F3)", () => {
  it("paints a file-target signal onto the element whose chunk covers the file (F3)", () => {
    const { container } = mount(
      <FlatCanvas
        canvas={sequenceCanvas()}
        overlayOn={true}
        onApproveScope={vi.fn()}
        onSelectElement={vi.fn()}
      />,
    );
    // The element is amber because its chunk c1 covers a.ts, the targeted file.
    // Red-proof: revert flat.tsx to `blastPaint(canvas).has(element.anchor)` and the
    // `rennet:file/a.ts` target never matches `rennet:chunk/c1`, so this reddens.
    expect(container.querySelector(".flat-element.is-blast")).toBeTruthy();
    // The covering chunk's one-line reason renders beside the mark.
    expect(container.querySelector(".flat-element-blast-reason")?.textContent).toMatch(
      /File deleted/,
    );
  });

  it("paints NO amber when the overlay toggle is off (F1)", () => {
    const { container } = mount(
      <FlatCanvas
        canvas={sequenceCanvas()}
        overlayOn={false}
        onApproveScope={vi.fn()}
        onSelectElement={vi.fn()}
      />,
    );
    expect(container.querySelector(".flat-element.is-blast")).toBeNull();
    expect(container.querySelector(".flat-element-blast-reason")).toBeNull();
  });
});
