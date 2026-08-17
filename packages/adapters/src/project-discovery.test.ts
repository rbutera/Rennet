import { sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GitExec } from "./git-range-diff";
import { discoverProject, type ProjectDiscoveryDeps } from "./project-discovery";

/**
 * A fake git that answers the read-only verbs discovery issues, keyed on the repo
 * root and the first argument. Any unlisted verb returns "" (the reject:false
 * shape). `calls` records every invocation so a test can PROVE discovery never
 * issues a mutating verb.
 */
function fakeGit(repos: Record<string, Record<string, string>>): {
  git: GitExec;
  calls: { root: string; args: string[] }[];
} {
  const calls: { root: string; args: string[] }[] = [];
  const git: GitExec = async (root, args) => {
    calls.push({ root, args: [...args] });
    // Discovery joins `workspace/child` with the HOST separator, so on win32 `root`
    // arrives back-slashed; the fixture keys are POSIX. Normalize for the lookup so
    // the fake is separator-agnostic (the product's native join stays under test).
    const table = repos[root] ?? repos[root.split(sep).join("/")] ?? {};
    // Key on a stable join of the leading verb + the ref it targets.
    const key = args.join(" ");
    return table[key] ?? "";
  };
  return { git, calls };
}

const REPO = {
  "rev-parse --is-inside-work-tree": "true\n",
  "for-each-ref --format=%(refname:short) refs/heads": "main\nfeat/rate-limiting\nfix/ttl\n",
  "remote get-url origin": "git@github.com:orbital/atlas.git\n",
  "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
};

describe("discoverProject — a single project repo", () => {
  it("reads the repo's branches, remote identity, and primary branch (read-only)", async () => {
    const { git, calls } = fakeGit({ "/code/atlas": REPO });
    const deps: ProjectDiscoveryDeps = {
      git,
      listSubdirs: () => Promise.resolve([]),
      hasGitEntry: () => Promise.resolve(true),
    };

    const result = await discoverProject(deps, "/code/atlas", "repo");

    expect(result.kind).toBe("repo");
    expect(result.path).toBe("/code/atlas");
    expect(result.primaryBranch).toBe("main");
    expect(result.repos).toEqual([
      { name: "atlas", path: "/code/atlas", branches: 3, remote: "github.com/orbital/atlas" },
    ]);
    // The zero-mutation floor: every verb issued is a read. A single mutating verb
    // (checkout/commit/worktree add/…) failing this is the point of the assertion.
    const mutating = calls.filter(({ args }) =>
      ["checkout", "commit", "add", "worktree", "reset", "branch", "push", "merge"].includes(
        args[0] ?? "",
      ),
    );
    expect(mutating).toEqual([]);
  });

  it("falls through to `main` when a fresh repo has no origin/HEAD and a detached HEAD", async () => {
    const { git } = fakeGit({
      "/code/fresh": {
        "rev-parse --is-inside-work-tree": "true\n",
        "for-each-ref --format=%(refname:short) refs/heads": "",
        "rev-parse --abbrev-ref HEAD": "HEAD\n",
      },
    });
    const result = await discoverProject(
      { git, listSubdirs: () => Promise.resolve([]), hasGitEntry: () => Promise.resolve(false) },
      "/code/fresh",
      "repo",
    );
    expect(result.primaryBranch).toBe("main");
    expect(result.repos[0]).toMatchObject({ name: "fresh", branches: 0 });
    expect(result.repos[0]?.remote).toBeUndefined();
  });

  it("reports no repos when the path is not a git working tree", async () => {
    const { git } = fakeGit({ "/code/plain": { "rev-parse --is-inside-work-tree": "false\n" } });
    const result = await discoverProject(
      { git, listSubdirs: () => Promise.resolve([]), hasGitEntry: () => Promise.resolve(false) },
      "/code/plain",
      "repo",
    );
    expect(result.repos).toEqual([]);
  });
});

describe("discoverProject — a workspace of repos", () => {
  it("scans the immediate children and describes each git working tree", async () => {
    const { git } = fakeGit({
      "/orbital/atlas": {
        "rev-parse --is-inside-work-tree": "true\n",
        "for-each-ref --format=%(refname:short) refs/heads": "main\ndev\nfeat\n",
        "remote get-url origin": "https://github.com/orbital/atlas.git\n",
        "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      },
      "/orbital/navcore": {
        "rev-parse --is-inside-work-tree": "true\n",
        "for-each-ref --format=%(refname:short) refs/heads": "main\nwork\n",
      },
    });
    const deps: ProjectDiscoveryDeps = {
      git,
      // A non-repo `notes` child is walked but never becomes a row.
      listSubdirs: () => Promise.resolve(["atlas", "navcore", "notes"]),
      hasGitEntry: (dir) => Promise.resolve(dir.endsWith("atlas") || dir.endsWith("navcore")),
    };

    const result = await discoverProject(deps, "/orbital", "workspace");

    expect(result.kind).toBe("workspace");
    expect(result.repos.map((repo) => repo.name)).toEqual(["atlas", "navcore"]);
    expect(result.repos[0]).toMatchObject({ branches: 3, remote: "github.com/orbital/atlas" });
    expect(result.repos[1]).toMatchObject({ branches: 2 });
    expect(result.primaryBranch).toBe("main");
    expect(result.reconciliation).toBeUndefined();
  });

  it("SURFACES a walk-vs-list disagreement rather than silently resolving it", async () => {
    // `ghost` carries a .git entry (the filesystem walk) but git does not accept it
    // as a work tree (the list). Discovery must report the disagreement, not hide it.
    const { git } = fakeGit({
      "/orbital/atlas": {
        "rev-parse --is-inside-work-tree": "true\n",
        "for-each-ref --format=%(refname:short) refs/heads": "main\n",
      },
      "/orbital/ghost": { "rev-parse --is-inside-work-tree": "false\n" },
    });
    const deps: ProjectDiscoveryDeps = {
      git,
      listSubdirs: () => Promise.resolve(["atlas", "ghost"]),
      hasGitEntry: () => Promise.resolve(true),
    };

    const result = await discoverProject(deps, "/orbital", "workspace");

    expect(result.repos.map((repo) => repo.name)).toEqual(["atlas"]);
    expect(result.reconciliation).toBeDefined();
    expect(result.reconciliation).toContain("ghost");
  });

  it("kills discovery when the abort deps reject (no repos, no throw)", async () => {
    // A listSubdirs that returns nothing yields an empty workspace, not a crash.
    const git = vi.fn(async () => "") as unknown as GitExec;
    const result = await discoverProject(
      { git, listSubdirs: () => Promise.resolve([]), hasGitEntry: () => Promise.resolve(false) },
      "/orbital",
      "workspace",
    );
    expect(result.repos).toEqual([]);
    expect(result.primaryBranch).toBe("main");
  });
});
