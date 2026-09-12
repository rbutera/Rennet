import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execaGit } from "./git-range-diff";
import { resolvePrimaryBase } from "./primary-base";

// Real git on a cold disk is slow on Windows runners; the sibling git fixtures in
// this package take the same allowance.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const scratch: string[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}

function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

/** An empty repository on `main`, configured to commit without a global identity. */
function repository(): string {
  const root = scratchDirectory("rennet-primary-base-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  return root;
}

/** Whether a ref resolves in this clone — `rev-parse --verify --quiet` exits 1 if not. */
function resolves(root: string, ref: string): boolean {
  try {
    git(root, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

function commit(root: string, path: string, body: string): string {
  writeFileSync(join(root, path), body);
  git(root, "add", path);
  git(root, "commit", "-qm", `add ${path}`);
  return git(root, "rev-parse", "HEAD");
}

/**
 * A clone whose `origin/main` is FRESHER than its local `main`: the sibling commit
 * landed on the remote and was fetched, but nobody pulled. This is the reported
 * shape (fresh-base-patchset) — a lane cut from `origin/main` after a sibling merged.
 */
function staleLocalMain(): { root: string; localTip: string; remoteTip: string } {
  const origin = scratchDirectory("rennet-primary-base-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const root = repository();
  git(root, "remote", "add", "origin", origin);
  const localTip = commit(root, "base.txt", "base\n");
  git(root, "push", "-q", "origin", "main");
  // The sibling's commit lands on the remote, and this clone fetches it without
  // moving its own `main`.
  const sibling = scratchDirectory("rennet-primary-base-sibling-");
  git(sibling, "clone", "-q", origin, sibling);
  git(sibling, "config", "user.email", "sibling@example.test");
  git(sibling, "config", "user.name", "Sibling");
  const remoteTip = commit(sibling, "sibling.txt", "sibling\n");
  git(sibling, "push", "-q", "origin", "main");
  git(root, "fetch", "-q", "origin");
  expect(git(root, "rev-parse", "main")).toBe(localTip);
  expect(git(root, "rev-parse", "origin/main")).toBe(remoteTip);
  return { root, localTip, remoteTip };
}

afterEach(() => {
  for (const directory of scratch.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("resolvePrimaryBase", () => {
  it("picks the remote-tracking ref when the local primary is behind it", async () => {
    const { root, remoteTip } = staleLocalMain();

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main" });

    expect(resolved.baseRef).toBe("origin/main");
    expect(resolved.baseOid).toBeUndefined();
    // The winner names a commit the local spelling does not carry.
    expect(git(root, "rev-parse", "origin/main")).toBe(remoteTip);
  });

  it("picks the local branch when it is the newer spelling", async () => {
    const { root } = staleLocalMain();
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--ff-only", "origin/main");
    const localTip = commit(root, "local.txt", "local\n");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main" });

    expect(resolved.baseRef).toBe("main");
    expect(git(root, "rev-parse", "main")).toBe(localTip);
  });

  it("prefers the remote-tracking ref when the two spellings have diverged", async () => {
    const { root } = staleLocalMain();
    git(root, "checkout", "-q", "main");
    // Local `main` now carries a commit `origin/main` lacks, and vice versa.
    commit(root, "local-only.txt", "local only\n");
    expect(
      (() => {
        try {
          git(root, "merge-base", "--is-ancestor", "main", "origin/main");
          return "ancestor";
        } catch {
          return "diverged";
        }
      })(),
    ).toBe("diverged");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main" });

    expect(resolved.baseRef).toBe("origin/main");
  });

  it("picks the local branch in a repository with no remote", async () => {
    const root = repository();
    commit(root, "base.txt", "base\n");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main" });

    expect(resolved.baseRef).toBe("main");
  });

  it("reports no primary ref when nothing in the clone names the branch", async () => {
    const root = repository();
    commit(root, "base.txt", "base\n");
    git(root, "checkout", "-qb", "feature");
    git(root, "branch", "-D", "main");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main" });

    expect(resolved).toEqual({ baseRef: null });
  });

  it("names the primary from origin/HEAD when the caller has no name", async () => {
    // The primary is `trunk`, a name the `main`/`master` probe can never find, so this
    // answer can only have come from reading `origin/HEAD`. With `main` as the fixture's
    // primary the probe would find it whether or not the symbolic ref was read at all.
    const origin = scratchDirectory("rennet-primary-base-origin-");
    git(origin, "init", "-q", "--bare", "-b", "trunk");
    const root = repository();
    git(root, "branch", "-m", "main", "trunk");
    git(root, "remote", "add", "origin", origin);
    commit(root, "base.txt", "base\n");
    git(root, "push", "-q", "origin", "trunk");
    git(root, "fetch", "-q", "origin");
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(resolves(root, "refs/heads/main")).toBe(false);
    expect(resolves(root, "refs/remotes/origin/main")).toBe(false);

    expect((await resolvePrimaryBase(execaGit, root)).baseRef).toBe("origin/trunk");
  });

  it("probes main then master when there is no origin/HEAD", async () => {
    // `master` answers for a clone that never had a `main` — the pair is tried in order.
    const legacy = repository();
    commit(legacy, "base.txt", "base\n");
    git(legacy, "branch", "-m", "main", "master");

    expect((await resolvePrimaryBase(execaGit, legacy)).baseRef).toBe("master");
  });

  it("falls through to main/master when origin/HEAD points at a branch that is gone", async () => {
    // `symbolic-ref --short` prints a DANGLING target and exits 0, so `origin/HEAD` can
    // name a branch no ref resolves — the shape a clone is left in when the primary
    // branch is renamed on the forge. Answering `master` here would end the probe at a
    // name with no candidates, and the caller would lose a base it can plainly see.
    const { root } = staleLocalMain();
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    expect(git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/master");
    expect(resolves(root, "refs/remotes/origin/master")).toBe(false);

    const resolved = await resolvePrimaryBase(execaGit, root);

    expect(resolved.baseRef).toBe("origin/main");
  });

  it("answers no ref for a caller name of HEAD, which names no branch", async () => {
    // The live caller passes `project?.primaryBranch ?? "HEAD"`. Taken as a name it
    // would build `refs/remotes/origin/HEAD`, which resolves in any ordinary clone, and
    // the base would become origin's default tip instead of the caller's own fallback.
    const { root } = staleLocalMain();
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "HEAD" });

    expect(resolved).toEqual({ baseRef: null });
  });

  it("reports the winner's own tip beside the merge-base", async () => {
    // The row measures against the tip OID, not the short name: a TAG named `origin/main`
    // outranks the remote-tracking ref when git re-resolves that short name.
    const { root, localTip, remoteTip } = staleLocalMain();
    git(root, "checkout", "-qb", "feat/cut-early", localTip);
    const head = commit(root, "early.txt", "early\n");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main", head });

    expect(resolved.baseTipOid).toBe(remoteTip);
    expect(resolved.baseOid).toBe(localTip);
  });

  it("bases a branch cut from the fresher spelling at that spelling's tip", async () => {
    const { root, localTip, remoteTip } = staleLocalMain();
    git(root, "checkout", "-qb", "feat/cut-from-origin", "origin/main");
    const head = commit(root, "feature.txt", "feature\n");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main", head });

    expect(resolved.baseRef).toBe("origin/main");
    expect(resolved.baseOid).toBe(remoteTip);
    expect(resolved.baseOid).not.toBe(localTip);
    // The range the base opens carries the branch's own commit and nothing else.
    expect(git(root, "diff", "--name-only", `${resolved.baseOid as string}...${head}`)).toBe(
      "feature.txt",
    );
  });

  it("bases a branch that has not merged the newest primary where it left", async () => {
    const { root, localTip, remoteTip } = staleLocalMain();
    // Cut from the OLDER spelling: the head left the primary branch at `localTip`,
    // so the merge-base is that commit even though the winning ref is at `remoteTip`.
    git(root, "checkout", "-qb", "feat/cut-early", localTip);
    const head = commit(root, "early.txt", "early\n");

    const resolved = await resolvePrimaryBase(execaGit, root, { primaryBranch: "main", head });

    expect(resolved.baseRef).toBe("origin/main");
    expect(resolved.baseOid).toBe(localTip);
    expect(resolved.baseOid).not.toBe(remoteTip);
  });
});
