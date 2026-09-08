import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  listWorkspaces,
  parseWorktreeRecords,
  removeWorkspace,
  siblingIsCollectable,
} from "./workspace-inventory";

// Real temporary git repositories throughout: `git worktree list --porcelain` is the whole
// input to this module, and a fake of it would only ever prove that the fake matches the
// parser. Every removal below is run by real git, so a refusal is git's own bytes.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

interface Fixture {
  /** The reviewer's own checkout, on `feat/x`. */
  readonly root: string;
  /** The resolved worktree root — everything Rennet places lives under it. */
  readonly worktreeRoot: string;
  readonly headOid: string;
}

/** A repository on `feat/x` with one commit, plus an empty Rennet worktree root. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rennet-wsinv-"));
  const dataDir = mkdtempSync(join(tmpdir(), "rennet-wsinv-data-"));
  scratch.push(root, dataDir);
  git(root, "init", "-q", "-b", "feat/x");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const worktreeRoot = join(dataDir, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  return { root, worktreeRoot, headOid: git(root, "rev-parse", "HEAD") };
}

/** Add a worktree of `root` at `path` on a NEW branch forked from `from`. */
function addBranchWorktree(root: string, path: string, branch: string, from: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  git(root, "worktree", "add", "-q", "-b", branch, path, from);
}

function commitIn(worktree: string, file: string, body: string, message: string): void {
  writeFileSync(join(worktree, file), body);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", message);
}

describe("parseWorktreeRecords", () => {
  it("keeps the detached record `parseWorktrees` drops (a pull-request snapshot)", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const snapshot = join(worktreeRoot, "acme", "widget", "pr-7");
    mkdirSync(join(snapshot, ".."), { recursive: true });
    git(root, "worktree", "add", "-q", "--detach", snapshot, headOid);

    const records = parseWorktreeRecords(
      await execaGit(root, ["worktree", "list", "--porcelain", "-z"]),
    );

    const detached = records.find((record) => record.detached);
    expect(detached?.head).toBe(headOid);
    expect(detached?.branch).toBeUndefined();
    // The reviewer's own checkout is the other record, and it keeps its branch.
    expect(records.find((record) => record.branch === "feat/x")).toBeDefined();
  });
});

