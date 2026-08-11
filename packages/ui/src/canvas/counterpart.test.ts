import type { Canvas, CanvasAngle } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { implementationPathFor, isTestPath, resolveCounterpart, testPathsFor } from "./counterpart";

// A review canvas set plus a resolver from elementKey → the SET of paths its diff
// renders — mirroring the real `buildElementDiffs` output (`ElementDiff.paths`).
// `fileGroups` is one group per ELEMENT: a group with one path is a single-file
// element; a group with several is a proposal chunk that regrouped multiple files
// (impl + test) into ONE element — the exact live shape the id/single-path matching
// missed. Two things are deliberate and load-bearing:
//   • substrate is EMPTY and element anchors are PROPOSAL-style ids matching no
//     floor/substrate id — resolution must not depend on the id shape;
//   • only the given angles carry elements, so the cross-lens fallback is exercised.
function reviewCanvases(
  fileGroups: string[][],
  anglesWithElements: CanvasAngle[],
): {
  canvases: Record<CanvasAngle, Canvas>;
  pathsForElement: (key: string) => readonly string[] | undefined;
} {
  const pathsByElement = new Map<string, string[]>();
  const build = (angle: CanvasAngle): Canvas => {
    const withElements = anglesWithElements.includes(angle);
    const elements = withElements
      ? fileGroups.map((group, index) => {
          const elementKey = `${angle}-el-${index + 1}`;
          pathsByElement.set(elementKey, group);
          return {
            elementKey,
            docId: `doc-${index + 1}`,
            // A PROPOSAL chunk id that intentionally differs from any floor id.
            anchor: `rennet:chunk/proposal-${angle}-${index + 1}`,
            kind: "chunk",
            title: group.join(", "),
          };
        })
      : [];
    return {
      canvasId: `r\0p\0${angle}`,
      reviewId: "r",
      patchsetId: "p",
      angle,
      layers: {
        substrate: { chunks: [] }, // empty on purpose — resolution must not need it
        analysis: { elements, cohorts: [], readingOrder: elements.map((el) => el.elementKey) },
        disposition: { dispositions: [] },
        annotation: { annotations: [], proposals: [] },
      },
      overlay: [],
    };
  };
  return {
    canvases: {
      spec: build("spec"),
      sequence: build("sequence"),
      decisions: build("decisions"),
      claims: build("claims"),
      noise: build("noise"),
      flagged: build("flagged"),
    },
    pathsForElement: (key) => pathsByElement.get(key),
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

describe("resolveCounterpart", () => {
  it("on an implementation, points at its test in the review (View test)", () => {
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts"], ["src/foo.test.ts"]],
      ["sequence"],
    );
    expect(resolveCounterpart(canvases, "sequence", "src/foo.ts", pathsForElement)).toEqual({
      label: "View test",
      elementKey: "sequence-el-2",
      angle: "sequence",
      path: "src/foo.test.ts",
      counterpartKind: "test",
    });
  });

  it("on a test, points back at its implementation (View implementation)", () => {
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts"], ["src/foo.test.ts"]],
      ["sequence"],
    );
    expect(resolveCounterpart(canvases, "sequence", "src/foo.test.ts", pathsForElement)).toEqual({
      label: "View implementation",
      elementKey: "sequence-el-1",
      angle: "sequence",
      path: "src/foo.ts",
      counterpartKind: "implementation",
    });
  });

  it("MULTI-FILE CHUNK: impl + test regrouped into ONE element still resolves by membership", () => {
    // The root-cause case: a proposal chunk merges foo.ts AND foo.test.ts into one
    // element whose diff renders both. `path` would be only foo.ts, but `paths`
    // includes foo.test.ts — so View-test must find this same element by membership.
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts", "src/foo.test.ts"]],
      ["sequence"],
    );
    const target = resolveCounterpart(canvases, "sequence", "src/foo.ts", pathsForElement);
    expect(target?.label).toBe("View test");
    expect(target?.path).toBe("src/foo.test.ts");
    expect(target?.elementKey).toBe("sequence-el-1"); // the same, multi-file element
  });

  it("LIVE SHAPE: resolves even though element anchors are proposal ids (not floor/substrate ids)", () => {
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts"], ["src/foo.test.ts"]],
      ["sequence"],
    );
    const seq = canvases.sequence.layers.analysis.elements[1];
    expect(seq?.anchor).toBe("rennet:chunk/proposal-sequence-2"); // not a floor id
    expect(canvases.sequence.layers.substrate.chunks).toHaveLength(0); // no substrate to match on
    expect(
      resolveCounterpart(canvases, "sequence", "src/foo.ts", pathsForElement)?.elementKey,
    ).toBe("sequence-el-2");
  });

  it("resolves ACROSS lenses: in Decisions (no element) it still finds the test via sequence", () => {
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts"], ["src/foo.test.ts"]],
      ["sequence"],
    );
    const target = resolveCounterpart(canvases, "decisions", "src/foo.ts", pathsForElement);
    expect(target?.path).toBe("src/foo.test.ts");
    expect(target?.angle).toBe("sequence"); // fell back off the active lens
    expect(target?.elementKey).toBe("sequence-el-2");
  });

  it("prefers the CURRENT lens when it renders the file (no lens switch)", () => {
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts"], ["src/foo.test.ts"]],
      ["sequence", "decisions"],
    );
    const target = resolveCounterpart(canvases, "decisions", "src/foo.ts", pathsForElement);
    expect(target?.angle).toBe("decisions");
    expect(target?.elementKey).toBe("decisions-el-2");
  });

  it("prefers a .test. counterpart over .spec. when both are present", () => {
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts"], ["src/foo.spec.ts"], ["src/foo.test.ts"]],
      ["sequence"],
    );
    expect(resolveCounterpart(canvases, "sequence", "src/foo.ts", pathsForElement)?.path).toBe(
      "src/foo.test.ts",
    );
  });

  it("falls back to a .spec. counterpart when no .test. is in the review", () => {
    const { canvases, pathsForElement } = reviewCanvases(
      [["src/foo.ts"], ["src/foo.spec.ts"]],
      ["sequence"],
    );
    const target = resolveCounterpart(canvases, "sequence", "src/foo.ts", pathsForElement);
    expect(target?.path).toBe("src/foo.spec.ts");
    expect(target?.label).toBe("View test");
  });

  it("is null when the counterpart is not a changed file in the review", () => {
    const { canvases, pathsForElement } = reviewCanvases([["src/foo.ts"]], ["sequence"]);
    expect(resolveCounterpart(canvases, "sequence", "src/foo.ts", pathsForElement)).toBeNull();
  });

  it("is null for a file with no impl/test partner convention", () => {
    const { canvases, pathsForElement } = reviewCanvases([["docs/README.md"]], ["sequence"]);
    expect(resolveCounterpart(canvases, "sequence", "docs/README.md", pathsForElement)).toBeNull();
  });
});
