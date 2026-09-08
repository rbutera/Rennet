import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSiblingWorktree } from "@rennet/adapters";
import type { ForgePrSubmissionPort } from "@rennet/core";
import { HOST_LOCUS } from "@rennet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLandedBranchPatchset, createRoundWorkspacePlanner } from "./create-server";
import {
  type ForgePrSubmissionResolver,
  type ResolvedForgePullRequestDestination,
  submitForgePullRequest,
} from "./forge-submission";
import { landWorkBranch } from "./land-work-branch";
import { createForgeRegistry } from "./project-forge-registry";
import { collectSibling, orphanedSiblings } from "./sibling-cleanup";
import { readWorkBranchState } from "./work-branch-state";

// What `workspace: own` costs and what it buys, driven against REAL git repositories.
//
// Every claim in D4/D5 is a claim about what git did — where a commit is, which ref moved,
// what a refusal said. A stubbed runner would let this file assert any of them, so nothing
// here is stubbed except the forge PROVIDER (there is no GitHub to open a pull request on);
// the push itself goes to a real bare remote over a real `git push`, and the assertions read
// that remote's refs back.

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

function oid(repo: string, ref: string): string {
  return git(repo, ["rev-parse", ref]).trim();
}

function commit(dir: string, name: string, body: string): string {
  writeFileSync(join(dir, name), body);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", name]);
  return oid(dir, "HEAD");
}

let root: string;
let repo: string;
let worktrees: string;

