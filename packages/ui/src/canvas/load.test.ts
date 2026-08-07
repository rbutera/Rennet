import type { CommandInput, CommandName, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { Canvas, CanvasAngle, Review } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { loadCanvases } from "./load";

const review = {
  id: "review-1",
  repositoryRoot: "/repo",
  activePatchsetId: "patch-1",
  dispositions: [],
  status: "current",
  patchsets: [],
} as unknown as Review;

function liveSet(): Record<CanvasAngle, Canvas> {
  const one = (angle: CanvasAngle): Canvas => ({
    canvasId: `live-${angle}`,
    reviewId: "review-1",
    patchsetId: "patch-1",
    angle,
    layers: {
      substrate: { chunks: [] },
      analysis: {
        elements: [
          { elementKey: "e", docId: "d", anchor: "rennet:chunk/c1", kind: "chunk", title: "LIVE" },
        ],
        cohorts: [],
        readingOrder: ["e"],
      },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  });
  return Object.fromEntries(CANVAS_ANGLES.map((angle) => [angle, one(angle)])) as Record<
    CanvasAngle,
    Canvas
  >;
}

function bridgeReturning(
  impl: <K extends CommandName>(name: K, input: CommandInput<K>) => Promise<CommandOutput<K>>,
): RennetBridge {
  return { invoke: vi.fn(impl) as RennetBridge["invoke"] };
}

describe("loadCanvases", () => {
  it("returns the live canvas set the engine produced", async () => {
    const canvases = liveSet();
    const bridge = bridgeReturning((name) => {
      expect(name).toBe("review.canvases");
      return Promise.resolve({ canvases } as never);
    });

    const result = await loadCanvases(bridge, review);

    expect(result).not.toBeNull();
    expect(result?.sequence.layers.analysis.elements[0]?.title).toBe("LIVE");
  });

  it("returns null when the pipeline errors, so the caller keeps the demo", async () => {
    const bridge = bridgeReturning(() => Promise.reject(new Error("harness exploded")));

    const result = await loadCanvases(bridge, review);

    expect(result).toBeNull();
  });
});
