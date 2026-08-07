import type { Canvas, CanvasAngle } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { canvasSchema, isCommandName, parseCommandInput, parseCommandOutput } from "./index";

function emptyCanvas(angle: CanvasAngle): Canvas {
  return {
    canvasId: `cid-${angle}`,
    reviewId: "review-1",
    patchsetId: "patch-1",
    angle,
    layers: {
      substrate: { chunks: [{ chunkId: "c1", hunkIds: ["h1"], filePaths: ["src/a.ts"] }] },
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
    overlay: [],
  };
}

function canvasSet(): Record<CanvasAngle, Canvas> {
  return Object.fromEntries(CANVAS_ANGLES.map((angle) => [angle, emptyCanvas(angle)])) as Record<
    CanvasAngle,
    Canvas
  >;
}

describe("review.canvases command", () => {
  it("is a known command", () => {
    expect(isCommandName("review.canvases")).toBe(true);
  });

  it("round-trips a five-angle canvas set through the output schema", () => {
    const output = parseCommandOutput("review.canvases", { canvases: canvasSet() });
    expect(Object.keys(output.canvases).sort()).toEqual([...CANVAS_ANGLES].sort());
    expect(output.canvases.sequence.layers.analysis.elements[0]?.title).toBe("A");
  });

  it("parses a valid input", () => {
    const input = parseCommandInput("review.canvases", {
      commandId: "018f2c3d-0000-7000-8000-000000000000",
      reviewId: "review-1",
      repoPath: "/repo",
    });
    expect(input.reviewId).toBe("review-1");
  });

  it("rejects a malformed canvas (positive control)", () => {
    const broken = canvasSet();
    // Drop a required layer so the schema must fail.
    (broken.sequence.layers as { substrate?: unknown }).substrate = undefined;
    expect(() => parseCommandOutput("review.canvases", { canvases: broken })).toThrow();
  });

  it("canvasSchema accepts a valid canvas and rejects a non-object", () => {
    expect(() => canvasSchema.parse(emptyCanvas("spec"))).not.toThrow();
    expect(() => canvasSchema.parse({ canvasId: "x" })).toThrow();
  });
});