describe("listWorkspaces", () => {
  it("lists Rennet's branch worktree and leaves the reviewer's checkout out until a session binds", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, branchWorktree, "feat/y", headOid);

    const unbound = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(unbound.rows.map((row) => row.kind)).toEqual(["branch"]);
    expect(unbound.rows[0]?.ref).toBe("feat/y");
    expect(unbound.rows[0]?.removable).toBe(true);
    expect(unbound.rows[0]?.createdAt).toBeGreaterThan(0);
    expect(unbound.truncated).toBe(false);

    const bound = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
      sessions: [{ id: "s1", boundRoot: root, lastActivityAt: 1_700_000_000_000 }],
    });
    const own = bound.rows.find((row) => row.kind === "own-checkout");
    expect(own?.sessionIds).toEqual(["s1"]);
    expect(own?.lastUsedAt).toBe(1_700_000_000_000);
    expect(own?.removable).toBe(false);

    // An ARCHIVED session holds no workspace, so the checkout leaves the list again.
    const archived = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
      sessions: [{ id: "s1", boundRoot: root, archivedAt: 1_700_000_100_000 }],
    });
    expect(archived.rows.map((row) => row.kind)).toEqual(["branch"]);
  });

  it("names a session's own worktree own-checkout and a pull-request snapshot by its index entry", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const reviewerSecond = mkdtempSync(join(tmpdir(), "rennet-wsinv-own-"));
    scratch.push(reviewerSecond);
    rmSync(reviewerSecond, { recursive: true, force: true });
    git(root, "worktree", "add", "-q", "-b", "feat/theirs", reviewerSecond, headOid);
    const snapshot = join(worktreeRoot, "acme", "widget", "pr-7");
    mkdirSync(join(snapshot, ".."), { recursive: true });
    git(root, "worktree", "add", "-q", "--detach", snapshot, headOid);

    const inventory = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
      prWorktreePaths: [snapshot],
      sessions: [{ id: "s-own", boundRoot: reviewerSecond }],
    });

    const byKind = Object.fromEntries(inventory.rows.map((row) => [row.kind, row]));
    expect(byKind["own-checkout"]?.ref).toBe("feat/theirs");
    expect(byKind["own-checkout"]?.sessionIds).toEqual(["s-own"]);
    expect(byKind["pull-request"]?.ref).toBe(headOid);
    expect(byKind["pull-request"]?.removable).toBe(true);
    // The repository's own root is bound to nothing, so it is not a row at all.
    expect(inventory.rows.some((row) => row.ref === "feat/x")).toBe(false);
  });

  it("reads a sibling as collectable while it is merged and ahead once it is not (D5)", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);

    const merged = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(merged.rows[0]?.kind).toBe("sibling");
    expect(merged.rows[0]?.aheadOf).toBeUndefined();
    expect(merged.rows[0]?.removable).toBe(true);

    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    const ahead = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(ahead.rows[0]?.aheadOf).toEqual({ branch: "feat/x", commits: 1 });
    expect(ahead.rows[0]?.removable).toBe(false);
  });

  it("collects a sibling reachable from the branch's REMOTE-tracking ref (D5's second arm)", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const remote = mkdtempSync(join(tmpdir(), "rennet-wsinv-remote-"));
    scratch.push(remote);
    git(remote, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "-u", "origin", "feat/x");
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    commitIn(sibling, "b.txt", "sibling work\n", "round work");

    // Ahead of the LOCAL branch: kept, and the row says by how much.
    const beforePush = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(beforePush.rows[0]?.aheadOf).toEqual({ branch: "feat/x", commits: 1 });

    // The push under `own` maps the sibling onto the branch's name on the remote.
    git(root, "push", "-q", "origin", "rennet/feat/x:feat/x");
    git(root, "fetch", "-q", "origin");
    expect(await siblingIsCollectable(execaGit, root, "rennet/feat/x", "feat/x")).toBe(true);

    const afterPush = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(afterPush.rows[0]?.aheadOf).toBeUndefined();
    expect(afterPush.rows[0]?.removable).toBe(true);
  });

  it("caps the rows it returns and says so", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    addBranchWorktree(root, join(worktreeRoot, "repo-key", "feat", "y"), "feat/y", headOid);
    addBranchWorktree(root, join(worktreeRoot, "repo-key", "feat", "z"), "feat/z", headOid);

    const capped = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
      maxRows: 1,
    });
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    const uncapped = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(uncapped.rows).toHaveLength(2);
    expect(uncapped.truncated).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "measures a size, and reads unknown rather than zero past the bound",
    async () => {
      const { root, worktreeRoot, headOid } = fixture();
      const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
      addBranchWorktree(root, branchWorktree, "feat/y", headOid);
      // Enough files that `du` cannot finish in a millisecond, so the per-row bound is
      // what produces the unknown below — not a `du` that was never going to answer.
      const noise = join(branchWorktree, "noise");
      mkdirSync(noise, { recursive: true });
      for (let index = 0; index < 400; index += 1) {
        writeFileSync(join(noise, `f${index}.txt`), "x".repeat(512));
      }

      const measured = await listWorkspaces(execaGit, root, { root: worktreeRoot });
      expect(measured.rows[0]?.sizeBytes).toBeGreaterThan(0);

      // Same row, same `du`, one millisecond to do it in.
      const perRowCapped = await listWorkspaces(execaGit, root, {
        root: worktreeRoot,
        sizeBudgetMs: 1,
      });
      expect(perRowCapped.rows[0]?.sizeBytes).toBeUndefined();

      // And the whole-list bound answers the same way, deterministically.
      const totalCapped = await listWorkspaces(execaGit, root, {
        root: worktreeRoot,
        totalSizeBudgetMs: 0,
      });
      expect(totalCapped.rows[0]?.sizeBytes).toBeUndefined();
    },
  );
});

