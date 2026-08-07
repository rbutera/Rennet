import type { OrderingBody, PatchFile, Patchset } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import type { DecompositionTurnResult } from "./angle-generation";
import { deterministicProposalBody } from "./angle-generation";
import { decompose } from "./decomposition";
import type { OrderingTurnResult } from "./ordering-pass";
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
  return { path, status: "modified", additions: 3, deletions: 1, binary: false, patch };
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

// A diff where gamma.ts imports alpha.ts → the floor derives an edge c1 -> c2.
const ALPHA = `@@ -1,3 +1,6 @@
 export function alpha() {
-  return 1;
+  const value = compute(2);
+  logger.info(value);
+  return value;
 }
+
+export const beta = () => alpha() + 1;`;
const GAMMA = `@@ -1,2 +1,5 @@
 import { alpha } from "./alpha";
+
+export function gamma() {
+  return alpha() * 3;
+}`;
const edgedPatchset = patchsetOf("patch-1", [
  file("src/alpha.ts", ALPHA),
  file("src/gamma.ts", GAMMA),
]);

// Two files that do not reference each other → no dependency edges, so the
// ordering pass may legitimately reorder them.
const IND_A = `@@ -1,2 +1,5 @@
 export function alpha() {
+  const value = compute(2);
+  logger.info(value);
+  return value;
 }`;
const IND_B = `@@ -1,2 +1,5 @@
 export function omega() {
+  const total = sum(3);
+  report(total);
+  return total;
 }`;
const independentPatchset = patchsetOf("patch-ind", [
  file("src/alpha.ts", IND_A),
  file("src/omega.ts", IND_B),
]);

function sequenceTitles(canvas: {
  layers: { analysis: { elements: { title: string }[] } };
}): string[] {
  return canvas.layers.analysis.elements.map((element) => element.title);
}

describe("buildReviewCanvases", () => {
  it("populates all five canvases from the real decomposition of the diff", async () => {
    const decomposition = decompose(edgedPatchset);
    const proposal = deterministicProposalBody(decomposition);
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
    });

    // Five angles, each keyed.
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
    expect(Object.keys(result.canvases).sort()).toEqual([...CANVAS_ANGLES].sort());

    // The substrate derives from the captured diff, not fixtures.
    const substrateChunks = result.canvases.sequence.layers.substrate.chunks;
    expect(substrateChunks.flatMap((chunk) => chunk.filePaths)).toEqual([
      "src/alpha.ts",
      "src/gamma.ts",
    ]);

    // The agentic proposal was admitted (not the deterministic fallback) and the
    // sequence canvas presents its chunk elements, titled from the real chunks.
    expect(runDecompositionTurn).toHaveBeenCalled();
    expect(result.decompositionResult?.usedFallback).toBe(false);
    expect(result.budgetRefused).toBe(false);
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("refuses over budget and never runs a model turn (Brita gate)", async () => {
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: {} }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
      routePlanOptions: { maxHarnessInvocations: 1 },
    });

    // The gate fired before any spend: the turn was never called.
    expect(runDecompositionTurn).not.toHaveBeenCalled();
    expect(result.budgetRefused).toBe(true);
    // Canvases are still populated, from the deterministic floor.
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("runs the model turn when within budget (Brita gate, pass arm)", async () => {
    const decomposition = decompose(edgedPatchset);
    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({
        status: "emitted",
        body: deterministicProposalBody(decomposition),
      }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
      runDecompositionTurn,
    });

    expect(runDecompositionTurn).toHaveBeenCalledTimes(1);
    expect(result.budgetRefused).toBe(false);
  });

  it("stands on the deterministic floor when no harness turn is injected", async () => {
    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: edgedPatchset,
      dispositions: [],
    });

    expect(result.admittedDocs).toEqual([]);
    expect(result.decompositionResult).toBeUndefined();
    for (const angle of CANVAS_ANGLES) expect(result.canvases[angle]).toBeDefined();
    // The sequence floor still places the real chunks from the diff.
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("applies the ordering pass's comprehension order to the sequence canvas", async () => {
    const decomposition = decompose(independentPatchset);
    // Independent files → no dependency edges → a reorder is admissible.
    expect(decomposition.edges).toEqual([]);
    const proposal = deterministicProposalBody(decomposition);
    const reversedOrder = [...proposal.readingOrder].reverse();

    const runDecompositionTurn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: proposal }),
    );
    const runOrderingTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: {
          readingOrder: reversedOrder,
          rationale: "high-level first, then ground-up",
        } satisfies OrderingBody,
      }),
    );

    const result = await buildReviewCanvases({
      reviewId: "review-1",
      patchset: independentPatchset,
      dispositions: [],
      runDecompositionTurn,
      runOrderingTurn,
    });

    expect(runOrderingTurn).toHaveBeenCalled();
    expect(result.orderingResult?.usedFallback).toBe(false);
    // The baseline was [alpha, omega]; the comprehension pass reversed it.
    expect(sequenceTitles(result.canvases.sequence)).toEqual(["src/omega.ts", "src/alpha.ts"]);
  });
});
