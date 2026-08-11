import type { Canvas, SubstrateChunkRef } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  elementKeyForPath,
  implementationPathFor,
  isTestPath,
  resolveCounterpart,
  testPathsFor,
} from "./counterpart";

// A canvas where each chunk is one file with one hunk, and each file has an element
// anchored to that hunk — the smallest shape that exercises path → element mapping.
function canvasWithFiles(files: string[]): Canvas {
  const chunks: SubstrateChunkRef[] = files.map((path, index) => ({
    chunkId: `c${index + 1}`,
    hunkIds: [`c${index + 1}-h1`],
    filePaths: [path],
  }));
  const elements = files.map((path, index) => ({
    elementKey: `el-${index + 1}`,
    docId: `doc-${index + 1}`,
    anchor: `rennet:hunk/c${index + 1}-h1`,
    kind: "chunk",
    title: path,
  }));
  return {
    canvasId: "r\0p\0sequence",
    reviewId: "r",
    patchsetId: "p",
    angle: "sequence",
    layers: {
      substrate: { chunks },
      analysis: { elements, cohorts: [], readingOrder: elements.map((el) => el.elementKey) },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  };
}

describe("isTestPath", () => {
  it("matches the reversible .test./.spec. suffix convention", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("src/foo.test.mjs")).toBe(true);
    expect(isTestPath("src/foo.ts")).toBe(false);
    // A __tests__ directory is NOT used here: it yields no reversible impl path.
    expect(isTestPath("src/__tests__/foo.ts")).toBe(false);
  });
});

describe("implementationPathFor", () => {
  it("drops the .test/.spec infix, keeping the extension", () => {
    expect(implementationPathFor("src/foo.test.ts")).toBe("src/foo.ts");
    expect(implementationPathFor("a/b/widget.spec.tsx")).toBe("a/b/widget.tsx");
  });
  it("returns null for a non-test path", () => {
    expect(implementationPathFor("src/foo.ts")).toBeNull();
  });
});

describe("testPathsFor", () => {
  it("offers .test. then .spec. candidates, keeping the extension", () => {
    expect(testPathsFor("src/foo.ts")).toEqual(["src/foo.test.ts", "src/foo.spec.ts"]);
    expect(testPathsFor("a/widget.tsx")).toEqual(["a/widget.test.tsx", "a/widget.spec.tsx"]);
  });
  it("is empty for a test path or a non-JS/TS path", () => {
    expect(testPathsFor("src/foo.test.ts")).toEqual([]);
    expect(testPathsFor("README.md")).toEqual([]);
  });
});

describe("elementKeyForPath", () => {
  it("resolves a file in the changeset to its element", () => {
    const canvas = canvasWithFiles(["src/foo.ts", "src/foo.test.ts"]);
    expect(elementKeyForPath(canvas, "src/foo.ts")).toBe("el-1");
    expect(elementKeyForPath(canvas, "src/foo.test.ts")).toBe("el-2");
  });
  it("returns null for a path not in the changeset", () => {
    const canvas = canvasWithFiles(["src/foo.ts"]);
    expect(elementKeyForPath(canvas, "src/other.ts")).toBeNull();
  });
});

describe("resolveCounterpart", () => {
  it("on an implementation, points at its test in the review (View test)", () => {
    const canvas = canvasWithFiles(["src/foo.ts", "src/foo.test.ts"]);
    expect(resolveCounterpart(canvas, "src/foo.ts")).toEqual({
      label: "View test",
      elementKey: "el-2",
      path: "src/foo.test.ts",
      counterpartKind: "test",
    });
  });

  it("on a test, points back at its implementation (View implementation)", () => {
    const canvas = canvasWithFiles(["src/foo.ts", "src/foo.test.ts"]);
    expect(resolveCounterpart(canvas, "src/foo.test.ts")).toEqual({
      label: "View implementation",
      elementKey: "el-1",
      path: "src/foo.ts",
      counterpartKind: "implementation",
    });
  });

  it("prefers a .test. counterpart over .spec. when both are present", () => {
    const canvas = canvasWithFiles(["src/foo.ts", "src/foo.spec.ts", "src/foo.test.ts"]);
    const target = resolveCounterpart(canvas, "src/foo.ts");
    expect(target?.path).toBe("src/foo.test.ts");
  });

  it("falls back to a .spec. counterpart when no .test. is in the review", () => {
    const canvas = canvasWithFiles(["src/foo.ts", "src/foo.spec.ts"]);
    const target = resolveCounterpart(canvas, "src/foo.ts");
    expect(target?.path).toBe("src/foo.spec.ts");
    expect(target?.label).toBe("View test");
  });

  it("is null when the counterpart is not part of the review", () => {
    const canvas = canvasWithFiles(["src/foo.ts"]);
    expect(resolveCounterpart(canvas, "src/foo.ts")).toBeNull();
  });

  it("is null for a file with no impl/test partner convention", () => {
    const canvas = canvasWithFiles(["docs/README.md"]);
    expect(resolveCounterpart(canvas, "docs/README.md")).toBeNull();
  });
});
