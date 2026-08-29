// ─────────────────────────────────────────────────────────────────────────────
// The implementation ↔ test path pairing (Rai, wireframes #7) — the pure string
// half of the counterpart jump, shared by the UI's counterpart resolution
// (app-ui) and the delta packet's counterpart hints (core/delta, B5).
//
// Matching is the dominant JS/TS suffix convention (`foo.ts` ↔ `foo.test.ts` /
// `foo.spec.ts`), the only convention that is REVERSIBLE both ways. A `__tests__/`
// directory marks a file as a test for other purposes, but it does not yield a
// deterministic implementation path, so it is deliberately not used to resolve a
// counterpart here.
// ─────────────────────────────────────────────────────────────────────────────

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
 * Resolve the implementation/test counterpart for one captured path.
 *
 * Both the shown path and its counterpart must belong to `capturedPaths`. This keeps
 * the jump inside the immutable patchset instead of turning the naming convention into
 * a filesystem guess. For an implementation with both conventions captured, `.test.`
 * wins in the same order returned by {@link testPathsFor}.
 */
export function counterpartPathFor(
  path: string,
  capturedPaths: ReadonlySet<string>,
): string | null {
  if (!capturedPaths.has(path)) return null;
  if (isTestPath(path)) {
    const implementationPath = implementationPathFor(path);
    return implementationPath !== null && capturedPaths.has(implementationPath)
      ? implementationPath
      : null;
  }
  return testPathsFor(path).find((candidate) => capturedPaths.has(candidate)) ?? null;
}
