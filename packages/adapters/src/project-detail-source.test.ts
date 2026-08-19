import type { Project, PullRequest } from "@rennet/protocol";
import { projectDetailSchema } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import type { GitExec } from "./git-range-diff";
import {
  defaultProjectDetailSourceDeps,
  loadProjectDetail,
  type ProjectDetailSourceDeps,
} from "./project-detail-source";
import type { ProjectPrSource } from "./project-pr-source";

/** A canned PullRequest for the B2 merge tests. */
const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  id: "PR_1",
  number: 7,
  title: "Front door",
  repository: "acme/widget",
  branch: "feat/x",
  author: "octocat",
  state: "open",
  reviewRequestedFromViewer: false,
  ci: "passing",
  additions: 10,
  deletions: 1,
  changedFiles: 2,
  lastActivityAt: "2026-08-10T00:00:00.000Z",
  ...overrides,
});

/** ISO-Z instant for a unix-seconds time, mirroring the source's own conversion. */
const iso = (unix: number): string => new Date(unix * 1000).toISOString();

/** Build a NUL-delimited `git worktree list --porcelain -z` payload. */
const wtz = (records: { path: string; branch?: string }[]): string =>
  records
    .map(
      (r) =>
        `worktree ${r.path}\0HEAD ${"a".repeat(40)}\0${
          r.branch ? `branch refs/heads/${r.branch}` : "detached"
        }\0\0`,
    )
    .join("");

/** A single repo root's canned git responses. */
interface RepoFixture {
  remoteUrl?: string;
  commonDir?: string;
  userName?: string;
  userEmail?: string;
  /** branch short name → committer time (unix seconds). */
  branches: Record<string, number>;
  /** worktree records → the `-z` payload. */
  worktrees?: { path: string; branch?: string }[];
  /** branch → ahead/behind vs the primary branch; a MISSING entry simulates rev-list failing. */
  aheadBehind?: Record<string, { ahead: number; behind: number }>;
  /** worktree paths considered dirty by `status --porcelain`. */
  dirtyWorktrees?: string[];
}

/** Build an injected GitExec over a set of repo roots + their worktrees' dirtiness. */
function makeGit(repos: Record<string, RepoFixture>): GitExec {
  const dirty = new Set<string>();
  for (const repo of Object.values(repos)) {
    for (const path of repo.dirtyWorktrees ?? []) dirty.add(path);
  }
  return async (root, args) => {
    // `status` is issued with cwd = the WORKTREE path, not the repo root.
    if (args[0] === "status") return dirty.has(root) ? "M src/file.ts\n" : "";
    const repo = repos[root];
    if (!repo) return "";
    switch (args[0]) {
      case "config":
        return args[1] === "user.name" ? (repo.userName ?? "") : (repo.userEmail ?? "");
      case "remote":
        return repo.remoteUrl ?? "";
      case "rev-parse":
        // `rev-parse --path-format=absolute --git-common-dir`
        return repo.commonDir ?? "";
      case "for-each-ref":
        return `${Object.entries(repo.branches)
          .map(([name, unix]) => `${name}\t${unix}`)
          .join("\n")}\n`;
      case "worktree":
        return wtz(repo.worktrees ?? []);
      case "rev-list": {
        const spec = args[args.length - 1] ?? "";
        const branch = spec.split("...")[1] ?? "";
        const ab = repo.aheadBehind?.[branch];
        if (!ab) return ""; // rev-list failed: base unresolvable
        // `--left-right --count` prints "behind<TAB>ahead" for `primary...branch`.
        return `${ab.behind}\t${ab.ahead}\n`;
      }
      case "log":
        return "0\n";
      default:
        return "";
    }
  };
}

/** A repo-kind project rooted at `path`. */
const repoProject = (path: string, primaryBranch = "main"): Project => ({
  id: "p1",
  name: "widget",
  path,
  kind: "repo",
  repoCount: 1,
  branchCount: 3,
  primaryBranch,
  openPath: path,
  addedAt: "2026-08-09T00:00:00.000Z",
});

/** Deps that resolve fixed repo roots, so enumeration is testable without a workspace. */
const depsWith = (git: GitExec, roots: readonly string[]): ProjectDetailSourceDeps => ({
  git,
  resolveRepoRoots: () => Promise.resolve(roots),
});

/** main + one linked feature worktree. */
const twoWorktrees = [
  { path: "/repo", branch: "main" },
  { path: "/wt/x", branch: "feat/x" },
];

