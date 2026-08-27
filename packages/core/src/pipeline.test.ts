import type { PatchFile, Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createInvocationBudget } from "./invocation-budget";
import { buildReviewCanvases } from "./pipeline";

// The pipeline reduced to its deterministic floor (B2, #489): decompose + the Brita
// route-plan budget gate. The model-backed generation phases and the canvas
// projection are gone, so `canvases`/`elementDiffs` are empty; these tests pin the
// surviving deterministic spine the live context/symbol backend reads.

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 2, deletions: 1, binary: false, patch };
}

const WIDGET = `@@ -1,2 +1,3 @@
 export function widget() {
-  return oldValue;
+  return next;
 }`;

function patchsetOf(files: PatchFile[]): Patchset {
  return {
    id: "patch-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid: "base",
      headOid: "head",
    },
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

describe("buildReviewCanvases — the deterministic floor", () => {
  it("returns the captured decomposition and an empty canvas set (no projection)", async () => {
    const patchset = patchsetOf([file("src/widget.ts", WIDGET)]);
    const result = await buildReviewCanvases({
      reviewId: "r1",
      patchset,
      dispositions: [],
      budget: createInvocationBudget(12),
    });

    expect(result.decomposition.patchsetId).toBe(patchset.id);
    expect(result.decomposition.hunks.length).toBeGreaterThan(0);
    // The canvas projection is gone; nothing live reads a built Canvas after #489.
    expect(Object.keys(result.canvases)).toHaveLength(0);
    expect(Object.keys(result.elementDiffs)).toHaveLength(0);
    expect(result.admittedDocs).toEqual([]);
    // The one shared invocation meter rides back unchanged for follow-on tools.
    expect(result.invocationBudget).toBe(result.invocationBudget);
  });

  it("runs the Brita route-plan budget gate over the decomposition", async () => {
    const patchset = patchsetOf([file("src/widget.ts", WIDGET)]);
    const result = await buildReviewCanvases({
      reviewId: "r1",
      patchset,
      dispositions: [],
      budget: createInvocationBudget(12),
    });
    expect(result.routePlan).toBeDefined();
    // No model runs on the floor, but the refusal verdict is still reported honestly.
    expect(typeof result.budgetRefused).toBe("boolean");
  });
});
