import type { Canvas, CanvasAngle } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { implementationPathFor, isTestPath, resolveCounterpart, testPathsFor } from "./counterpart";

// A review canvas set where each named angle places one element per file, plus a
// resolver from elementKey → the file its diff renders. Two things about the shape
// are deliberate and load-bearing:
//   • substrate is EMPTY and element anchors are PROPOSAL-style ids that match no
//     floor/substrate chunk id — proving resolution no longer depends on the id
//     shape (the live admitted-decomposition case that broke id-matching);
//   • only the given angles carry elements, so the cross-lens fallback is exercised.
function reviewCanvases(
  files: string[],
  anglesWithElements: CanvasAngle[],
): { canvases: Record<CanvasAngle, Canvas>; pathForElement: (key: string) => string | undefined } {
  const paths = new Map<string, string>();
  const build = (angle: CanvasAngle): Canvas => {
    const withElements = anglesWithElements.includes(angle);
    const elements = withElements
      ? files.map((path, index) => {
          const elementKey = `${angle}-el-${index + 1}`;
          paths.set(elementKey, path);
          return {
            elementKey,
            docId: `doc-${index + 1}`,
            // A PROPOSAL chunk id that intentionally differs from any floor id.
            anchor: `rennet:chunk/proposal-${angle}-${index + 1}`,
            kind: "chunk",
            title: path,
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
    pathForElement: (key) => paths.get(key),
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
    const { canvases, pathForElement } = reviewCanvases(
      ["src/foo.ts", "src/foo.test.ts"],
      ["sequence"],
    );
    expect(resolveCounterpart(canvases, "sequence", "src/foo.ts", pathForElement)).toEqual({
      label: "View test",
      elementKey: "sequence-el-2",
      angle: "sequence",
      path: "src/foo.test.ts",
      counterpartKind: "test",
    });
  });

  it("on a test, points back at its implementation (View implementation)", () => {
    const { canvases, pathForElement } = reviewCanvases(
      ["src/foo.ts", "src/foo.test.ts"],
      ["sequence"],
    );
    expect(resolveCounterpart(canvases, "sequence", "src/foo.test.ts", pathForElement)).toEqual({
      label: "View implementation",
      elementKey: "sequence-el-1",
      angle: "sequence",
      path: "src/foo.ts",
      counterpartKind: "implementation",
    });
  });

  it("LIVE SHAPE: resolves even though element anchors are proposal ids (not floor/substrate ids)", () => {
    // substrate is empty and the sequence element's anchor is `rennet:chunk/proposal-...`
    // — the exact shape that broke id-based matching. Resolution by diff path succeeds.
    const { canvases, pathForElement } = reviewCanvases(
      ["src/foo.ts", "src/foo.test.ts"],
      ["sequence"],
    );
    const seq = canvases.sequence.layers.analysis.elements[1];
    expect(seq?.anchor).toBe("rennet:chunk/proposal-sequence-2"); // not a floor id
    expect(canvases.sequence.layers.substrate.chunks).toHaveLength(0); // no substrate to match on
    expect(resolveCounterpart(canvases, "sequence", "src/foo.ts", pathForElement)?.elementKey).toBe(
      "sequence-el-2",
    );
  });

  it("resolves ACROSS lenses: in Decisions (no element) it still finds the test via sequence", () => {
    const { canvases, pathForElement } = reviewCanvases(
      ["src/foo.ts", "src/foo.test.ts"],
      ["sequence"],
    );
    const target = resolveCounterpart(canvases, "decisions", "src/foo.ts", pathForElement);
    expect(target?.path).toBe("src/foo.test.ts");
    expect(target?.angle).toBe("sequence"); // fell back off the active lens
    expect(target?.elementKey).toBe("sequence-el-2");
  });

  it("prefers the CURRENT lens when it renders the file (no lens switch)", () => {
    const { canvases, pathForElement } = reviewCanvases(
      ["src/foo.ts", "src/foo.test.ts"],
      ["sequence", "decisions"],
    );
    const target = resolveCounterpart(canvases, "decisions", "src/foo.ts", pathForElement);
    expect(target?.angle).toBe("decisions");
    expect(target?.elementKey).toBe("decisions-el-2");
  });

  it("prefers a .test. counterpart over .spec. when both are present", () => {
    const { canvases, pathForElement } = reviewCanvases(
      ["src/foo.ts", "src/foo.spec.ts", "src/foo.test.ts"],
      ["sequence"],
    );
    expect(resolveCounterpart(canvases, "sequence", "src/foo.ts", pathForElement)?.path).toBe(
      "src/foo.test.ts",
    );
  });

  it("falls back to a .spec. counterpart when no .test. is in the review", () => {
    const { canvases, pathForElement } = reviewCanvases(
      ["src/foo.ts", "src/foo.spec.ts"],
      ["sequence"],
    );
    const target = resolveCounterpart(canvases, "sequence", "src/foo.ts", pathForElement);
    expect(target?.path).toBe("src/foo.spec.ts");
    expect(target?.label).toBe("View test");
  });

  it("is null when the counterpart is not a changed file in the review", () => {
    const { canvases, pathForElement } = reviewCanvases(["src/foo.ts"], ["sequence"]);
    expect(resolveCounterpart(canvases, "sequence", "src/foo.ts", pathForElement)).toBeNull();
  });

  it("is null for a file with no impl/test partner convention", () => {
    const { canvases, pathForElement } = reviewCanvases(["docs/README.md"], ["sequence"]);
    expect(resolveCounterpart(canvases, "sequence", "docs/README.md", pathForElement)).toBeNull();
  });
});
