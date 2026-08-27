// ─────────────────────────────────────────────────────────────────────────────
// Local lens shapes (B2, #489). The protocol Canvas/CanvasAngle model is deleted
// this change; B3 owns the real `LensKind` home. Counterpart is a B5 survivor, so
// it carries a five-value lens union and the minimal canvas shape it reads.

/** The five review lenses, pending B3's real `LensKind`. */
export type CanvasAngle = "spec" | "sequence" | "decisions" | "noise" | "flagged";
export const CANVAS_ANGLES: readonly CanvasAngle[] = [
  "spec",
  "sequence",
  "decisions",
  "noise",
  "flagged",
];

/** The minimal canvas shape this resolver reads: its analysis elements' keys. */
export interface CounterpartCanvas {
  layers: { analysis: { elements: readonly { elementKey: string }[] } };
}

// ─────────────────────────────────────────────────────────────────────────────
// The implementation ↔ test counterpart jump (Rai, wireframes #7).
//
// Rai's steer: NOT a toggle labelled "implementation / test". A single button that
// says "View test" while you are reading the implementation, and "View
// implementation" while you are reading its test — you press it and land on the
// counterpart. This is that resolution, as a pure function of the open canvas and
// the path currently shown.
//
// Scope, stated honestly: the counterpart is resolved WITHIN THE REVIEW — the file
// on the OTHER side of the impl/test pair that is itself part of this changeset. A
// changed implementation almost always ships its changed test (and vice versa), so
// the pair is usually both present; when the counterpart is NOT in the review there
// is simply no button (there is nothing to jump to on this surface — opening an
// unchanged file in the editor is a separate affordance, the symbol inspector's
// open-in-editor, not this jump).
//
// Matching is the dominant JS/TS suffix convention (`foo.ts` ↔ `foo.test.ts` /
// `foo.spec.ts`), the only convention that is REVERSIBLE both ways. A `__tests__/`
// directory marks a file as a test for other purposes, but it does not yield a
// deterministic implementation path, so it is deliberately not used to resolve a
// counterpart here.
// ─────────────────────────────────────────────────────────────────────────────

/** The resolved counterpart jump for the shown file, or null when there is none to offer. */
export interface CounterpartTarget {
  /** The button label: "View test" on an implementation, "View implementation" on a test. */
  readonly label: string;
  /** The element to select when the button is pressed (the counterpart's element in this review). */
  readonly elementKey: string;
  /** The lens whose canvas carries that element — may differ from the current one. */
  readonly angle: CanvasAngle;
  /** The counterpart file's repo-relative path (for the button's title/tooltip). */
  readonly path: string;
  /** Which side the counterpart is — the shown file's own kind is the opposite. */
  readonly counterpartKind: "test" | "implementation";
}

/** The reversible test-suffix convention: `<base>.<test|spec>.<ext>`. */
const TEST_SUFFIX = /\.(test|spec)\.([cm]?[jt]sx?)$/;

/** True when the path is a test file by the reversible suffix convention. */
export function isTestPath(path: string): boolean {
  return TEST_SUFFIX.test(path);
}

/**
 * The single implementation path a test path maps back to: drop the `.test`/`.spec`
 * infix, keeping the extension. `src/foo.test.ts` → `src/foo.ts`. Returns null when
 * the path is not a test path by the convention.
 */
export function implementationPathFor(testPath: string): string | null {
  if (!TEST_SUFFIX.test(testPath)) return null;
  return testPath.replace(TEST_SUFFIX, ".$2");
}

/**
 * The test path candidates an implementation path maps forward to: `<base>.test.<ext>`
 * and `<base>.spec.<ext>`, keeping the implementation's extension. `src/foo.ts` →
 * [`src/foo.test.ts`, `src/foo.spec.ts`]. Empty for a path with no recognised
 * TS/JS extension (nothing to pair) or for a path that is already a test.
 */
