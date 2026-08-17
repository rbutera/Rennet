import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Owned enumeration guard (#334, task 3.3; Codex FAIL #4). Every review-pipeline
// harness construction in MAIN must resolve the project's execution locus from a repo
// root, so a WSL-locus review runs inside the distro instead of silently degrading to
// a host-locus harness. The earlier `not.toContain("getClaudeHarness()")` guard was
// vacuous: it stayed green under a `getClaudeHarness(HOST_LOCUS)` mutation. This
// instead ENUMERATES every call expression and asserts each threads the repo-derived
// `locus` variable — hardcoding `HOST_LOCUS` (or any non-repo locus) at any one site
// reddens it. `typeof getClaudeHarness` and the function definitions are excluded.
describe("locus threading in MAIN", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  /** The first-line argument text of every CALL to `fn` (definition excluded). */
  function callArgs(fn: string): string[] {
    // `(?<!function )` drops the `function <fn>(` definition; `[^)]*` captures the
    // call's argument list up to the first `)` (no nested-call sites exist here).
    const re = new RegExp(`(?<!function )${fn}\\(([^)]*)\\)`, "g");
    return [...source.matchAll(re)].map((m) => (m[1] ?? "").trim());
  }

  it("threads a repo-derived locus into every getClaudeHarness call (no host-default)", () => {
    const calls = callArgs("getClaudeHarness");
    // The 10 read-pipeline + handoff sites all pass `(locus, distroCwd)`.
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const arg of calls) {
      // Every call threads the repo-resolved `locus` variable — never `HOST_LOCUS`,
      // never a zero-arg host default.
      expect(arg.startsWith("locus"), `getClaudeHarness(${arg}) must thread locus`).toBe(true);
    }
  });

  it("threads a repo-derived locus into every getCodexResolution review turn", () => {
    const calls = callArgs("getCodexResolution");
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const arg of calls) {
      // Review turns pass the repo-resolved `locus`; the sole zero-arg call is the
      // host-global availability boot probe (no repo in scope), explicitly allowed.
      const ok = arg === "" || arg.startsWith("locus");
      expect(ok, `getCodexResolution(${arg}) must thread locus (or be the host probe)`).toBe(true);
    }
  });

  it("threads the locus through the read-pipeline via locusContextForRepo", () => {
    // The one-line adoption pattern every host-defaulting review site now uses.
    expect(source).toContain("locusContextForRepo(review.repositoryRoot)");
  });
});