describe("removeWorkspace", () => {
  async function inventory(root: string, worktreeRoot: string, sessions = []) {
    return listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
      sessions,
    });
  }

  it("removes an idle branch worktree, and the row is gone from the next read", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, branchWorktree, "feat/y", headOid);
    const { rows } = await inventory(root, worktreeRoot);

    const outcome = await removeWorkspace(execaGit, root, { path: rows[0]?.path ?? "", rows });

    expect(outcome.status).toBe("removed");
    expect(existsSync(branchWorktree)).toBe(false);
    expect((await inventory(root, worktreeRoot)).rows).toEqual([]);
  });

  it("reports git's refusal verbatim for a dirty worktree, and the directory stays", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, branchWorktree, "feat/y", headOid);
    writeFileSync(join(branchWorktree, "a.txt"), "uncommitted\n");
    const { rows } = await inventory(root, worktreeRoot);

    const outcome = await removeWorkspace(execaGit, root, { path: rows[0]?.path ?? "", rows });

    expect(outcome.status).toBe("refused");
    // Git's own words, not Rennet's paraphrase of them.
    expect(outcome.status === "refused" && outcome.reason).toMatch(/contains modified/);
    expect(existsSync(join(branchWorktree, "a.txt"))).toBe(true);
    expect((await inventory(root, worktreeRoot)).rows).toHaveLength(1);
  });

  it("cannot address the reviewer's own checkout, a bound workspace, or an unknown path", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, branchWorktree, "feat/y", headOid);
    const rows = (
      await listWorkspaces(execaGit, root, {
        root: worktreeRoot,
        measureSizes: false,
        sessions: [
          { id: "s-own", boundRoot: root },
          { id: "s-work", boundRoot: branchWorktree },
        ],
      })
    ).rows;

    // The outcome names the row's own spelling of the path (git's realpath), not the
    // caller's — `/var/…` and `/private/var/…` are one directory on macOS.
    const ownRow = rows.find((row) => row.kind === "own-checkout");
    const own = await removeWorkspace(execaGit, root, { path: root, rows });
    expect(own).toEqual({
      status: "not-removable",
      path: ownRow?.path,
      reason: "your own checkout",
    });
    expect(existsSync(join(root, "a.txt"))).toBe(true);

    const busy = await removeWorkspace(execaGit, root, { path: branchWorktree, rows });
    expect(busy.status).toBe("not-removable");
    expect(existsSync(branchWorktree)).toBe(true);

    const unknown = await removeWorkspace(execaGit, root, {
      path: join(worktreeRoot, "nothing", "here"),
      rows,
    });
    expect(unknown.status).toBe("not-removable");
  });

  it("deletes a merged sibling's branch with its worktree and keeps an ahead one (D5)", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);

    const mergedRows = (await inventory(root, worktreeRoot)).rows;
    const merged = await removeWorkspace(execaGit, root, { path: sibling, rows: mergedRows });
    expect(merged).toEqual({
      status: "removed",
      path: mergedRows[0]?.path,
      siblingBranchDeleted: true,
    });
    expect(existsSync(sibling)).toBe(false);
    expect(git(root, "branch", "--list", "rennet/feat/x")).toBe("");

    // The same sibling again, this time holding a commit `feat/x` does not: both stay.
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    const aheadRows = (await inventory(root, worktreeRoot)).rows;
    const ahead = await removeWorkspace(execaGit, root, { path: sibling, rows: aheadRows });
    expect(ahead).toEqual({
      status: "not-removable",
      path: aheadRows[0]?.path,
      reason: "ahead of feat/x by 1 commit",
    });
    expect(existsSync(sibling)).toBe(true);
    expect(git(root, "branch", "--list", "rennet/feat/x")).toContain("rennet/feat/x");
  });
});
