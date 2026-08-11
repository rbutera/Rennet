import type { Project } from "@rennet/protocol";
import { projectDetailSchema } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { GitExec } from "./git-range-diff";
import { loadProjectDetail, type ProjectDetailSourceDeps } from "./project-detail-source";

/** ISO-Z instant for a unix-seconds time, mirroring the source's own conversion. */
const iso = (unix: number): string => new Date(unix * 1000).toISOString();

/** A single repo root's canned git responses. */
interface RepoFixture {
  remoteUrl?: string;
  userName?: string;
  userEmail?: string;
  /** branch short name → committer time (unix seconds). */
  branches: Record<string, number>;
  /** raw `git worktree list --porcelain` output. */
  worktreeList: string;
  /** branch → ahead/behind vs the primary branch. */
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
      case "for-each-ref":
        return `${Object.entries(repo.branches)
          .map(([name, unix]) => `${name}\t${unix}`)
          .join("\n")}\n`;
      case "worktree":
        return repo.worktreeList;
      case "rev-list": {
        const spec = args[args.length - 1] ?? "";
        const branch = spec.split("...")[1] ?? "";
        const ab = repo.aheadBehind?.[branch] ?? { ahead: 0, behind: 0 };
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

const twoWorktrees = `worktree /repo
HEAD aaaaaaa
branch refs/heads/main

worktree /wt/x
HEAD bbbbbbb
branch refs/heads/feat/x

`;

describe("loadProjectDetail — live local work (B1)", () => {
  it("maps worktrees + branches to LocalWork, excluding the primary branch", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "git@github.com:acme/widget.git",
        userName: "Rai Butera",
        branches: { main: 1000, "feat/x": 2000, "feat/y": 1500 },
        worktreeList: twoWorktrees,
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
        worktreeList: twoWorktrees,
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

  it("produces output that validates against projectDetailSchema (ISO-Z timestamps)", async () => {
    const git = makeGit({
      "/repo": {
        remoteUrl: "https://github.com/acme/widget",
        userName: "rai",
        branches: { main: 1000, "feat/x": 2000 },
        worktreeList: twoWorktrees,
        aheadBehind: { "feat/x": { ahead: 1, behind: 0 } },
      },
    });

    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));
    expect(() => projectDetailSchema.parse(detail)).not.toThrow();
    // The fixture set is gone from the local-work path: no fixture ids, no seeded PRs.
    expect(detail.locals.every((l) => !l.id.startsWith("local-"))).toBe(true);
    expect(detail.prs).toEqual([]);
  });

  it("falls back to the repo basename and to user.email / 'you' for identity", async () => {
    const gitEmail = makeGit({
      "/some/repo": {
        userEmail: "rai@example.com", // no user.name, no remote
        branches: { main: 1000, "feat/z": 2000 },
        worktreeList: "",
        aheadBehind: { "feat/z": { ahead: 2, behind: 0 } },
      },
    });
    const detail = await loadProjectDetail(
      depsWith(gitEmail, ["/some/repo"]),
      repoProject("/some/repo"),
    );
    expect(detail.viewer.login).toBe("rai@example.com");
    expect(detail.locals[0]?.repository).toBe("repo"); // basename fallback
    expect(detail.locals[0]?.author).toBe("rai@example.com");

    const gitNothing = makeGit({
      "/x": { branches: { main: 1 }, worktreeList: "" },
    });
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
        worktreeList: "",
        aheadBehind: { "feat/shared": { ahead: 1, behind: 0 } },
      },
      "/b": {
        remoteUrl: "git@github.com:acme/b.git",
        userName: "rai",
        branches: { main: 1000, "feat/shared": 3000 },
        worktreeList: "",
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
        worktreeList: `worktree /repo
HEAD aaaaaaa
branch refs/heads/main

worktree /wt/detached
HEAD bbbbbbb
detached

`,
      },
    });
    const detail = await loadProjectDetail(depsWith(git, ["/repo"]), repoProject("/repo"));
    expect(detail.locals).toEqual([]); // main excluded, detached skipped
  });
});