export function testPathsFor(implPath: string): string[] {
  if (isTestPath(implPath)) return [];
  const match = implPath.match(/\.([cm]?[jt]sx?)$/);
  const ext = match?.[1];
  if (ext === undefined) return [];
  const base = implPath.slice(0, implPath.length - (ext.length + 1));
  return [`${base}.test.${ext}`, `${base}.spec.${ext}`];
}

/**
 * Resolves an element to the SET of repo-relative paths its diff renders — the same
 * per-element diff the workspace shows (`diffFor(elementKey).paths`). This is the
 * authoritative file↔element mapping, and it is a SET on purpose: a proposal chunk
 * can regroup hunks from several files (an implementation AND its test) into ONE
 * element, so testing membership is what finds the counterpart, not comparing a
 * single `path`. It also does NOT go through chunk/hunk IDs, so it is immune to the
 * floor-vs-proposal ID mismatch (the floor substrate carries floor chunk IDs, but a
 * live admitted decomposition anchors Sequence elements to PROPOSAL chunk IDs that
 * regroup hunks and mint different IDs — matching on those IDs breaks; matching on
 * the rendered path set does not).
 */
export type ElementPathsResolver = (elementKey: string) => readonly string[] | undefined;

/**
 * Locate a file's element across the review's lenses, INDEPENDENT of which lens is
 * active and of the analysis ID shape. The counterpart's presence is a property of
 * the review (its changed-file inventory), not of the current lens's placement — so a
 * changed test with no *decision* element must still resolve, INCLUDING when it was
 * regrouped into the same proposal chunk as its implementation (one element rendering
 * both files). Prefers the current lens (no lens switch when it already renders that
 * file), then falls back to any other lens — in practice the `sequence` lens, which
 * has an element per changed chunk. Null only when no element in the review renders
 * that path.
 */
function locatePath(
  canvases: Record<CanvasAngle, CounterpartCanvas>,
  currentAngle: CanvasAngle,
  path: string,
  pathsForElement: ElementPathsResolver,
): { angle: CanvasAngle; elementKey: string } | null {
  const order: CanvasAngle[] = [currentAngle, ...CANVAS_ANGLES.filter((a) => a !== currentAngle)];
  for (const angle of order) {
    const canvas = canvases[angle];
    if (!canvas) continue;
    for (const element of canvas.layers.analysis.elements) {
      if (pathsForElement(element.elementKey)?.includes(path)) {
        return { angle, elementKey: element.elementKey };
      }
    }
  }
  return null;
}

/**
 * Resolve the impl↔test counterpart jump for the file currently shown, or null when
 * there is none to offer. Pure: reads the canvas set, the path, and a resolver from
 * elementKey → the SET of paths its diff renders (the workspace's `diffFor(...).paths`).
 *
 *   - a TEST file → its implementation, labelled "View implementation";
 *   - an IMPLEMENTATION file → its test (`.test.` preferred, then `.spec.`),
 *     labelled "View test";
 *   - the counterpart must be a changed file in THIS review (resolved across lenses
 *     by DIFF-PATH MEMBERSHIP, not by analysis ID or a single path), else null.
 */
export function resolveCounterpart(
  canvases: Record<CanvasAngle, CounterpartCanvas>,
  currentAngle: CanvasAngle,
  currentPath: string,
  pathsForElement: ElementPathsResolver,
): CounterpartTarget | null {
  if (isTestPath(currentPath)) {
    const implPath = implementationPathFor(currentPath);
    if (!implPath) return null;
    const located = locatePath(canvases, currentAngle, implPath, pathsForElement);
    if (!located) return null;
    return {
      label: "View implementation",
      elementKey: located.elementKey,
      angle: located.angle,
      path: implPath,
      counterpartKind: "implementation",
    };
  }
  // An implementation file: try the test candidates in preference order, and take
  // the first that is a changed file rendered in the review (any lens).
  for (const testPath of testPathsFor(currentPath)) {
    const located = locatePath(canvases, currentAngle, testPath, pathsForElement);
    if (located) {
      return {
        label: "View test",
        elementKey: located.elementKey,
        angle: located.angle,
        path: testPath,
        counterpartKind: "test",
      };
    }
  }
  return null;
}
