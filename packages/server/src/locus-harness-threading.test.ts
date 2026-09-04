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
    // ONE site: `claudeAdapterForRepo`. The direct read-pipeline sites (flagged, noise,
    // coverage) were folded into that single resolver with the #681 residue, so there is
    // now exactly one Claude harness construction and one place a host default could
    // creep back in. Exact, not `>=`: a new host-default site added later must fail this,
    // not slip under a floor.
    expect(calls).toHaveLength(1);
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
    // The surviving sites resolve through `codexExecutorForRepo`, threading the locus and
    // rooting the seat at the checkout. The third was `codexAdapterForRepo`, which existed
    // only for the ephemeral round worker and went with it (session-bound-workspace D2 — a
    // round is a turn on the session's bound T3 thread and resolves no harness here).
    // There is NO zero-arg form — the default parameter was removed, so
    // `getCodexResolution()` no longer typechecks. Exact, not `>=`: a new host-default site
    // added later must fail this, not slip under a floor.
    expect(calls).toHaveLength(2);
    expect(calls.filter((arg) => arg === "HOST_LOCUS")).toHaveLength(0);
    expect(calls.filter((arg) => arg.startsWith("locus"))).toHaveLength(2);
  });

  // The CONSUMER half, restored (#681 residue / C14 D3). Folding the three read-pipeline
  // Claude constructions into `claudeAdapterForRepo` moved the risk one layer out: the
  // `getClaudeHarness` guard above now only proves the RESOLVER threads a locus, and
  // would stay green while a consumer handed that resolver the wrong repository — which
  // is precisely the workspace→repo mapping defect class (many repos, one project id).
  // So enumerate the consumers as well. Every call must pass a repository root its own
  // caller was given: the review's `review.repositoryRoot`, or the `repoRoot` the turn
  // was addressed with. A project path, a workspace path, or a host default reddens this.
  it("passes a caller-owned turn root into every claudeAdapterForRepo consumer", () => {
    const calls = callArgs("claudeAdapterForRepo");
    // Exact, not `>=`. TWO consumers: the flagged runner and the noise runner, both on
    // the `turnRoot` local. The third was the round worker's own coding turn, gone with the
    // ephemeral round leg (session-bound-workspace D2 — a round is a turn on the session's
    // bound T3 thread now, and reaches no adapter here); the fourth was the coverage seat
    // (#681), gone with the coverage turn; the fifth was the review-ask run port, gone with
    // the orchestrator chat (t3-lens-threads 4.2). Bare references
    // (`resolveClaudePort: claudeAdapterForRepo`) are not calls and do not match; they hand
    // the function on, and the site that CALLS it is counted here.
    //
    // `turnRoot`, not `review.repositoryRoot` (session-bound-workspace 5.2): a WSL adapter
    // BAKES its `wsl.exe --cd` argument at construction and `transportCwd` beats the
    // session's `cwd`, so the root this resolver is handed is the one every turn of that
    // harness actually runs in. Resolving from the repository while the turn asks for the
    // bound worktree silently drops the request. The two are the same value for a branch
    // review on the reviewer's own checkout and differ exactly when it matters.
    expect(calls).toHaveLength(2);
    expect(calls.filter((arg) => arg === "turnRoot")).toHaveLength(2);
    for (const arg of calls) {
      expect(
        ["turnRoot", "repoRoot"],
        `claudeAdapterForRepo(${arg}) must pass a caller-owned turn root`,
      ).toContain(arg);
    }
    // ...and `turnRoot` is REVIEW-derived, never an ambient or project path. Without this
    // the enumeration above would stay green if `turnRoot` were reassigned to a workspace
    // path, which is the many-repos-one-project defect class this guard exists for.
    expect(source).toContain("const turnRoot = turnRootFor(review);");
  });

  it("derives the flagged runner's Codex locus from the same turn root", () => {
    // NOT the Claude read-pipeline adoption pattern any more — the Claude sites went
    // through `claudeAdapterForRepo` (enumerated above), and the surviving
    // `locusContextForRepo(turnRoot)` call is the flagged runner deriving the locus it
    // hands `getCodexResolution`. One value for both legs, so the Codex seat cannot end up
    // rooted in a different tree from the Claude seat of the same review. What this CANNOT
    // catch: it is a substring check, so it proves the call exists, not that the flagged
    // runner is the only reader or that no second site resolves a locus from something
    // else. The two enumerations above are the load-bearing guards.
    expect(source).toContain("locusContextForRepo(turnRoot)");
  });
});