describe("loadProjectDetail — live local work (B1)", () => {
  it("maps worktrees + branches to LocalWork, excluding the primary branch", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "Rai Butera",
        branches: { main: 1000, "feat/x": 2000, "feat/y": 1500 },
        worktrees: twoWorktrees,
        aheadBehind: { "feat/x": { ahead: 3, behind: 0 }, "feat/y": { ahead: 1, behind: 2 } },
        dirtyWorktrees: ["/wt/x"],
      },
    });

    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));

    expect(detail.viewer.login).toBe("Rai Butera");
    expect(detail.prs).toEqual([]);
    expect(detail.truncated).toBe(false);

    const byBranch = new Map(detail.locals.map((l) => [l.branch, l]));
    expect([...byBranch.keys()].sort()).toEqual(["feat/x", "feat/y"]); // main excluded

    expect(byBranch.get("feat/x")).toEqual({
      id: "/wt/x", // the worktree path — the clean-up target
      repository: "acme/widget",
      branch: "feat/x",
      author: "Rai Butera", // local work is the viewer's
      dirty: true,
      ahead: 3,
      behind: 0,
      stage: "captured",
      lastActivityAt: iso(2000),
    });
    expect(byBranch.get("feat/y")).toEqual({
      id: "acme/widget#feat/y", // no worktree on disk → a branch target
      repository: "acme/widget",
      branch: "feat/y",
      author: "Rai Butera",
      dirty: false,
      ahead: 1,
      behind: 2,
      stage: "captured",
      lastActivityAt: iso(1500),
    });
  });

  it("folds a checked-out branch into ONE row (worktree wins over the bare ref)", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1000, "feat/x": 2000 }, // feat/x is both a ref AND a worktree
        worktrees: twoWorktrees,
        aheadBehind: { "feat/x": { ahead: 3, behind: 0 } },
        dirtyWorktrees: ["/wt/x"],
      },
    });

    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));

    const feat = detail.locals.filter((l) => l.branch === "feat/x");
    expect(feat).toHaveLength(1); // no double-count
    expect(feat[0]?.id).toBe("/wt/x"); // the worktree form, with its real dirty signal
    expect(feat[0]?.dirty).toBe(true);
  });

  it("reports ahead/behind as null (not 0/0) when the base ref is unresolvable", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1000, "feat/orphan": 2000 },
        worktrees: [{ path: "/repo", branch: "main" }],
        aheadBehind: {}, // rev-list fails for feat/orphan → null, never a false 0/0
      },
    });

    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));
    const orphan = detail.locals.find((l) => l.branch === "feat/orphan");
    expect(orphan?.ahead).toBeNull();
    expect(orphan?.behind).toBeNull();
  });

  it("preserves a worktree path with whitespace via NUL-delimited parsing", async () => {
    const weird = "/wt/with space/feat";
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1000, "feat/x": 2000 },
        worktrees: [
          { path: "/repo", branch: "main" },
          { path: weird, branch: "feat/x" },
        ],
        aheadBehind: { "feat/x": { ahead: 1, behind: 0 } },
      },
    });

    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));
    expect(detail.locals.find((l) => l.branch === "feat/x")?.id).toBe(weird); // exact, not corrupted
  });

  it("produces output that validates against projectDetailSchema (ISO-Z timestamps)", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "https://github.com/acme/widget",
        userName: "rai",
        branches: { main: 1000, "feat/x": 2000 },
        worktrees: twoWorktrees,
        aheadBehind: { "feat/x": { ahead: 1, behind: 0 } },
      },
    });

    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));
    expect(() => projectDetailSchema.parse(detail)).not.toThrow();
    // The fixture set is gone from the local-work path: no fixture ids, no seeded PRs.
    expect(detail.locals.every((l) => !l.id.startsWith("local-"))).toBe(true);
    expect(detail.prs).toEqual([]);
  });

  it("uses the git-common-dir identity (not the basename) when there is no remote", async () => {
    const gitEmail = makeGit({
      "/some/repo": {
        commonDir: "/some/repo/.git", // no remote → the durable RepoRecord identity (R19)
        userEmail: "rai@example.com", // no user.name
        branches: { main: 1000, "feat/z": 2000 },
        aheadBehind: { "feat/z": { ahead: 2, behind: 0 } },
      },
    });
    const detail = await loadProjectDetail(
      depsWith(gitEmail, ["/some/repo"]),
      repoProject("/some/repo"),
    );
    expect(detail.viewer.login).toBe("rai@example.com");
    expect(detail.locals[0]?.repository).toBe("/some/repo/.git"); // NOT "repo"
    expect(detail.locals[0]?.author).toBe("rai@example.com");

    const gitNothing = makeGit({ "/x": { branches: { main: 1 } } });
    const empty = await loadProjectDetail(depsWith(gitNothing, ["/x"]), repoProject("/x"));
    expect(empty.viewer.login).toBe("you");
    expect(empty.locals).toEqual([]);
  });

  it("is resilient to a non-git root (no throw, empty locals)", async () => {
    const git = makeGit({}); // every call returns ""
    const detail = await loadProjectDetail(
      depsWith(git, ["/not/a/repo"]),
      repoProject("/not/a/repo"),
    );
    expect(detail).toEqual({
      viewer: { login: "you" },
      locals: [],
      prs: [],
      truncated: false,
    });
  });

  it("keeps a branch name reused across repos distinct via the composite key", async () => {
    const git = makeGit({
      "/a": {
        remoteUrl: "git@github.com:acme/a.git",
        userName: "rai",
        branches: { main: 1000, "feat/shared": 2000 },
        aheadBehind: { "feat/shared": { ahead: 1, behind: 0 } },
      },
      "/b": {
        remoteUrl: "git@github.com:acme/b.git",
        userName: "rai",
        branches: { main: 1000, "feat/shared": 3000 },
        aheadBehind: { "feat/shared": { ahead: 5, behind: 0 } },
      },
    });

    const workspaceProject: Project = { ...repoProject("/ws"), kind: "workspace" };
    const detail = await loadProjectDetail(depsWith(git, ["/a", "/b"]), workspaceProject);

    const shared = detail.locals.filter((l) => l.branch === "feat/shared");
    expect(shared).toHaveLength(2);
    expect(shared.map((l) => l.repository).sort()).toEqual(["acme/a", "acme/b"]);
  });

  it("skips a detached worktree (no branch → no local-work row)", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1000 },
        worktrees: [
          { path: "/repo", branch: "main" },
          { path: "/wt/detached" }, // no branch
        ],
      },
    });
    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));
    expect(detail.locals).toEqual([]); // main excluded, detached skipped
  });
});