/** A repository on `main`, with `feat/x` CHECKED OUT — the arrangement `own` exists for. */
beforeEach(() => {
  // realpath: `/var` is a symlink to `/private/var` on macOS and `git worktree list` prints
  // the resolved path, so an unresolved fixture root compares unequal for no real reason.
  root = realpathSync(mkdtempSync(join(tmpdir(), "rennet-work-branch-")));
  repo = join(root, "repo");
  worktrees = join(root, "worktrees");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  commit(repo, "README.md", "repo\n");
  git(repo, ["checkout", "-q", "-b", "feat/x"]);
  commit(repo, "feature.txt", "feature\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Rennet's own worktree on `rennet/feat/x`, at the SIBLING's own placement — the branch
 *  pattern applied to `rennet/feat/x`, which is where the bind puts it. */
async function bindSibling(): Promise<string> {
  const path = join(worktrees, "rennet", "feat", "x");
  const { path: bound } = await ensureSiblingWorktree(gitExec, repo, path, "feat/x");
  return bound;
}

describe("the round's WORKSPACE under `own` (review finding W1)", () => {
  // THE DEFECT, DRIVEN THROUGH THE PLANNER. `createRoundWorkspacePlanner` matched a
  // candidate root by `sourceTarget.branch` — the REVIEWED branch — while the session's
  // bound root is a sibling worktree on `rennet/feat/x`. The sibling therefore failed the
  // match, the search fell through to the review's own repository root, and the round's
  // worker committed on `feat/x` IN THE REVIEWER'S CHECKOUT. Every promise `own` makes was
  // broken by one comparison, silently, under the right label.
  //
  // Driven through the planner and not through `captureLandedBranchPatchset`, because the
  // capture was never wrong: it was handed the wrong root.

  /** The planner as `create-server` composes it, over REAL git in this fixture. */
  function planner(input: {
    boundRoot?: string;
    workBranch?: string;
    /** The fallback list, when the case is about the SEARCH rather than about a binding. */
    candidates?: readonly string[];
  }) {
    const readGit = async (root: string, args: readonly string[]): Promise<string | undefined> => {
      try {
        const out = (await gitExec(root, [...args], { reject: false })).trim();
        return out.length === 0 ? undefined : out;
      } catch {
        return undefined;
      }
    };
    return createRoundWorkspacePlanner({
      ...(input.boundRoot === undefined ? {} : { boundRoot: () => input.boundRoot }),
      ...(input.workBranch === undefined ? {} : { workBranch: () => input.workBranch }),
      // Both roots are offered, in the order `create-server` offers them: the session's
      // binding first, the review's repository second. A case that is about the SEARCH
      // says which roots are on offer, because a session with no binding still has a
      // sibling worktree in the list `create-server` builds — dropping it there is what
      // made the control below unfalsifiable.
      candidateRoots: () =>
        input.candidates !== undefined
          ? [...input.candidates]
          : [input.boundRoot, repo].filter((v): v is string => v !== undefined),
      reviewedHead: () => oid(repo, "refs/heads/feat/x"),
      headOf: (root) => readGit(root, ["rev-parse", "HEAD"]),
      branchOf: (root) => readGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      repositoryOf: async (root) => {
        const dir = await readGit(root, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        return dir === undefined ? undefined : realpathSync(dir);
      },
      containsCommit: async (root, sha) => {
        try {
          await gitExec(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  /** A round on `feat/x` — the branch the REVIEW is about, which is what the target names. */
  const operation = {
    sessionId: "s1",
    repoRoot: repo,
    sourceTarget: { kind: "branch", branch: "feat/x" },
  };

  it("plans the SIBLING, and the reviewer's checkout gains no commit and no change", async () => {
    const sibling = await bindSibling();
    const checkoutHead = oid(repo, "HEAD");
    // The reviewer is mid-edit in their own tree, which a round has no business touching.
    writeFileSync(join(repo, "mine.txt"), "mine\n");

    const plan = await planner({ boundRoot: sibling, workBranch: "rennet/feat/x" })({
      ...operation,
      repoRoot: repo,
    } as never);

    expect(plan.kind).toBe("bound-root");
    expect(plan.root).toBe(sibling);
    expect(plan.sourceHead).toBe(oid(sibling, "HEAD"));
    // The round's turn commits in the planned root. Where that lands is the whole finding.
    commit(plan.root, "round.txt", "the round's work\n");
    expect(oid(repo, "HEAD")).toBe(checkoutHead);
    expect(oid(repo, "refs/heads/feat/x")).toBe(checkoutHead);
    expect(existsSync(join(repo, "round.txt"))).toBe(false);
    expect(git(repo, ["status", "--porcelain=v1"]).trim()).toBe("?? mine.txt");
  });

  it("POSITIVE CONTROL: matching by the SOURCE TARGET plans the reviewer's tree", async () => {
    // The planner as it was: no work branch, no bound root — so `feat/x` is matched, the
    // sibling (on `rennet/feat/x`) is skipped, and the search reaches the reviewer's
    // checkout. This is the exact composition the finding describes.
    //
    // THE SIBLING IS OFFERED FIRST, and it is offered EXPLICITLY. The earlier version of
    // this control let the helper derive the candidate list from `boundRoot`, which it did
    // not pass — so the list was `[repo]`, the sibling was never a candidate at all, and
    // the assertion below held under any matching rule whatsoever, including no rule. A
    // control that cannot fail is not a control. Now the sibling is first in line and the
    // BRANCH MATCH is the only thing that skips it: delete that comparison in
    // `createRoundWorkspacePlanner` and this plans the sibling instead.
    const sibling = await bindSibling();

    const plan = await planner({ candidates: [sibling, repo] })({
      ...operation,
      repoRoot: repo,
    } as never);

    expect(plan.root).toBe(repo);
    expect(plan.root).not.toBe(sibling);
  });

  it("THROWS naming the workspace when a bound root is not on the work branch", async () => {
    // A bound session does not fall through. The binding IS the workspace, so a bound root
    // that is not on the work branch is a fact to report — the reviewer checked something
    // else out — never a licence to go and commit in another tree.
    const sibling = await bindSibling();
    git(sibling, ["checkout", "-q", "--detach"]);

    await expect(
      planner({ boundRoot: sibling, workBranch: "rennet/feat/x" })({
        ...operation,
        repoRoot: repo,
      } as never),
    ).rejects.toThrow(new RegExp(`${sibling.replaceAll(".", "\\.")} is not on it`));
  });
});

describe("the round under `own` (workspace-settings D4, task 2.3)", () => {
  it("captures a patchset that NAMES the reviewed branch and points at the sibling's tip", async () => {
    const sibling = await bindSibling();
    const baseOid = oid(repo, "refs/heads/main");
    const branchBefore = oid(repo, "refs/heads/feat/x");

    // The round's turn commits in the bound root, which has the sibling checked out. The
    // worker never learns that: it commits on HEAD, exactly as it does under `share`.
    const roundCommit = commit(sibling, "round.txt", "the round's work\n");

    const patchset = await captureLandedBranchPatchset({
      git: gitExec,
      locus: HOST_LOCUS,
      repoPath: sibling,
      // The reviewed branch's NAME — what the review and the pull request are about.
      headRef: "feat/x",
      baseRef: "main",
      // …and the sibling's tip, which is where `operation.state.commits.to` points.
      headOid: roundCommit,
      baseOid,
      resolveProjectSnapshotId: async () => "snapshot-1",
    });

    expect(patchset.repository.headRef).toBe("feat/x");
    expect(patchset.repository.headOid).toBe(roundCommit);
    // The commit is on the SIBLING and on nothing else. Asked of git as a reachability
    // question, not inferred from the oids: `branch --contains` is the whole claim.
    const containing = git(repo, ["branch", "--format=%(refname)", "--contains", roundCommit])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(containing).toEqual(["refs/heads/rennet/feat/x"]);
    // …and the reviewed branch's own ref has not moved.
    expect(oid(repo, "refs/heads/feat/x")).toBe(branchBefore);
  });
});

describe("the push under `own` (task 2.4)", () => {
  const SUBMISSION = {
    title: "The round's work",
    body: "opened from a sibling",
    base: "main",
    head: "feat/x",
    draft: false,
  };
  const DESTINATION = {
    remoteName: "origin",
    target: { repo: { forge: "github", owner: "acme", name: "widget" } },
  } satisfies ResolvedForgePullRequestDestination;

  /** A real bare remote, wired as `origin`, with `feat/x` already on it. */
  function remote(): string {
    const bare = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "origin", "refs/heads/feat/x:refs/heads/feat/x"]);
    return bare;
  }

  function registry() {
    const submit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>(async () => ({
      number: 7,
      url: "https://github.com/acme/widget/pull/7",
      reused: false,
    }));
    return {
      submit,
      forges: createForgeRegistry<ForgePrSubmissionResolver>([
        { forge: "github", implementation: () => ({ submitPullRequest: submit }) },
      ]),
    };
  }

  it("sends the SIBLING's tip to the reviewed branch's name, and the local branch stays put", async () => {
    const bare = remote();
    const sibling = await bindSibling();
    const roundCommit = commit(sibling, "round.txt", "the round's work\n");
    const localBefore = oid(repo, "refs/heads/feat/x");
    expect(localBefore).not.toBe(roundCommit);
    const { forges } = registry();

    await submitForgePullRequest({
      registry: forges,
      git: gitExec,
      repoRoot: repo,
      headRef: "feat/x",
      workBranch: "rennet/feat/x",
      submission: SUBMISSION,
      destination: DESTINATION,
    });

    // The REMOTE's `feat/x` is now the sibling's tip — the pull request's head is `feat/x`,
    // which is the whole point of pushing the sibling under the branch's name.
    expect(oid(bare, "refs/heads/feat/x")).toBe(roundCommit);
    // …and the reviewer's local branch has not moved. This is the pair `own` promises.
    expect(oid(repo, "refs/heads/feat/x")).toBe(localBefore);
    // The remote holds no `rennet/*` ref: the sibling is a local working detail.
    expect(() => git(bare, ["rev-parse", "--verify", "refs/heads/rennet/feat/x"])).toThrow();
  });

  it("pushes the BYTE-IDENTICAL refspec under `share` — no work branch, no change", async () => {
    // The literal, spelled out: this is the refspec the previous release pushed, and a
    // reviewer under `share` must not be able to tell this change happened.
    const { forges } = registry();
    const calls: string[][] = [];
    const recording = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };

    await submitForgePullRequest({
      registry: forges,
      git: recording,
      repoRoot: repo,
      headRef: "feat/x",
      submission: SUBMISSION,
      destination: DESTINATION,
    });

    expect(calls).toEqual([["push", "origin", "refs/heads/feat/x:refs/heads/feat/x"]]);
  });
});

describe("session.landWorkBranch (task 2.5)", () => {
  it("fast-forwards the reviewer's checkout, and touches nothing else in it", async () => {
    const sibling = await bindSibling();
    const roundCommit = commit(sibling, "round.txt", "the round's work\n");
    // An untracked file the reviewer left lying about: a fast-forward does not disturb it,
    // and git does not refuse over it either.
    writeFileSync(join(repo, "scratch.txt"), "mine\n");
    const indexBefore = git(repo, ["ls-files", "-s", "-z"]);

    const outcome = await landWorkBranch({
      git: gitExec,
      repoRoot: repo,
      locus: HOST_LOCUS,
      branch: "feat/x",
      workBranch: "rennet/feat/x",
    });

    expect(outcome).toEqual({
      status: "landed",
      branch: "feat/x",
      workBranch: "rennet/feat/x",
      headOid: roundCommit,
    });
    expect(oid(repo, "refs/heads/feat/x")).toBe(roundCommit);
    // The round's file arrived; the reviewer's own untracked file is still there.
    expect(existsSync(join(repo, "round.txt"))).toBe(true);
    expect(existsSync(join(repo, "scratch.txt"))).toBe(true);
    // The index changed by exactly the round's file and nothing else.
    expect(git(repo, ["ls-files", "-s", "-z"])).not.toBe(indexBefore);
    expect(git(repo, ["status", "--porcelain=v1"]).trim()).toBe("?? scratch.txt");
    // A fast-forward, never a merge: one parent all the way down.
    expect(git(repo, ["rev-list", "--merges", "main..feat/x"]).trim()).toBe("");
  });

  it("returns GIT'S refusal verbatim over a dirty tree, and changes nothing", async () => {
    const sibling = await bindSibling();
    // The sibling rewrites a file the reviewer has uncommitted edits in — the arrangement
    // git refuses. (A dirty file the merge does not touch is NOT refused, and Rennet does
    // not invent a refusal git would not have made.)
    commit(sibling, "feature.txt", "the round's version\n");
    writeFileSync(join(repo, "feature.txt"), "mine, uncommitted\n");
    const before = oid(repo, "refs/heads/feat/x");

    const outcome = await landWorkBranch({
      git: gitExec,
      repoRoot: repo,
      locus: HOST_LOCUS,
      branch: "feat/x",
      workBranch: "rennet/feat/x",
    });

    expect(outcome.status).toBe("refused");
    // GIT'S words, not Rennet's: this is the sentence the reviewer is shown.
    if (outcome.status !== "refused") throw new Error("expected a refusal");
    expect(outcome.reason).toContain("local changes");
    expect(outcome.reason).toContain("feature.txt");
    expect(outcome.branch).toBe("feat/x");
    // Nothing moved and nothing was overwritten.
    expect(oid(repo, "refs/heads/feat/x")).toBe(before);
    expect(git(repo, ["show", ":feature.txt"])).toBe("feature\n");
    // NOT trimmed: the leading space is porcelain's "unstaged" column, and trimming it
    // away turns "modified in the worktree only" into an assertion that cannot tell the
    // difference from "staged".
    expect(git(repo, ["status", "--porcelain=v1"])).toBe(" M feature.txt\n");
  });

  it("returns GIT'S refusal over a DIVERGED branch, and writes no merge commit", async () => {
    const sibling = await bindSibling();
    commit(sibling, "round.txt", "the round's work\n");
    // The reviewer committed on their own branch meanwhile: the sibling is no longer an
    // ancestor, so a fast-forward is impossible. Rennet does not merge or rebase for them.
    const diverged = commit(repo, "theirs.txt", "mine\n");

    const outcome = await landWorkBranch({
      git: gitExec,
      repoRoot: repo,
      locus: HOST_LOCUS,
      branch: "feat/x",
      workBranch: "rennet/feat/x",
    });

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("expected a refusal");
    expect(outcome.reason).toContain("fast-forward");
    expect(oid(repo, "refs/heads/feat/x")).toBe(diverged);
    // No merge commit anywhere on the branch — the refusal really did nothing.
    expect(git(repo, ["rev-list", "--merges", "main..feat/x"]).trim()).toBe("");
    expect(git(repo, ["status", "--porcelain=v1"]).trim()).toBe("");
  });

  it("says there is nothing to land when the work is on the reviewed branch itself", async () => {
    const outcome = await landWorkBranch({
      git: gitExec,
      repoRoot: repo,
      locus: HOST_LOCUS,
      branch: "feat/x",
    });
    expect(outcome).toEqual({
      status: "unavailable",
      reason: "this session's work is on feat/x already",
    });
  });
});

describe("sibling collection (D5, task 2.6)", () => {
  it("removes a MERGED sibling's worktree and its branch", async () => {
    const sibling = await bindSibling();
    // Landed: the branch now contains everything the sibling does.
    commit(sibling, "round.txt", "the round's work\n");
    await landWorkBranch({
      git: gitExec,
      repoRoot: repo,
      locus: HOST_LOCUS,
      branch: "feat/x",
      workBranch: "rennet/feat/x",
    });

    const collection = await collectSibling({
      git: gitExec,
      repoRoot: repo,
      siblingBranch: "rennet/feat/x",
      branch: "feat/x",
    });

    expect(collection.worktreeRemoved).toBe(true);
    expect(collection.branchDeleted).toBe(true);
    expect(existsSync(sibling)).toBe(false);
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feat/x"])).toThrow();
  });

  it("removes a sibling THE PRODUCTION PUSH sent out — no `-u`, no fetch, no upstream", async () => {
    // THE REVIEW FINDING. `siblingIsCollectable` used to ask `<branch>@{upstream}`, which
    // reads the CONFIGURED upstream — and `submitForgePullRequest` pushes an explicit
    // refspec with no `-u`, deliberately, so no upstream is ever configured. The rule
    // answered false forever, and the old version of this test only passed because it had
    // manufactured a `-u` push and a `git fetch` of its own that production never runs.
    //
    // So nothing here manufactures anything: the push is the PRODUCTION one, through
    // `submitForgePullRequest`, and what makes the sibling collectable is the
    // remote-tracking ref that push updates by itself.
    const bare = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "origin", "refs/heads/feat/x:refs/heads/feat/x"]);
    const sibling = await bindSibling();
    const roundCommit = commit(sibling, "round.txt", "the round's work\n");
    const submit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>(async () => ({
      number: 7,
      url: "https://github.com/acme/widget/pull/7",
      reused: false,
    }));

    await submitForgePullRequest({
      registry: createForgeRegistry<ForgePrSubmissionResolver>([
        { forge: "github", implementation: () => ({ submitPullRequest: submit }) },
      ]),
      git: gitExec,
      repoRoot: repo,
      headRef: "feat/x",
      workBranch: "rennet/feat/x",
      submission: {
        title: "The round's work",
        body: "opened from a sibling",
        base: "main",
        head: "feat/x",
        draft: false,
      },
      destination: {
        remoteName: "origin",
        target: { repo: { forge: "github", owner: "acme", name: "widget" } },
      },
    });

    // No upstream was configured — the thing the old rule depended on genuinely is not there.
    expect(() => git(repo, ["rev-parse", "--symbolic-full-name", "feat/x@{upstream}"])).toThrow();
    // What IS there is the remote-tracking ref the push updated, and it holds the round.
    expect(oid(repo, "refs/remotes/origin/feat/x")).toBe(roundCommit);
    // …while the reviewer's LOCAL branch is still behind, so the local ref alone would say
    // the sibling is unmerged. D5 asks both, which is the whole point.
    expect(oid(repo, "refs/heads/feat/x")).not.toBe(roundCommit);

    const collection = await collectSibling({
      git: gitExec,
      repoRoot: repo,
      siblingBranch: "rennet/feat/x",
      branch: "feat/x",
      // Where the push actually went, as the session recorded it.
      push: { remote: "origin" },
    });

    expect(collection.branchDeleted).toBe(true);
    expect(existsSync(sibling)).toBe(false);
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feat/x"])).toThrow();
  });

  it("consults EVERY remote-tracking ref when no push destination is recorded (the sweep)", async () => {
    // The sweep has no session to ask where a push went, so "some remote has these commits"
    // is the reachability question it can answer. A repository with a second remote that
    // does NOT have them must not decide it either way.
    const bare = join(root, "remote.git");
    const other = join(root, "other.git");
    git(root, ["init", "-q", "--bare", bare]);
    git(root, ["init", "-q", "--bare", other]);
    git(repo, ["remote", "add", "upstream", other]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "upstream", "refs/heads/feat/x:refs/heads/feat/x"]);
    const sibling = await bindSibling();
    const roundCommit = commit(sibling, "round.txt", "the round's work\n");
    git(repo, ["push", "-q", "origin", "refs/heads/rennet/feat/x:refs/heads/feat/x"]);
    expect(oid(repo, "refs/remotes/origin/feat/x")).toBe(roundCommit);
    expect(oid(repo, "refs/remotes/upstream/feat/x")).not.toBe(roundCommit);

    const collection = await collectSibling({
      git: gitExec,
      repoRoot: repo,
      siblingBranch: "rennet/feat/x",
      branch: "feat/x",
    });

    expect(collection.branchDeleted).toBe(true);
    expect(existsSync(sibling)).toBe(false);
  });

  it("KEEPS a sibling when the RECORDED remote does not have it, though another does", async () => {
    // The control for the pair above, and the reason the recorded destination is consulted
    // alone when there is one: a repository with several remotes must not have a push to
    // one of them answer for a push that went to another.
    const bare = join(root, "remote.git");
    const other = join(root, "other.git");
    git(root, ["init", "-q", "--bare", bare]);
    git(root, ["init", "-q", "--bare", other]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["remote", "add", "upstream", other]);
    const sibling = await bindSibling();
    commit(sibling, "round.txt", "the round's work\n");
    // The commits went to `upstream`; the session recorded `origin`.
    git(repo, ["push", "-q", "upstream", "refs/heads/rennet/feat/x:refs/heads/feat/x"]);
    git(repo, ["push", "-q", "origin", "refs/heads/feat/x:refs/heads/feat/x"]);

    const collection = await collectSibling({
      git: gitExec,
      repoRoot: repo,
      siblingBranch: "rennet/feat/x",
      branch: "feat/x",
      push: { remote: "origin" },
    });

    expect(collection.branchDeleted).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("KEEPS an unpushed sibling — its worktree AND its branch — and says why", async () => {
    const sibling = await bindSibling();
    commit(sibling, "round-1.txt", "one\n");
    const tip = commit(sibling, "round-2.txt", "two\n");

    const collection = await collectSibling({
      git: gitExec,
      repoRoot: repo,
      siblingBranch: "rennet/feat/x",
      branch: "feat/x",
    });

    expect(collection).toEqual({
      worktreeRemoved: false,
      branchDeleted: false,
      reason: "rennet/feat/x holds commits feat/x does not — kept with its worktree",
    });
    // Both survive, and the two commits are still exactly where the round left them.
    expect(existsSync(join(sibling, "round-2.txt"))).toBe(true);
    expect(oid(repo, "refs/heads/rennet/feat/x")).toBe(tip);
    expect(
      git(repo, ["rev-list", "--count", "refs/heads/feat/x..refs/heads/rennet/feat/x"]).trim(),
    ).toBe("2");
  });

  it("is not fooled by a TAG named like the sibling", async () => {
    // `git rev-parse rennet/feat/x` resolves `refs/tags/` before `refs/heads/`. A tag on a
    // merged commit would answer the reachability question for a branch that is two commits
    // ahead — and the collection would then delete unmerged work believing it was safe.
    const sibling = await bindSibling();
    commit(sibling, "round.txt", "the round's work\n");
    git(repo, ["tag", "rennet/feat/x", "refs/heads/feat/x"]);

    const collection = await collectSibling({
      git: gitExec,
      repoRoot: repo,
      siblingBranch: "rennet/feat/x",
      branch: "feat/x",
    });

    expect(collection.branchDeleted).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("sweeps a sibling no live session claims, and skips the one a session is bound to", async () => {
    const sibling = await bindSibling();
    commit(sibling, "round.txt", "the round's work\n");
    // A second sibling, on another branch, that a live session IS bound to.
    git(repo, ["branch", "feat/y", "refs/heads/main"]);
    const other = join(worktrees, "feat", "y");
    await ensureSiblingWorktree(gitExec, repo, other, "feat/y");

    const found = await orphanedSiblings({
      git: gitExec,
      repoRoot: repo,
      under: (path) => path.startsWith(worktrees),
      claimed: (path) => path === other,
    });

    expect(found).toEqual([{ path: sibling, siblingBranch: "rennet/feat/x", branch: "feat/x" }]);
    // The reviewer's own checkout is not in the list either: it is not a `rennet/*` worktree.
    expect(found.some((entry) => entry.path === repo)).toBe(false);
  });
});

describe("session.workBranchState — what the strip is told (review findings S2, S3)", () => {
  /** The read as the daemon composes it, over this fixture's real git. */
  const stateOf = (push?: { remote: string; branch: string }) =>
    readWorkBranchState({
      git: gitExec,
      repoRoot: repo,
      branch: "feat/x",
      workBranch: "rennet/feat/x",
      ...(push === undefined ? {} : { push }),
    });

  it("counts the REMOTE's range for `behindRemote`, not the sibling's", async () => {
    // S2. The strip rendered "`feat/x` is behind `origin/feat/x` by N" out of the SIBLING's
    // count, which is the same number only while nobody else has pushed. Here the sibling
    // holds one commit `feat/x` does not, and `origin/feat/x` holds two — a teammate pushed
    // on top of Rennet's submission — so the two numbers differ and only one of them
    // belongs in that sentence. A fixture where they agreed could not see this at all.
    const sibling = await bindSibling();
    const bare = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "origin", "refs/heads/feat/x:refs/heads/feat/x"]);
    // Rennet's round, and Rennet's push: `refs/remotes/origin/feat/x` now has ONE commit
    // `feat/x` does not, and so does the sibling.
    commit(sibling, "round.txt", "the round's work\n");
    git(repo, ["push", "-q", "origin", "refs/heads/rennet/feat/x:refs/heads/feat/x"]);
    // …and then a teammate pushes a second one, through their own clone of the remote.
    const theirs = join(root, "theirs");
    git(root, ["clone", "-q", "--branch", "feat/x", bare, theirs]);
    commit(theirs, "theirs.txt", "theirs\n");
    git(theirs, ["push", "-q", "origin", "HEAD:refs/heads/feat/x"]);
    git(repo, ["fetch", "-q", "origin"]);

    const state = await stateOf({ remote: "origin", branch: "feat/x" });

    // TWO different numbers, each read from its own range. Rendering `aheadOfBranch` under
    // the remote's sentence — which is what the single `ahead` did — says "by 1" here.
    expect(state.aheadOfBranch).toBe(1);
    expect(state.behindRemote).toBe(2);
    expect(state.pushed).toBe(true);
    expect(state.landed).toBe(false);
    expect(state.remoteRef).toBe("refs/remotes/origin/feat/x");
  });

  it("reports `behindRemote: 0` with no recorded push — nothing has been sent anywhere", async () => {
    const sibling = await bindSibling();
    commit(sibling, "round.txt", "the round's work\n");

    const state = await stateOf();

    expect(state.aheadOfBranch).toBe(1);
    expect(state.behindRemote).toBe(0);
    expect(state.pushed).toBe(false);
    expect(state.remoteRef).toBeUndefined();
  });

  it("calls the work LANDED once the branch CONTAINS it, not only while the tips are equal", async () => {
    // S3. `landed` was `rev-parse <branch> === rev-parse <workBranch>`, which stops holding
    // the moment the reviewer does anything after the fast-forward. Pull one commit, or
    // commit one line, and the strip went back to saying "the round's commits are on
    // `rennet/feat/x`; `feat/x` has not moved" over a branch that was carrying them.
    const sibling = await bindSibling();
    const landed = commit(sibling, "round.txt", "the round's work\n");
    // The reviewer lands it, exactly as the action does…
    git(repo, ["merge", "--ff-only", "refs/heads/rennet/feat/x"]);
    expect(await stateOf().then((state) => state.landed)).toBe(true);
    // …and then carries on working on their branch, which moves its tip past the sibling.
    commit(repo, "after.txt", "after\n");
    expect(oid(repo, "refs/heads/feat/x")).not.toBe(landed);

    const state = await stateOf();

    // The equality test answers FALSE here; ancestry answers what the sentence is about.
    expect(state.landed).toBe(true);
    expect(state.aheadOfBranch).toBe(0);
  });

  it("does NOT call it landed while the sibling holds a commit the branch does not", async () => {
    // The pair that keeps ancestry from being a rubber stamp: the branch is an ancestor of
    // the sibling here, and the question is the other way round.
    const sibling = await bindSibling();
    commit(sibling, "round.txt", "the round's work\n");

    const state = await stateOf();

    expect(state.landed).toBe(false);
    expect(state.aheadOfBranch).toBe(1);
  });
});
