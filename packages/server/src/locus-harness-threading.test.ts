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
  const source = readFileSync(new URL("./create-server.ts", import.meta.url), "utf8");

  /** The first-line argument text of every CALL to `fn` (definition excluded). */
  function callArgs(fn: string): string[] {
    // `(?<!function )` drops the `function <fn>(` definition; `[^)]*` captures the
    // call's argument list up to the first `)` (no nested-call sites exist here).
    const re = new RegExp(`(?<!function )${fn}\\(([^)]*)\\)`, "g");
    return [...source.matchAll(re)].map((m) => (m[1] ?? "").trim());
  }

  it("threads a repo-derived locus into every getClaudeHarness call (no host-default)", () => {
    const calls = callArgs("getClaudeHarness");
    // Exactly the read-pipeline + handoff + project-contextAsk sites that survive the
    // Board rebuild (B2), all `(locus, distroCwd)`. Exact, not `>=`: a new host-default
    // site added later must fail this, not slip under a floor. (B06 dropped the
    // knowledge-pass site: the swarm scheduler routes through claudeAdapterForRepo,
    // which is itself one of the counted locus-threading call sites.)
    expect(calls).toHaveLength(7);
    for (const arg of calls) {
      // Every call threads the repo-resolved `locus` variable — never `HOST_LOCUS`,
      // never a zero-arg host default.
      expect(arg.startsWith("locus"), `getClaudeHarness(${arg}) must thread locus`).toBe(true);
    }
  });

  it("threads a repo-derived locus into every getCodexResolution review turn", () => {
    const calls = callArgs("getCodexResolution");
    // Exactly 4 call sites that survive the Board rebuild (B2). Three review-side turns
    // thread the repo-resolved `locus`; the one exception is the host-global availability
    // boot probe, which passes `HOST_LOCUS` explicitly (no repo in scope). There is NO
    // zero-arg form — the default parameter was removed, so `getCodexResolution()` no
    // longer typechecks. This guards the remaining risk: a review site hardcoding HOST_LOCUS.
    expect(calls).toHaveLength(4);
    const hostCalls = calls.filter((arg) => arg === "HOST_LOCUS");
    const locusCalls = calls.filter((arg) => arg.startsWith("locus"));
    expect(hostCalls).toHaveLength(1);
    expect(locusCalls).toHaveLength(3);
    // Bind that one HOST_LOCUS call to the boot probe specifically: it lives in
    // `getCodexAvailability`, not in any review turn. Hardcoding HOST_LOCUS at a review
    // site would push this count past 1 AND fail this line-context check. (Indentation-
    // agnostic since the composition now nests inside `createRennetServer` — #377.)
    expect(source).toMatch(
      /function getCodexAvailability\(\): Promise<CodexAvailability> \{\s+return getCodexResolution\(HOST_LOCUS\)/,
    );
  });

  it("threads the locus through the read-pipeline via locusContextForRepo", () => {
    // The one-line adoption pattern every host-defaulting review site now uses.
    expect(source).toContain("locusContextForRepo(review.repositoryRoot)");
  });
});
