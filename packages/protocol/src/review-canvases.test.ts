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

  it("round-trips a five-angle canvas set + the element diff map through the output schema", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {
        e1: { path: "src/a.ts", paths: ["src/a.ts"], diff: "@@ -1,1 +1,2 @@\n+added" },
      },
    });
    expect(Object.keys(output.canvases).sort()).toEqual([...CANVAS_ANGLES].sort());
    expect(output.canvases.sequence.layers.analysis.elements[0]?.title).toBe("A");
    expect(output.elementDiffs.e1?.path).toBe("src/a.ts");
    expect(output.elementDiffs.e1?.diff).toContain("+added");
  });

  it("rejects a malformed element diff entry (positive control)", () => {
    expect(() =>
      parseCommandOutput("review.canvases", {
        canvases: canvasSet(),
        // `diff` missing → the elementDiffs schema must fail.
        elementDiffs: { e1: { path: "src/a.ts" } },
      }),
    ).toThrow();
  });

  it("requires the elementDiffs field (positive control)", () => {
    expect(() => parseCommandOutput("review.canvases", { canvases: canvasSet() })).toThrow();
  });

  it("parses a valid input (no consent token — running the model just runs)", () => {
    const input = parseCommandInput("review.canvases", {
      commandId: "018f2c3d-0000-7000-8000-000000000000",
      reviewId: "review-1",
      repoPath: "/repo",
    });
    expect(input.reviewId).toBe("review-1");
  });

  it("rejects a malformed canvas (positive control)", () => {
    const broken = canvasSet();
    // Drop a required layer so the schema must fail. `elementDiffs` is supplied
    // (valid) so the throw is attributable to CANVAS validation specifically —
    // otherwise this control fires for the missing-elementDiffs reason (already
    // covered above) and never exercises the canvas schema at all.
    (broken.sequence.layers as { substrate?: unknown }).substrate = undefined;
    expect(() =>
      parseCommandOutput("review.canvases", { canvases: broken, elementDiffs: {} }),
    ).toThrow();
  });

  it("canvasSchema accepts a valid canvas and rejects a non-object", () => {
    expect(() => canvasSchema.parse(emptyCanvas("spec"))).not.toThrow();
    expect(() => canvasSchema.parse({ canvasId: "x" })).toThrow();
  });

  // ── decisionsRun delivery (issue #137/#160) ─────────────────────────────────
  // The Decisions failed state MUST survive the command boundary. The output is a
  // strict z.object, so an unschema'd field is silently stripped — and stripping
  // `decisionsRun` would make "the decisions pass crashed" render identical to
  // "found nothing" (the exact false-verdict #160 removes). These assertions go red
  // if the field is ever dropped from the schema.
  it("carries a FAILED decisionsRun status through the output (reaches the failed banner)", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
      decisionsRun: { status: "failed", reason: "the extraction runner timed out" },
    });
    expect(output.decisionsRun).toEqual({
      status: "failed",
      reason: "the extraction runner timed out",
    });
  });

  it("carries an OK decisionsRun status through the output", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
      decisionsRun: { status: "ok" },
    });
    expect(output.decisionsRun).toEqual({ status: "ok" });
  });

  it("round-trips WITHOUT decisionsRun unchanged (pre-#160 shape preserved)", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
    });
    expect(output.decisionsRun).toBeUndefined();
  });

  it("rejects a failed decisionsRun with no reason (positive control)", () => {
    expect(() =>
      parseCommandOutput("review.canvases", {
        canvases: canvasSet(),
        elementDiffs: {},
        decisionsRun: { status: "failed" },
      }),
    ).toThrow();
  });
});
