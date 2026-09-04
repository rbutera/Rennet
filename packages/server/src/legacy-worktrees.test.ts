import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepLegacyWorktrees } from "./legacy-worktrees";

// Real worktrees of a real repository, because the thing the sweep has to get right is git
// state: removing the directory alone leaves an admin entry that makes a later `worktree add`
// on the same path refuse. `git worktree list` is what proves it went.

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

const gitExec = async (cwd: string, args: string[], options?: { reject?: boolean }) => {
  try {
    return git(cwd, args);
  } catch (error) {
    if (options?.reject === false) return "";
    throw error;
  }
};

describe("sweepLegacyWorktrees (session-bound-workspace 5.5)", () => {
  let root: string;
  let dataDir: string;
  let repo: string;
  let logs: string[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rennet-legacy-wt-")));
    dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "repo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    logs = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const addWorktree = (path: string): string => {
    mkdirSync(join(path, ".."), { recursive: true });
    git(repo, ["worktree", "add", "-q", "--detach", path]);
    return path;
  };

  const sweep = (boundRoots: readonly string[]) =>
    sweepLegacyWorktrees({
      dataDir,
      boundRoots,
      gitFor: () => gitExec,
      log: (m) => void logs.push(m),
    });

  const listedWorktrees = (): string[] =>
    git(repo, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));

  it("removes a legacy round worktree and a legacy review worktree, and reports the count", async () => {
    const round = addWorktree(join(dataDir, "round-worktrees", "abc123"));
    const review = addWorktree(join(dataDir, "worktrees", "review", "review-1"));

    expect(await sweep([])).toBe(2);
    expect(existsSync(round)).toBe(false);
    expect(existsSync(review)).toBe(false);
    // The git admin entries went with them: a directory removed without `worktree remove`
    // leaves a registration that makes the path unusable forever after.
    expect(listedWorktrees()).toEqual([repo]);
    expect(logs).toEqual(["rennet: removed 2 retired round/review worktrees"]);
  });

  it("leaves a worktree a live session is bound to, and says nothing", async () => {
    // The same directory shape, under the same parent, distinguished ONLY by a live
    // session's recorded `boundRoot`. This is the case that makes the sweep safe to run at
    // every start rather than once: a PR-snapshot session's binding IS a review worktree.
    const bound = addWorktree(join(dataDir, "worktrees", "review", "review-live"));
    const orphan = addWorktree(join(dataDir, "worktrees", "review", "review-dead"));

    expect(await sweep([bound])).toBe(1);
    expect(existsSync(bound)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(listedWorktrees().sort()).toEqual([repo, bound].sort());
    expect(logs).toEqual(["rennet: removed 1 retired round/review worktree"]);
  });

  it("does nothing, and logs nothing, when neither directory exists", async () => {
    expect(await sweep([])).toBe(0);
    expect(logs).toEqual([]);
  });

  it("removes a directory whose repository is gone rather than leaving the zoo alive", async () => {
    // A worktree whose `.git` link points nowhere: git cannot speak for it, so the sweep
    // falls through to the filesystem removal instead of skipping it forever.
    const stranded = join(dataDir, "round-worktrees", "stranded");
    mkdirSync(stranded, { recursive: true });
    writeFileSync(join(stranded, ".git"), "gitdir: /nowhere/that/exists\n");
    expect(await sweep([])).toBe(1);
    expect(existsSync(stranded)).toBe(false);
  });
});
