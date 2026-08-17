import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Owned grep-grade guard (#334, task 3.3). Every review-pipeline model turn in MAIN
// must resolve the project's execution locus, so a WSL-locus review runs inside the
// distro instead of silently degrading to a host-locus harness. A bare
// `getClaudeHarness()` (no locus argument) is exactly that regression, so this test
// reddens the moment one is (re)introduced. The locus-carrying form
// `getClaudeHarness(locus, distroCwd)` and the type reference `typeof
// getClaudeHarness` are both fine — only the zero-argument CALL is forbidden.
describe("locus threading in MAIN", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("constructs no host-default Claude harness (every site threads the locus)", () => {
    expect(source).not.toContain("getClaudeHarness()");
  });

  it("threads the locus through the read-pipeline via locusContextForRepo", () => {
    // The one-line adoption pattern every host-defaulting site now uses.
    expect(source).toContain("locusContextForRepo(review.repositoryRoot)");
  });
});