describe("loadProjectDetail — live remote PRs (B2)", () => {
  const depsWithPr = (
    git: GitExec,
    roots: readonly string[],
    prSource: ProjectPrSource,
  ): ProjectDetailSourceDeps => ({ git, prSource, resolveRepoRoots: () => Promise.resolve(roots) });

  it("wires live PRs and pins the viewer + local author to the GitHub login", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "Rai Butera", // git identity — must be OVERRIDDEN by the GitHub login
        branches: { main: 1000, "feat/y": 2000 },
        worktrees: [{ path: "/repo", branch: "main" }],
        aheadBehind: { "feat/y": { ahead: 1, behind: 0 } },
      },
    });
    const prSource: ProjectPrSource = {
      resolveViewer: async () => "octocat",
      listOpenPullRequests: async (repository) => ({
        prs: [pr({ repository, reviewRequestedFromViewer: true })],
        truncated: false,
      }),
    };

    const detail = await loadProjectDetail(
      depsWithPr(git, ["/repo"], prSource),
      repoProject("/repo"),
    );

    expect(detail.viewer.login).toBe("octocat"); // GitHub login pins ownership, not "Rai Butera"
    expect(detail.locals[0]?.author).toBe("octocat"); // local work reads as the same viewer
    expect(detail.prs).toHaveLength(1);
    expect(detail.prs[0]?.repository).toBe("acme/widget");
    expect(() => projectDetailSchema.parse(detail)).not.toThrow();
  });

  it("emits matching repository identities so a local worktree folds into its PR row", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1000, "feat/x": 2000 },
        worktrees: [
          { path: "/repo", branch: "main" },
          { path: "/wt/x", branch: "feat/x" },
        ],
        aheadBehind: { "feat/x": { ahead: 2, behind: 0 } },
      },
    });
    const prSource: ProjectPrSource = {
      resolveViewer: async () => "octocat",
      listOpenPullRequests: async (repository) => ({
        prs: [pr({ repository, branch: "feat/x" })],
        truncated: false,
      }),
    };

    const detail = await loadProjectDetail(
      depsWithPr(git, ["/repo"], prSource),
      repoProject("/repo"),
    );
    const local = detail.locals.find((l) => l.branch === "feat/x");
    // Byte-identical (repository, branch) on both halves — the smart-list dedupe key.
    expect(local?.repository).toBe(detail.prs[0]?.repository);
    expect(local?.branch).toBe(detail.prs[0]?.branch);
  });

  it("propagates truncated from the PR source", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1 },
      },
    });
    const prSource: ProjectPrSource = {
      resolveViewer: async () => "octocat",
      listOpenPullRequests: async () => ({ prs: [], truncated: true }),
    };
    const detail = await loadProjectDetail(
      depsWithPr(git, ["/repo"], prSource),
      repoProject("/repo"),
    );
    expect(detail.truncated).toBe(true);
  });

  it("keeps the git identity when the GitHub viewer is null", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "Rai Butera",
        branches: { main: 1 },
      },
    });
    const prSource: ProjectPrSource = {
      resolveViewer: async () => null,
      listOpenPullRequests: async () => ({ prs: [], truncated: false }),
    };
    const detail = await loadProjectDetail(
      depsWithPr(git, ["/repo"], prSource),
      repoProject("/repo"),
    );
    expect(detail.viewer.login).toBe("Rai Butera");
  });

  it("does NOT fetch PRs for a local-only repo (no forge identity)", async () => {
    const git = makeGit({
      "/some/repo": { commonDir: "/some/repo/.git", userName: "rai", branches: { main: 1 } },
    });
    const listOpenPullRequests = vi.fn(async () => ({ prs: [], truncated: false }));
    const resolveViewer = vi.fn(async () => "octocat");
    const detail = await loadProjectDetail(
      depsWithPr(git, ["/some/repo"], { resolveViewer, listOpenPullRequests }),
      repoProject("/some/repo"),
    );
    expect(listOpenPullRequests).not.toHaveBeenCalled();
    expect(resolveViewer).not.toHaveBeenCalled(); // no forge repo → no GitHub round-trip at all
    expect(detail.prs).toEqual([]);
  });

  it("without a prSource, prs stays empty (B1 local-only surface preserved)", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1, "feat/z": 2 },
        aheadBehind: { "feat/z": { ahead: 1, behind: 0 } },
      },
    });
    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));
    expect(detail.prs).toEqual([]);
    expect(detail.truncated).toBe(false);
  });
});

