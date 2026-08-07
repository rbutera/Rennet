import type { Canvas, CanvasAngle, PatchFile, Patchset } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { decompose } from "./decomposition";
import { buildElementDiffs } from "./element-diffs";
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
  return { path, status: "modified", additions: 4, deletions: 1, binary: false, patch };
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

// A real captured hunk. Its content is distinctive (harvest/audit/oldValue) and
// carries NONE of demoDiff's signature tokens (demoDiff emits `legacy…` lines).
const WIDGET = `@@ -1,3 +1,6 @@
 export function widget() {
-  return oldValue;
+  const next = harvest(41);
+  audit(next);
+  return next;
 }
+export const helper = () => widget();`;

function blankCanvas(
  angle: CanvasAngle,
  elements: Canvas["layers"]["analysis"]["elements"],
): Canvas {
  return {
    canvasId: `cid-${angle}`,
    reviewId: "r1",
    patchsetId: "patch-1",
    angle,
    layers: {
      substrate: { chunks: [] },
      analysis: { elements, cohorts: [], readingOrder: elements.map((el) => el.elementKey) },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  };
}

function setWith(
  angle: CanvasAngle,
  elements: Canvas["layers"]["analysis"]["elements"],
): Record<CanvasAngle, Canvas> {
  return Object.fromEntries(
    CANVAS_ANGLES.map((a) => [a, blankCanvas(a, a === angle ? elements : [])]),
  ) as Record<CanvasAngle, Canvas>;
}

describe("buildReviewCanvases delivers real element diffs", () => {
  it("delivers the real captured hunk for a sequence chunk element (not demoDiff)", async () => {
    const patchset = patchsetOf("patch-1", [file("src/widget.ts", WIDGET)]);
    const result = await buildReviewCanvases({ reviewId: "r1", patchset, dispositions: [] });

    const element = result.canvases.sequence.layers.analysis.elements[0];
    expect(element).toBeDefined();
    const entry = result.elementDiffs[element?.elementKey ?? ""];

    expect(entry).toBeDefined();
    expect(entry?.path).toBe("src/widget.ts");
    // Verbatim, byte-faithful to the captured patch (header + interleaved body).
    expect(entry?.diff).toContain("@@ -1,3 +1,6 @@");
    expect(entry?.diff).toContain("+  const next = harvest(41);");
    expect(entry?.diff).toContain("-  return oldValue;");
    expect(entry?.diff).toContain("export function widget()");
    // The demoDiff fixture is gone from the real path.
    expect(entry?.diff).not.toContain("legacy");
  });
});

describe("buildElementDiffs", () => {
  const patchset = patchsetOf("patch-1", [file("src/widget.ts", WIDGET)]);
  const decomposition = decompose(patchset);

  it("resolves a hunk anchor to that single hunk and skips doc-anchored elements", () => {
    const hunkId = decomposition.hunks[0]?.id ?? "";
    expect(hunkId).not.toBe("");
    const set = setWith("claims", [
      { elementKey: "eh", docId: "d", anchor: `rennet:hunk/${hunkId}`, kind: "hunk", title: "H" },
      { elementKey: "ed", docId: "d2", anchor: "rennet:doc/d2", kind: "claim", title: "D" },
    ]);

    const diffs = buildElementDiffs(set, decomposition, patchset);

    expect(diffs.eh).toBeDefined();
    expect(diffs.eh?.path).toBe("src/widget.ts");
    expect(diffs.eh?.diff).toContain("harvest(41)");
    // A document-anchored element has no code diff — no entry, never a fixture.
    expect(diffs.ed).toBeUndefined();
  });

  it("is a pure function of its inputs", () => {
    const set = setWith("sequence", [
      { elementKey: "ec", docId: "d", anchor: "rennet:chunk/c1", kind: "chunk", title: "C" },
    ]);
    expect(buildElementDiffs(set, decomposition, patchset)).toEqual(
      buildElementDiffs(set, decomposition, patchset),
    );
  });
});
