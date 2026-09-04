import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapePath, HOST_LOCUS } from "@rennet/core";
import type { Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BoundWorkspaceDeps,
  decideBoundWorkspace,
  inRepoSpelling,
  repinBoundWorkspace,
} from "./bound-workspace";

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
      locusOf: () => HOST_LOCUS,
      repoKeyForRoot: (repoRoot) => escapePath(repoRoot),
      dataDir,
      prWorktreeFor: (reviewId) => prIndex.get(reviewId),
      recordPrWorktree: (reviewId, path) => void prIndex.set(reviewId, path),
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

  it("returns the repository's OWN spelling when the checkout on the branch is the repository", async () => {
    // `git worktree list` prints a realpath, and on WSL the UNC form it maps back to is
    // `\\\\wsl.localhost\\…` while the project may be opened as `\\\\wsl$\\…`. Either would make
    // `boundRoot` differ from `review.repositoryRoot` by SPELLING ALONE — which reads
    // downstream as "this session moved to a worktree" and retires every thread row the
    // repository has. Here the fixture's own symlinked name stands in for that pair.
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    const viaSymlink = join(root, "repo-link");
    symlinkSync(repo, viaSymlink);
    const review = reviewFor({
      id: "r11",
      repositoryRoot: viaSymlink,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    // Verbatim: the string the review carries, not git's resolved one.
    expect(await decideBoundWorkspace(review, deps)).toBe(viaSymlink);
    expect(createdWorktrees()).toEqual([]);
  });

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
    // The per-PULL-REQUEST path, never `worktrees/review/<id>`: that layout is the one the
    // startup sweep now retires, and re-creating it would make that half of the sweep a
    // no-op forever.
    expect(bound).toBe(join(dataDir, "worktrees", "o", "n", "pr-7"));
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
    // A retrospective review carries no post target, so there is no pull-request path to
    // name and nothing to create; it binds to the repository, where its pinned reads resolve.
    expect(await decideBoundWorkspace(review, deps)).toBe(repo);
    expect(createdWorktrees()).toEqual([]);
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

  it("RE-PINS a pull-request binding when the reviewed head has moved", async () => {
    // A landed round advances the reviewed head. The binding is a DETACHED checkout at the
    // old one, so without a re-pin every generation after the first drafts from the previous
    // patchset's bytes while the bench names the new one.
    const repo = initRepo(root, "repo");
    const firstHead = headOid(repo, "feature");
    const review = reviewFor({
      id: "r8",
      repositoryRoot: repo,
      headOid: firstHead,
      baseOid: headOid(repo, "main"),
      pullRequest: true,
    });
    const bound = await decideBoundWorkspace(review, deps);
    expect(git(bound, ["rev-parse", "HEAD"]).trim()).toBe(firstHead);

    // The branch moves, exactly as a round's commits move it.
    git(repo, ["checkout", "-q", "feature"]);
    writeFileSync(join(repo, "round.txt"), "round one\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "round one"]);
    git(repo, ["checkout", "-q", "main"]);
    const movedHead = headOid(repo, "feature");
    expect(movedHead).not.toBe(firstHead);

    const advanced = reviewFor({
      id: "r8",
      repositoryRoot: repo,
      headOid: movedHead,
      baseOid: headOid(repo, "main"),
      pullRequest: true,
    });
    // The SAME path — a re-pin, not a re-decision — now holding the new head.
    expect(await repinBoundWorkspace(advanced, bound, deps)).toBe(bound);
    expect(git(bound, ["rev-parse", "HEAD"]).trim()).toBe(movedHead);
    expect(existsSync(join(bound, "round.txt"))).toBe(true);
  });

  it("leaves a branch binding alone: its worktree has the branch out and follows the ref", async () => {
    const repo = initRepo(root, "repo");
    const review = reviewFor({
      id: "r9",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const bound = await decideBoundWorkspace(review, deps);
    gitCalls = [];
    expect(await repinBoundWorkspace(review, bound, deps)).toBe(bound);
    expect(gitCalls).toEqual([]);
  });

  it("THROWS rather than binding the session to the clone when a worktree cannot be made", async () => {
    // The clone sits on `main`. Recording it as the binding would run every later turn of a
    // `feature` review against `main` — silently, under the right label, for the session's
    // whole life. The caller records nothing on a throw, so the next use retries.
    const repo = initRepo(root, "repo");
    const review = reviewFor({
      id: "r10",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    // `worktree add` cannot create a directory under a path that is a FILE.
    const blocked = join(dataDir, "worktrees", escapePath(repo));
    mkdirSync(join(blocked, ".."), { recursive: true });
    writeFileSync(blocked, "not a directory\n");
    await expect(decideBoundWorkspace(review, deps)).rejects.toThrow();
  });
});

describe("inRepoSpelling — git's answer in the daemon's spelling (task 5.2, PR #789)", () => {
  const wsl = { kind: "wsl", distro: "Ubuntu" } as const;

  it("re-spells a distro path into the UNC view a Windows-host daemon addresses the repo by", () => {
    // The daemon runs on Windows and holds `\\wsl$\Ubuntu\home\u\repo`; the git it drives
    // lives INSIDE the distro and answers `/home/u/repo`. Stored raw, that path makes
    // `existsSync` refuse every thread, `detectLocus` read the workspace as the HOST, and the
    // context writer mkdir `C:\home\u\...`.
    expect(inRepoSpelling("/home/u/repo", "\\\\wsl$\\Ubuntu\\home\\u\\repo", wsl)).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo",
    );
  });

  it("leaves git's answer alone when the daemon runs INSIDE the distro", () => {
    // Same locus, different arrangement: the daemon addresses the repository distro-natively,
    // so git's spelling already IS the daemon's and re-spelling would invent a UNC path
    // nothing uses.
    expect(inRepoSpelling("/home/u/repo", "/home/u/repo", wsl)).toBe("/home/u/repo");
  });

  it("leaves a host-locus path alone", () => {
    expect(inRepoSpelling("/Users/rai/repo", "/Users/rai/repo", HOST_LOCUS)).toBe(
      "/Users/rai/repo",
    );
  });
});
