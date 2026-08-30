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
    // Exactly the direct read-pipeline + project-contextAsk sites and the shared
    // claudeAdapterForRepo resolver used by handoff turns. Exact, not `>=`: a new
    // host-default site added later must fail this, not slip under a floor.
    expect(calls).toHaveLength(6);
    for (const arg of calls) {
      // Every call threads the repo-resolved `locus` variable — never `HOST_LOCUS`,
      // never a zero-arg host default.
      expect(arg.startsWith("locus"), `getClaudeHarness(${arg}) must thread locus`).toBe(true);
    }
  });

  it("threads a repo-derived locus into every getCodexResolution review turn", () => {
    const calls = callArgs("getCodexResolution");
    // Exactly 3 call sites, ALL of them review-side turns threading the repo-resolved
    // `locus` — no HOST_LOCUS call survives. The host-global availability probe used to be
    // the one exception; C17's review finding 2 deleted it, because reusing this cache
    // (which holds a live adapter bound to a binary path) for the DISCLOSURE line is what
    // pinned the codex row until the daemon restarted. Detection now probes directly.
    // The review-ask site resolves through `codexExecutorForRepo`; coding rounds resolve
    // through `codexAdapterForRepo`. Both thread the locus and root the seat at the
    // checkout. There is NO zero-arg form — the default parameter was removed, so
    // `getCodexResolution()` no longer typechecks. Exact, not `>=`: a new host-default site
    // added later must fail this, not slip under a floor.
    expect(calls).toHaveLength(3);
    expect(calls.filter((arg) => arg === "HOST_LOCUS")).toHaveLength(0);
    expect(calls.filter((arg) => arg.startsWith("locus"))).toHaveLength(3);
  });

  it("threads the locus through the read-pipeline via locusContextForRepo", () => {
    // The one-line adoption pattern every host-defaulting review site now uses.
    expect(source).toContain("locusContextForRepo(review.repositoryRoot)");
  });
});
