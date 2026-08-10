import type { Patchset } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildReviewCanvases } from "./pipeline";

const PATCHSET: Patchset = {
  id: "ps_pipe",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    {
      path: "src/store.ts",
      status: "modified",
      additions: null,
      deletions: null,
      binary: false,
      patch:
        "diff --git a/src/store.ts b/src/store.ts\n--- a/src/store.ts\n+++ b/src/store.ts\n@@ -1,1 +1,1 @@\n+export const keyOf = (r: string) => r;\n",
    },
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

function modelHypothesis(): unknown {
  const risks = Array.from({ length: 6 }, (_, i) => ({
    statement: `risk ${i}: the store key is per branch not per repository root`,
    severity: "medium",
    disconfirmer: `check that hunk ${i} keys per repo root`,
  }));
  return {
    domain: "key the store per repository",
    scope: { inScope: ["keying"], outOfScope: [] },
    designExpectation: "resolve from git-common-dir",
    risks,
  };
}

describe("buildReviewCanvases — the hypothesis-first stage (#178)", () => {
  it("produces and carries the committed hypothesis when a hypothesis turn is supplied", async () => {
    const result = await buildReviewCanvases({
      reviewId: "rev_1",
      patchset: PATCHSET,
      dispositions: [],
      runHypothesisTurn: () => Promise.resolve({ status: "emitted", body: modelHypothesis() }),
    });
    expect(result.hypothesis).toBeDefined();
    expect(result.hypothesis?.risks).toHaveLength(6);
    expect(result.hypothesisResult?.status).toBe("ok");
    // It rides ALONGSIDE the canvas set, never embedded on a Canvas.
    for (const canvas of Object.values(result.canvases)) {
      expect(JSON.stringify(canvas)).not.toContain("key the store per repository");
    }
  });

  it("carries no hypothesis when no hypothesis turn is supplied (unchanged behaviour)", async () => {
    const result = await buildReviewCanvases({
      reviewId: "rev_2",
      patchset: PATCHSET,
      dispositions: [],
    });
    expect(result.hypothesis).toBeUndefined();
    expect(result.hypothesisResult).toBeUndefined();
  });

  it("forms the prior from structure, never the hunk body (a genuine prior)", async () => {
    let prompt = "";
    await buildReviewCanvases({
      reviewId: "rev_3",
      patchset: PATCHSET,
      dispositions: [],
      runHypothesisTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: modelHypothesis() });
      },
    });
    expect(prompt).toContain("src/store.ts");
    expect(prompt).not.toContain("export const keyOf");
  });
});
