import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import type { Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoundWorkspaceDeps, decideBoundWorkspace } from "./bound-workspace";

// Real git repositories, because every interesting answer here comes from git: which worktree
// already has a branch out, whether `worktree add` will accept a path, whether a detached
// checkout landed on the reviewed OID. A stubbed git would let the module say anything.

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

/** Every git argv the module issued this test, so a control-flow claim can be executed. */
let gitCalls: string[][] = [];

const gitExec = async (cwd: string, args: string[], options?: { reject?: boolean }) => {
  gitCalls.push([...args]);
  try {
    return git(cwd, args);
  } catch (error) {
    if (options?.reject === false) return "";
    throw error;
  }
};

const attemptedWorktreeAdd = (): boolean =>
  gitCalls.some((argv) => argv[0] === "worktree" && argv[1] === "add");

/** A repo on `main` with one commit, plus a `feature` branch carrying a second. */
function initRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), `${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "feature.txt"), `${name} feature\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "feature"]);
  git(dir, ["checkout", "-q", "main"]);
  return dir;
}

function headOid(repo: string, ref: string): string {
  return git(repo, ["rev-parse", ref]).trim();
}

function reviewFor(input: {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly headOid: string;
  readonly headRef?: string;
  readonly baseOid: string;
  readonly pullRequest?: boolean;
  readonly retrospective?: boolean;
}): Review {
  const patchset = {
    id: "patchset-1",
    repository: {
      id: "repo-1",
      root: input.repositoryRoot,
      commonDir: join(input.repositoryRoot, ".git"),
      baseRef: "main",
      baseOid: input.baseOid,
      headOid: input.headOid,
      ...(input.headRef === undefined ? {} : { headRef: input.headRef }),
    },
  };
  return {
    id: input.id,
    repositoryRoot: input.repositoryRoot,
    activePatchsetId: patchset.id,
    patchsets: [patchset],
    ...(input.retrospective === true ? { retrospective: true } : {}),
    ...(input.pullRequest === true
      ? { postTarget: { repo: { forge: "github", owner: "o", name: "n" }, number: 7 } }
      : {}),
  } as unknown as Review;
}

