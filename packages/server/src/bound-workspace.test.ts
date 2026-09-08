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
import { basename, join } from "node:path";
import { defaultWorktreePlacement } from "@rennet/adapters";
import { escapePath, HOST_LOCUS } from "@rennet/core";
import type { Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BoundWorkspaceDeps,
  decideBoundWorkspace,
  inRepoSpelling,
  type ResolvedWorktreePlacement,
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
/** What the binding's `worktreeFacts` answers this test, and which repositories it was
 *  asked about — the tokens `{owner}`/`{name}` come from here at the bind and from the
 *  SAME function at the settings preview. */
let facts: { owner?: string; remoteName?: string } = {};
let factsAsked: string[] = [];

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
  /** What the settings ladder resolves for every repository this test asks about — the
   *  BUILTIN placement unless a test writes another. Group 1 proved the ladder; this is the
   *  binding reading whatever it resolved. */
  let placement: ResolvedWorktreePlacement;
  let placementAsked: string[];

  /** The bound ROOT, for the assertions that are only about where a session landed. */
  const bindRoot = async (review: Review): Promise<string> =>
    (await decideBoundWorkspace(review, deps)).boundRoot;

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
    facts = {};
    factsAsked = [];
    placement = { ...defaultWorktreePlacement(dataDir), workspace: "share" };
    placementAsked = [];
    deps = {
      gitFor: () => gitExec,
      locusOf: () => HOST_LOCUS,
      repoKeyForRoot: (repoRoot) => escapePath(repoRoot),
      placementFor: async (repoRoot) => {
        placementAsked.push(repoRoot);
        return placement;
      },
      // No remote resolves by default: the fixtures have none, so `{owner}` falls back to
      // `local` and `{name}` to the folder's basename, exactly as a local-only clone does.
      worktreeFacts: async (repoRoot) => {
        factsAsked.push(repoRoot);
        return facts;
      },
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
    expect(await bindRoot(review)).toBe(viaSymlink);
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
    expect(await bindRoot(review)).toBe(repo);
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
    const bound = await bindRoot(review);
    expect(bound).toBe(join(dataDir, "worktrees", escapePath(repo), "feature"));
    expect(createdWorktrees()).toEqual([bound]);
    expect(created).toEqual([bound]);
    // CHECKED OUT, not detached: a round commits on the session's branch here, which a
    // detached head cannot do. `rev-parse --abbrev-ref HEAD` reads `HEAD` when detached.
    expect(git(bound, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature");
    // Bound once: the second ask returns the same path and creates nothing more.
    created = [];
    expect(await bindRoot(review)).toBe(bound);
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
    const bound = await bindRoot(review);
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
    expect(await bindRoot(review)).toBe(repo);
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
    expect(await bindRoot(review)).toBe(existing);
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
    expect(await bindRoot(review)).toBe(repo);
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

    const alphaBound = await bindRoot(alphaReview);
    const betaBound = await bindRoot(betaReview);

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
    expect(await bindRoot(review)).toBe(theirs);
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
    const bound = await bindRoot(review);
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
    const bound = await bindRoot(review);
    gitCalls = [];
    expect(await repinBoundWorkspace(review, bound, deps)).toBe(bound);
    expect(gitCalls).toEqual([]);
  });

  it("fills `{owner}` and `{name}` at the BIND from the repository the review named", async () => {
    // The bug: `PLACEHOLDERS` blessed `{owner}` for a branch pattern while this call site
    // supplied `{repo,name,branch}` and no owner at all, so a stored `{owner}/{branch}`
    // previewed fine and threw the moment a session bound. The facts now come from the
    // same function the settings preview reads, asked by REPOSITORY ROOT.
    const repo = initRepo(root, "repo");
    facts = { owner: "acme", remoteName: "orbital" };
    const review = reviewFor({
      id: "r11",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const bound = await bindRoot(review);
    // The builtin pattern is `{repo}/{branch}`, so the owner does not appear in the path —
    // what this pins is that the bind ASKED, by the repository the review names, and that
    // the placement it produced is the builtin's.
    expect(factsAsked).toEqual([repo]);
    expect(bound).toBe(join(dataDir, "worktrees", escapePath(repo), "feature"));
  });

  it("places a PR snapshot under the REMOTE's name, not the clone folder's", async () => {
    // Cloning a forge repository into a folder called `widget-local`. `{name}` means the
    // REMOTE's repository name, never the folder's, so the snapshot goes under the forge
    // identity — here `o/n`, which is what the review's own `postTarget` carries, and the
    // folder name appears nowhere in the path.
    //
    // NOT the same path as `settings.test.ts`'s "previews the PR snapshot under the
    // REMOTE's name": that test is a different fixture (`acme`/`widget`, pull request 1,
    // resolved from `worktreeFacts`) and asserts `acme/widget/pr-1`. What the two SHARE is
    // the rule — `{name}` is the remote's name — and the bug they were written for, where
    // the preview spelled the folder (`acme/widget-local/pr-1`) and the bind spelled the
    // remote. Each pins its own half; neither reproduces the other's path.
    const repo = initRepo(root, "widget-local");
    const review = reviewFor({
      id: "r12",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      baseOid: headOid(repo, "main"),
      pullRequest: true,
    });
    const bound = await bindRoot(review);
    expect(bound).toBe(join(dataDir, "worktrees", "o", "n", "pr-7"));
    expect(basename(repo)).toBe("widget-local");
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
    await expect(bindRoot(review)).rejects.toThrow();
  });

  // ── `workspace: own`: the sibling arm (D4) ────────────────────────────────────────────
  //
  // The arrangement is the ONE git refuses: the reviewer's checkout already has the branch
  // out, so `worktree add <path> feature` fails. Under `share` Rennet binds to that
  // checkout; under `own` it takes a worktree of its own on `rennet/feature`.

  /** Every byte of a checkout that must not move: HEAD, the index, the tracked files. */
  function checkoutFingerprint(repo: string): string {
    return [
      git(repo, ["rev-parse", "HEAD"]).trim(),
      git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      git(repo, ["status", "--porcelain=v1", "-z"]),
      git(repo, ["ls-files", "-s", "-z"]),
    ].join("|");
  }

  it("binds `own` to a NEW worktree on `rennet/<branch>` and leaves the checkout untouched", async () => {
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    const before = checkoutFingerprint(repo);
    placement = { ...placement, workspace: "own" };
    const review = reviewFor({
      id: "own-1",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });

    const bound = await decideBoundWorkspace(review, deps);

    // A worktree of Rennet's own, at the SIBLING's own placement — the branch pattern
    // applied to `rennet/feature`, never to `feature`. The first draft put it at the
    // branch's path, which is where a Rennet BRANCH worktree of the same repository lives.
    expect(bound.boundRoot).toBe(join(dataDir, "worktrees", escapePath(repo), "rennet", "feature"));
    expect(bound.workBranch).toBe("rennet/feature");
    expect(git(bound.boundRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(
      "rennet/feature",
    );
    // Forked from the branch's head — the same commit, not a fresh root.
    expect(git(repo, ["rev-parse", "refs/heads/rennet/feature"]).trim()).toBe(
      headOid(repo, "feature"),
    );
    expect(created).toEqual([bound.boundRoot]);
    // …and the reviewer's checkout is byte-for-byte where it was. This is the whole promise
    // of `own`: it is not "Rennet tries not to disturb you", it is "nothing in your tree
    // moved". A `checkout`/`reset` in the wrong directory reddens exactly here.
    expect(checkoutFingerprint(repo)).toBe(before);
    // Executed, not reasoned: the reviewed branch's own ref did not move either.
    expect(headOid(repo, "feature")).toBe(review.patchsets[0]?.repository.headOid);
  });

  it("binds the SAME fixture to the checkout under `share`, creating nothing", async () => {
    // The control for the test above: identical repository, identical review, one setting
    // different. If the sibling arm ran unconditionally this reddens.
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    const review = reviewFor({
      id: "share-1",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });

    const bound = await decideBoundWorkspace(review, deps);

    expect(bound.boundRoot).toBe(repo);
    expect(bound.workBranch).toBeUndefined();
    expect(createdWorktrees()).toEqual([]);
    expect(attemptedWorktreeAdd()).toBe(false);
    // No sibling branch was created either — under `share` the name does not exist.
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feature"])).toThrow();
  });

  it("binds a SECOND session to the existing sibling AS IT IS — no reset, no checkout", async () => {
    // THE REVIEW FINDING. Sessions share a sibling exactly as they share a checkout: one
    // sibling worktree per (repository, branch). The first draft re-forked on every bind,
    // so a second session's bind ran `reset --hard` over whatever the first one had in its
    // tree and index. Nothing here is destructive, and the edit below proves it.
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    placement = { ...placement, workspace: "own" };
    const review = reviewFor({
      id: "own-2",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const first = await decideBoundWorkspace(review, deps);
    // A round's uncommitted work in the shared sibling, plus a commit of its own.
    writeFileSync(join(first.boundRoot, "round.txt"), "round\n");
    git(first.boundRoot, ["add", "."]);
    git(first.boundRoot, ["commit", "-q", "-m", "round one"]);
    const tip = git(repo, ["rev-parse", "refs/heads/rennet/feature"]).trim();
    writeFileSync(join(first.boundRoot, "feature.txt"), "half-written\n");
    // …and the reviewer moves their own branch on, so the sibling is now BEHIND `feature`
    // as well as ahead of it. Neither fact licenses a reset.
    writeFileSync(join(repo, "theirs.txt"), "theirs\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "theirs"]);

    const second = await decideBoundWorkspace(review, deps);

    expect(second.boundRoot).toBe(first.boundRoot);
    expect(second.workBranch).toBe("rennet/feature");
    // The sibling's tip did not move, the commit is still there, and the half-written file
    // is still half-written. A `reset --hard` reddens on every one of these.
    expect(git(repo, ["rev-parse", "refs/heads/rennet/feature"]).trim()).toBe(tip);
    expect(existsSync(join(first.boundRoot, "round.txt"))).toBe(true);
    expect(git(first.boundRoot, ["status", "--porcelain=v1"])).toBe(" M feature.txt\n");
    // Executed, not reasoned: no reset and no checkout was issued at all this bind.
    expect(gitCalls.some((argv) => argv[0] === "reset")).toBe(false);
    expect(gitCalls.some((argv) => argv[0] === "checkout")).toBe(false);
  });

  it("re-forks a sibling BRANCH whose worktree is gone and whose commits are reachable", async () => {
    // The one re-fork D5 leaves: no worktree, and the branch already holds everything the
    // sibling does — so a fresh session starts from the branch's CURRENT head rather than
    // from where a removed worktree left it. Nothing that exists nowhere else is discarded.
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    placement = { ...placement, workspace: "own" };
    const review = reviewFor({
      id: "own-refork",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const first = await decideBoundWorkspace(review, deps);
    git(repo, ["worktree", "remove", first.boundRoot]);
    // The branch moves on; the orphaned sibling branch holds nothing it does not.
    writeFileSync(join(repo, "theirs.txt"), "theirs\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "theirs"]);
    const advanced = headOid(repo, "feature");

    const second = await decideBoundWorkspace(review, deps);

    expect(second.boundRoot).toBe(first.boundRoot);
    expect(git(repo, ["rev-parse", "refs/heads/rennet/feature"]).trim()).toBe(advanced);
  });

  it("KEEPS an orphaned sibling BRANCH that is ahead, checking it out where it stands", async () => {
    // The control for the re-fork above: the sibling holds a commit `feature` does not, so
    // those commits exist on no other ref and deleting the branch would lose them.
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    placement = { ...placement, workspace: "own" };
    const review = reviewFor({
      id: "own-ahead",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const first = await decideBoundWorkspace(review, deps);
    writeFileSync(join(first.boundRoot, "round.txt"), "round\n");
    git(first.boundRoot, ["add", "."]);
    git(first.boundRoot, ["commit", "-q", "-m", "round one"]);
    const ahead = git(repo, ["rev-parse", "refs/heads/rennet/feature"]).trim();
    git(repo, ["worktree", "remove", "--force", first.boundRoot]);

    const second = await decideBoundWorkspace(review, deps);

    expect(second.boundRoot).toBe(first.boundRoot);
    expect(git(repo, ["rev-parse", "refs/heads/rennet/feature"]).trim()).toBe(ahead);
    expect(existsSync(join(second.boundRoot, "round.txt"))).toBe(true);
  });

  it("THROWS rather than working inside a worktree at the sibling's path that is not the sibling", async () => {
    // A foreign worktree — the reviewer's own second checkout, here on `main` — sits exactly
    // where the sibling would go. Checking out in it is the destructive act the first draft
    // performed; the honest answer is a refusal that names the path and the ref, with the
    // directory untouched.
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    placement = { ...placement, workspace: "own" };
    const squatter = join(dataDir, "worktrees", escapePath(repo), "rennet", "feature");
    git(repo, ["worktree", "add", "-b", "theirs", squatter, "refs/heads/main"]);
    const before = checkoutFingerprint(squatter);
    const review = reviewFor({
      id: "own-squat",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });

    await expect(decideBoundWorkspace(review, deps)).rejects.toThrow(/already a worktree/);

    // Untouched: same HEAD, same branch, same index, same tree — and no sibling branch was
    // created either, so nothing was half-done before the refusal.
    expect(checkoutFingerprint(squatter)).toBe(before);
    expect(git(squatter, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("theirs");
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feature"])).toThrow();
  });

  it("binds to RENNET'S OWN branch worktree under `own`, exactly as `share` would", async () => {
    // Nothing had `feature` out when the first session bound, so Rennet placed a worktree ON
    // the branch. A second session under `own` finds "some worktree already has the branch
    // out" — but it is Rennet's, not the reviewer's, so there is no tree to work beside and
    // taking a sibling would fork a second workspace away from the one the first session is
    // committing in. The first draft switched that worktree onto the sibling underneath it.
    const repo = initRepo(root, "repo"); // the checkout stays on `main`
    placement = { ...placement, workspace: "own" };
    const review = reviewFor({
      id: "own-rennet",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const first = await decideBoundWorkspace(review, deps);
    expect(git(first.boundRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature");

    const second = await decideBoundWorkspace(review, deps);

    expect(second).toEqual({ boundRoot: first.boundRoot });
    // Still on the branch, and no sibling branch was ever created.
    expect(git(first.boundRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature");
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feature"])).toThrow();
  });

  it("THROWS when the resolved placement lands the sibling ON the reviewer's checkout", async () => {
    // A pattern with no `{branch}` token computes ONE path for every branch — and with the
    // root set to the fixture directory, that path IS the reviewer's repository. Rennet must
    // not decide that a checkout it did not place is its own, and must not check anything
    // out inside it. (`{name}` with no remote resolving falls back to the folder basename.)
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    placement = { ...placement, root, pattern: "{name}", workspace: "own" };
    const before = checkoutFingerprint(repo);
    const review = reviewFor({
      id: "own-onto-checkout",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });

    await expect(decideBoundWorkspace(review, deps)).rejects.toThrow(/already a worktree/);

    expect(checkoutFingerprint(repo)).toBe(before);
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feature"])).toThrow();
    expect(gitCalls.some((argv) => argv[0] === "reset")).toBe(false);
  });

  it("records the DAEMON's spelling of an existing sibling, never GIT's", async () => {
    // THE REVIEW FINDING (B1). `git worktree list` prints paths in the spelling of the git
    // that answered — which on a Windows daemon driving a WSL repository is `/home/u/…`
    // while the daemon addresses that very directory as `\\wsl$\…`. The `share` arm below
    // already normalises; the sibling arm returned git's answer verbatim, so the recorded
    // `boundRoot` was a string the daemon cannot `existsSync`, cannot detect a locus for,
    // and cannot match against its own worktree root. Downstream that reads as "this
    // session moved to another workspace".
    //
    // The two spellings here are a real directory and a symlinked alias for it: one
    // directory, two names, which is the whole shape of the failure.
    const repo = initRepo(root, "repo");
    git(repo, ["checkout", "-q", "feature"]);
    placement = { ...placement, workspace: "own" };
    const review = reviewFor({
      id: "own-spelling",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const first = await decideBoundWorkspace(review, deps);
    const real = join(dataDir, "worktrees");
    const alias = join(root, "worktrees-alias");
    symlinkSync(real, alias);
    const gitSpelling = first.boundRoot.replace(real, alias);
    expect(gitSpelling).not.toBe(first.boundRoot);
    // A git that answers in the OTHER spelling, exactly as the distro's git would.
    deps = {
      ...deps,
      gitFor: () => async (cwd: string, args: string[], options?: { reject?: boolean }) => {
        const out = await gitExec(cwd, args, options);
        return args[0] === "worktree" && args[1] === "list" ? out.split(real).join(alias) : out;
      },
    };

    const second = await decideBoundWorkspace(review, deps);

    // The computed placement — the name Rennet already owns for this directory — and not
    // the one git printed. Returning `sibling.path` raw reddens on the first assertion.
    expect(second.boundRoot).toBe(first.boundRoot);
    expect(second.boundRoot).not.toBe(gitSpelling);
    expect(second.workBranch).toBe("rennet/feature");
    // …and it is one directory, which is why re-spelling it is safe rather than a guess.
    expect(realpathSync(gitSpelling)).toBe(realpathSync(second.boundRoot));
  });

  it("binds `own` to the branch itself when NOTHING has it out — there is no conflict to avoid", async () => {
    const repo = initRepo(root, "repo"); // the checkout is on `main`
    placement = { ...placement, workspace: "own" };
    const review = reviewFor({
      id: "own-3",
      repositoryRoot: repo,
      headOid: headOid(repo, "feature"),
      headRef: "feature",
      baseOid: headOid(repo, "main"),
    });
    const bound = await decideBoundWorkspace(review, deps);
    expect(git(bound.boundRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature");
    expect(bound.workBranch).toBeUndefined();
  });

  // ── The fixture this change is not done without (task 2.8) ────────────────────────────
  it("gives each repo of a two-repo workspace its OWN arm when both are on `feat/x`", async () => {
    // ONE workspace project, TWO repositories, BOTH on `feat/x`, BOTH with that branch
    // checked out in the reviewer's own worktree. One repository resolves `own`, the other
    // `share`. A binding that answered from the project — or from the branch name — would
    // hand one session the other repository's tree, silently, under the right label.
    const alpha = initRepo(root, "alpha");
    const beta = initRepo(root, "beta");
    for (const repo of [alpha, beta]) {
      git(repo, ["checkout", "-q", "-b", "feat/x", "feature"]);
    }
    const modes: Record<string, ResolvedWorktreePlacement["workspace"]> = {
      [alpha]: "own",
      [beta]: "share",
    };
    deps = {
      ...deps,
      placementFor: async (repoRoot) => {
        placementAsked.push(repoRoot);
        return { ...placement, workspace: modes[repoRoot] ?? "share" };
      },
    };
    const reviewFo = (id: string, repo: string): Review =>
      reviewFor({
        id,
        repositoryRoot: repo,
        headOid: headOid(repo, "feat/x"),
        headRef: "feat/x",
        baseOid: headOid(repo, "main"),
      });

    const alphaBound = await decideBoundWorkspace(reviewFo("ws-a", alpha), deps);
    const betaBound = await decideBoundWorkspace(reviewFo("ws-b", beta), deps);

    // Alpha took a sibling of its own; beta bound to its own checkout.
    expect(alphaBound.workBranch).toBe("rennet/feat/x");
    expect(alphaBound.boundRoot).toBe(
      join(dataDir, "worktrees", escapePath(alpha), "rennet", "feat", "x"),
    );
    expect(betaBound).toEqual({ boundRoot: beta });

    // Each bound root is under ITS OWN repository, and neither is under the other's. This is
    // the pair the swap below reddens: give the two rows each other's `repositoryRoot` and
    // alpha's session binds under beta's key while beta's binds to alpha's checkout.
    expect(git(alphaBound.boundRoot, ["rev-parse", "HEAD"]).trim()).toBe(headOid(alpha, "feat/x"));
    expect(alphaBound.boundRoot.includes(escapePath(alpha))).toBe(true);
    expect(alphaBound.boundRoot.includes(escapePath(beta))).toBe(false);
    expect(betaBound.boundRoot).toBe(beta);
    expect(betaBound.boundRoot.startsWith(alpha)).toBe(false);
    // The settings were resolved PER REPOSITORY, by that repository's own root.
    expect(placementAsked).toEqual([alpha, beta]);
    // And alpha's sibling is alpha's: beta's `feat/x` head is a different commit entirely.
    expect(git(alpha, ["rev-parse", "refs/heads/rennet/feat/x"]).trim()).not.toBe(
      headOid(beta, "feat/x"),
    );
    expect(() => git(beta, ["rev-parse", "--verify", "refs/heads/rennet/feat/x"])).toThrow();
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