describe("defaultProjectDetailSourceDeps.resolveRepoRoots", () => {
  it("honours the stored included-repo selection and never re-discovers", async () => {
    // A throwing git proves discovery is NOT consulted when the selection is stored.
    const throwingGit: GitExec = async () => {
      throw new Error("discovery must not run when the selection is persisted");
    };
    const deps = defaultProjectDetailSourceDeps(throwingGit);
    const project: Project = {
      ...repoProject("/ws"),
      kind: "workspace",
      includedRepoPaths: ["/ws/a", "/ws/b"], // "/ws/excluded" deliberately absent
    };
    await expect(deps.resolveRepoRoots(project)).resolves.toEqual(["/ws/a", "/ws/b"]);
  });

  it("returns the open path for a repo-kind project", async () => {
    const deps = defaultProjectDetailSourceDeps(makeGit({}));
    await expect(deps.resolveRepoRoots(repoProject("/solo"))).resolves.toEqual(["/solo"]);
  });
});

describe("loadProjectDetail — the post-establishment outage (bounded, honest)", () => {
  const depsFor = (
    git: GitExec,
    roots: readonly string[],
    prSource: ProjectPrSource,
  ): ProjectDetailSourceDeps => ({ git, prSource, resolveRepoRoots: () => Promise.resolve(roots) });

  const netError = () =>
    Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });

  it("a network failure in the live PR load degrades to local-only with the honest hint", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1, "feat/z": 2 },
        aheadBehind: { "feat/z": { ahead: 1, behind: 0 } },
      },
    });
    const prSource: ProjectPrSource = {
      resolveViewer: async () => "octocat",
      listOpenPullRequests: () => Promise.reject(netError()),
    };
    const detail = await loadProjectDetail(depsFor(git, ["/repo"], prSource), repoProject("/repo"));
    expect(detail.authUnavailable).toBe("network");
    expect(detail.prs).toEqual([]);
    expect(detail.truncated).toBe(false);
    // The local half survives the outage.
    expect(detail.locals.length).toBeGreaterThan(0);
  });

  it("a NON-network failure still throws — a broken response never fakes an empty list", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "rai",
        branches: { main: 1 },
      },
    });
    const prSource: ProjectPrSource = {
      resolveViewer: async () => "octocat",
      listOpenPullRequests: () => Promise.reject(new Error("GraphQL schema drift")),
    };
    await expect(
      loadProjectDetail(depsFor(git, ["/repo"], prSource), repoProject("/repo")),
    ).rejects.toThrow("GraphQL schema drift");
  });

  it("caps the per-repo PR fan-out at 4 in flight (each request carries a 15s worst case)", async () => {
    const roots = Array.from({ length: 8 }, (_, i) => `/r${i}`);
    const fixtures = Object.fromEntries(
      roots.map((root, i) => [
        root,
        { remoteUrl: `git@github.com:acme/repo${i}.git`, userName: "rai", branches: { main: 1 } },
      ]),
    );
    const git = makeGit(fixtures);
    let inFlight = 0;
    let maxInFlight = 0;
    const prSource: ProjectPrSource = {
      resolveViewer: async () => "octocat",
      listOpenPullRequests: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return { prs: [], truncated: false };
      },
    };
    await loadProjectDetail(depsFor(git, roots, prSource), repoProject("/r0"));
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});