describe("decideBoundWorkspace (session-bound-workspace D1)", () => {
  let root: string;
  let dataDir: string;
  let prIndex: Map<string, string>;
  let created: string[];
  let deps: BoundWorkspaceDeps;

  beforeEach(() => {
    // realpath: on macOS `/var` is a symlink to `/private/var`, and `git worktree list`
    // reports the resolved path — so an unresolved fixture root compares unequal to a real
    // binding for reasons that have nothing to do with the binding.
    root = realpathSync(mkdtempSync(join(tmpdir(), "rennet-bind-")));
    dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    prIndex = new Map();
    created = [];
    gitCalls = [];
    deps = {
      gitFor: () => gitExec,
      repoKeyForRoot: (repoRoot) => escapePath(repoRoot),
      dataDir,
      prWorktreeFor: (reviewId) => prIndex.get(reviewId),
      recordPrWorktree: (reviewId, path) => void prIndex.set(reviewId, path),
      reviewWorktreePath: (reviewId) => join(dataDir, "worktrees", "review", reviewId),
      onWorktreeCreated: (path) => void created.push(path),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Every worktree directory Rennet created under the data dir, as a flat list of leaves. */
  function createdWorktrees(): string[] {
    const base = join(dataDir, "worktrees");
    const walk = (dir: string): string[] => {
      let entries: readonly string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return [];
      }
      return entries.flatMap((entry) => {
        const child = join(dir, entry);
        return existsSync(join(child, ".git")) ? [child] : walk(child);
      });
    };
    return walk(base);
  }

  it("binds a branch review to the checkout that is already on the branch, creating nothing", async () => {
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    const review = reviewFor({
      id: "r1",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    expect(await decideBoundWorkspace(review, deps)).toBe(repo);
    expect(createdWorktrees()).toEqual([]);
    expect(created).toEqual([]);
    // Executed, not reasoned: NO `worktree add` was attempted. Without this the test passes
    // for the wrong reason — drop the "who has this branch out" lookup and the module tries
    // to add a worktree for a branch that is already checked out, git refuses, and the
    // degrade path returns this very same repository root (control run 2026-09-04).
    expect(attemptedWorktreeAdd()).toBe(false);
  });

  it("binds a branch review of another branch to a worktree it creates ON that branch", async () => {
    const repo = initRepo(root, "repo"); // checkout is on `main`
    const review = reviewFor({
      id: "r2",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const bound = await decideBoundWorkspace(review, deps);
    expect(bound).toBe(join(dataDir, "worktrees", escapePath(repo), "feature"));
    expect(createdWorktrees()).toEqual([bound]);
    expect(created).toEqual([bound]);
    // CHECKED OUT, not detached: a round commits on the session's branch here, which a
    // detached head cannot do. `rev-parse --abbrev-ref HEAD` reads `HEAD` when detached.
    expect(git(bound, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature");
    // Bound once: the second ask returns the same path and creates nothing more.
    created = [];
    expect(await decideBoundWorkspace(review, deps)).toBe(bound);
    expect(created).toEqual([]);
  });

  it("binds a pull-request snapshot to a detached worktree at the reviewed head, and records it", async () => {
    const repo = initRepo(root, "repo");
    const head = headOid(repo, "feature");
    const review = reviewFor({
      id: "r3",
      repositoryRoot: repo,
      headOid: head,
      // A PR's head branch may not exist locally at all, and this one is checked out
      // nowhere: if the PR arm were skipped, the branch arm would create a `feature`
      // worktree instead and this assertion would name it.
      headRef: "feature",
      baseOid: headOid(repo, "main"),
      pullRequest: true,
    });
    const bound = await decideBoundWorkspace(review, deps);
    expect(bound).toBe(join(dataDir, "worktrees", "review", "r3"));
    expect(prIndex.get("r3")).toBe(bound);
    expect(git(bound, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(git(bound, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD"); // detached
  });

  it("binds a retrospective pull-request review the same way — it carries no postTarget", async () => {
    const repo = initRepo(root, "repo");
    const review = reviewFor({
      id: "r4",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
      retrospective: true,
    });
    expect(await decideBoundWorkspace(review, deps)).toBe(
      join(dataDir, "worktrees", "review", "r4"),
    );
  });

  it("reuses a pull-request worktree the index already names, rather than a second checkout", async () => {
    const repo = initRepo(root, "repo");
    const existing = join(dataDir, "worktrees", "o", "n", "pr-7");
    prIndex.set("r5", existing);
    const review = reviewFor({
      id: "r5",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      baseOid: headOid(repo, "main"),
      pullRequest: true,
    });
    expect(await decideBoundWorkspace(review, deps)).toBe(existing);
    expect(createdWorktrees()).toEqual([existing]);
  });

  it("binds a detached-HEAD branch review to the repository root: there is no branch to bind", async () => {
    const repo = initRepo(root, "repo");
    const review = reviewFor({
      id: "r6",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      baseOid: headOid(repo, "main"),
    });
    expect(await decideBoundWorkspace(review, deps)).toBe(repo);
    expect(createdWorktrees()).toEqual([]);
  });

  // The fixture that makes the workspace bug visible at all: ONE project, TWO repositories,
  // BOTH with a `feature` branch. A single-repo fixture passes honestly and sees none of it.
  it("binds each repo of a two-repo workspace to ITS OWN tree when both share a branch name", async () => {
    const alpha = initRepo(root, "alpha");
    const beta = initRepo(root, "beta");
    // Alpha's checkout sits on `feature`; beta's sits on `main`. Same branch NAME, two repos.
    git(alpha, ["checkout", "-q", "feature"]);

    const alphaReview = reviewFor({
      id: "ra",
      repositoryRoot: alpha,
      headOid: headOid(alpha, "feature"),
      headRef: "feature",
      baseOid: headOid(alpha, "main"),
    });
    const betaReview = reviewFor({
      id: "rb",
      repositoryRoot: beta,
      headOid: headOid(beta, "feature"),
      headRef: "feature",
      baseOid: headOid(beta, "main"),
    });

    const alphaBound = await decideBoundWorkspace(alphaReview, deps);
    const betaBound = await decideBoundWorkspace(betaReview, deps);

    expect(alphaBound).toBe(alpha);
    expect(betaBound).toBe(join(dataDir, "worktrees", escapePath(beta), "feature"));
    // The load-bearing pair: neither binding names the OTHER repository's tree. A resolution
    // that answered from the project — or from the branch name alone — would hand beta's
    // session alpha's checkout, silently, with the right branch on the label.
    expect(betaBound.startsWith(alpha)).toBe(false);
    expect(alphaBound.startsWith(beta)).toBe(false);
    // And beta's worktree really is beta's: its `feature` commit is beta's, not alpha's.
    expect(git(betaBound, ["rev-parse", "HEAD"]).trim()).toBe(headOid(beta, "feature"));
  });

  it("binds to the reviewer's OTHER worktree when that is what has the branch out", async () => {
    // git refuses `worktree add` for a branch checked out elsewhere, so binding blind here
    // would throw and degrade to the repository root — the wrong tree, silently.
    const repo = initRepo(root, "repo");
    const theirs = join(root, "their-feature-worktree");
    git(repo, ["worktree", "add", "-q", theirs, "feature"]);
    const review = reviewFor({
      id: "r7",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    expect(await decideBoundWorkspace(review, deps)).toBe(theirs);
    expect(createdWorktrees()).toEqual([]);
    expect(attemptedWorktreeAdd()).toBe(false);
  });
});
