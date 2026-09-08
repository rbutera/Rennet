import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit, type GitExec } from "./git-range-diff";
import {
  listWorkspaces,
  parseWorktreeRecords,
  removeWorkspace,
  siblingIsCollectable,
  type WorkspaceRow,
  type WorkspaceSessionRef,
  windowsFoldsCase,
} from "./workspace-inventory";
import { parseWorktrees } from "./worktree-discovery";

// Real temporary git repositories throughout: `git worktree list --porcelain` is the whole
// input to this module, and a fake of it would only ever prove that the fake matches the
// parser. Every removal below is run by real git, so a refusal is git's own bytes. The two
// exceptions are deliberate — a WSL spelling and a case-sensitive pair of paths are
// arrangements this machine's filesystem cannot produce, so those two drive a fake runner
// and say so.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/**
 * Does the scratch filesystem keep `A` and `a` apart?
 *
 * macOS's default APFS volume does not, which is exactly why the case-folding tests below
 * that need two real directories are skipped there — the arrangement they guard cannot be
 * built on that machine. The bug they guard is a LINUX one (git branch names are
 * case-sensitive, so `feat/ABC-1` and `feat/abc-1` are two worktrees), so the fake-runner
 * test beside them carries the assertion on every platform.
 */
const CASE_SENSITIVE_SCRATCH = (() => {
  const dir = mkdtempSync(join(tmpdir(), "rennet-wsinv-case-"));
  try {
    mkdirSync(join(dir, "CaseProbe"));
    return !existsSync(join(dir, "caseprobe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

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
  initRepo(root);
  const worktreeRoot = join(dataDir, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  return { root, worktreeRoot, headOid: git(root, "rev-parse", "HEAD") };
}

/** `git init` on `feat/x` with one commit — the shape every fixture below starts from. */
function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "feat/x");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
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

/** A runner that answers ONE canned `git worktree list --porcelain -z` and nothing else. */
function cannedGit(porcelain: string): GitExec {
  return async (_root, args) => {
    if (args[0] === "worktree" && args[1] === "list") return porcelain;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

/** One `--porcelain -z` record, NUL-delimited exactly as git writes it. */
function record(path: string, branch?: string): string {
  return `worktree ${path}\0${branch === undefined ? "detached" : `branch refs/heads/${branch}`}\0\0`;
}

describe("parseWorktreeRecords", () => {
  it("keeps the detached record `parseWorktrees` drops (a pull-request snapshot)", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const snapshot = join(worktreeRoot, "acme", "widget", "pr-7");
    mkdirSync(join(snapshot, ".."), { recursive: true });
    git(root, "worktree", "add", "-q", "--detach", snapshot, headOid);
    const porcelain = await execaGit(root, ["worktree", "list", "--porcelain", "-z"]);

    const records = parseWorktreeRecords(porcelain);
    const narrowed = parseWorktrees(porcelain);

    // The CONTRAST is the reason this module parses the same bytes for itself: the
    // snapshot is a row of the inventory and is not a (path, branch) pair at all.
    // Git records the RESOLVED path (`/var/…` is `/private/var/…` on macOS), so the
    // comparison is against git's own spelling of the directory we created.
    const resolvedSnapshot = realpathSync(snapshot);
    expect(narrowed.map((worktree) => worktree.path)).not.toContain(resolvedSnapshot);
    expect(narrowed.map((worktree) => worktree.branch)).toEqual(["feat/x"]);
    const detached = records.find((entry) => entry.detached);
    expect(detached?.path).toBe(resolvedSnapshot);
    expect(detached?.head).toBe(headOid);
    expect(detached?.branch).toBeUndefined();
    // The reviewer's own checkout is the other record, and it keeps its branch.
    expect(records.find((entry) => entry.branch === "feat/x")).toBeDefined();
  });

  it("reads an absent stdout as no worktrees rather than throwing", () => {
    expect(parseWorktreeRecords(undefined)).toEqual([]);
    expect(parseWorktreeRecords("")).toEqual([]);
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
    expect(unbound.rows[0]?.id).toMatch(/^[0-9a-f]{16}$/);
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

  it("names the QUERIED repository root own-checkout and a second reviewer checkout by its ref", async () => {
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
      sessions: [
        { id: "s-own", boundRoot: root },
        { id: "s-theirs", boundRoot: reviewerSecond },
      ],
    });

    const byKind = Object.fromEntries(inventory.rows.map((row) => [row.kind, row]));
    // `own-checkout` is the root this list was ASKED FOR and nothing else. The second
    // checkout is a linked worktree on a branch, so it is named for what it IS, and it is
    // not removable because someone is working in it — not because the label said so.
    expect(byKind["own-checkout"]?.ref).toBe("feat/x");
    expect(byKind["own-checkout"]?.sessionIds).toEqual(["s-own"]);
    expect(byKind.branch?.ref).toBe("feat/theirs");
    expect(byKind.branch?.sessionIds).toEqual(["s-theirs"]);
    expect(byKind.branch?.removable).toBe(false);
    expect(byKind["pull-request"]?.ref).toBe(headOid);
    expect(byKind["pull-request"]?.removable).toBe(true);
  });

  it("gives a project rooted at a LINKED worktree exactly one own-checkout row", async () => {
    // The defect: `own-checkout` was git's first (main) record OR the queried root, so a
    // project whose root IS a linked worktree produced TWO rows both reading "your own
    // checkout" — one of them a directory the reviewer never opened, and permanently
    // unremovable for a reason the card could not explain. The reviewer's own checkout is
    // the root the list was asked for; that is what the word means.
    const { root, worktreeRoot, headOid } = fixture();
    const linked = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, linked, "feat/y", headOid);

    const inventory = await listWorkspaces(execaGit, linked, {
      root: worktreeRoot,
      measureSizes: false,
    });

    expect(inventory.rows.map((row) => row.kind)).toEqual(["own-checkout"]);
    expect(inventory.rows[0]?.ref).toBe("feat/y");
    expect(inventory.rows[0]?.removable).toBe(false);
    // Git's main worktree is not under the resolved root and nothing is bound to it, so it
    // is not a candidate at all (D6's rule) — not a second "your own checkout".
    expect(inventory.rows.map((row) => row.ref)).not.toContain("feat/x");

    // Bind a session to it and it enters the list for THAT reason — as a branch worktree
    // someone is working in, unremovable because it is busy, not because of its label.
    const bound = await listWorkspaces(execaGit, linked, {
      root: worktreeRoot,
      measureSizes: false,
      sessions: [{ id: "s-main", boundRoot: root }],
    });
    const mainRow = bound.rows.find((row) => row.ref === "feat/x");
    expect(mainRow?.kind).toBe("branch");
    expect(mainRow?.sessionIds).toEqual(["s-main"]);
    expect(mainRow?.removable).toBe(false);
    expect(bound.rows.filter((row) => row.kind === "own-checkout")).toHaveLength(1);
  });

  it("still names a Rennet worktree under a FORMER root by its ref, not the reviewer's checkout", async () => {
    // The reviewer changed `worktree.location`: everything Rennet placed under the old
    // root is outside the root this call was given, and only a live session's `boundRoot`
    // still points at it. Decided by exclusion it would be "your own checkout" — listed
    // beside the real one and permanently unremovable. Decided positively it is a branch
    // worktree that happens to be busy.
    const { root, worktreeRoot, headOid } = fixture();
    const formerRoot = mkdtempSync(join(tmpdir(), "rennet-wsinv-former-"));
    scratch.push(formerRoot);
    const stranded = join(formerRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, stranded, "feat/y", headOid);

    const inventory = await listWorkspaces(execaGit, root, {
      root: worktreeRoot, // the NEW root; `stranded` is not under it
      measureSizes: false,
      sessions: [{ id: "s-live", boundRoot: stranded }],
    });

    expect(inventory.rows).toHaveLength(1);
    expect(inventory.rows[0]?.kind).toBe("branch");
    expect(inventory.rows[0]?.ref).toBe("feat/y");
    expect(inventory.rows[0]?.sessionIds).toEqual(["s-live"]);
    expect(inventory.rows[0]?.removable).toBe(false);
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
    // Collectable ⇒ removing this row takes the branch too, so there is nothing to keep.
    expect(merged.rows[0]?.keepsBranch).toBeUndefined();
    expect(merged.rows[0]?.removable).toBe(true);

    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    const ahead = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(ahead.rows[0]?.aheadOf).toEqual({ branch: "feat/x", commits: 1 });
    // The same sentence the removal's own note will carry, so the card cannot promise one
    // thing and the outcome report another.
    expect(ahead.rows[0]?.keepsBranch).toBe("ahead of feat/x by 1 commit");
    // Still removable: D5 gates the BRANCH, and the worktree can go without losing a commit.
    expect(ahead.rows[0]?.removable).toBe(true);
  });

  it("says a sibling keeps its branch when the reviewed branch no longer exists", async () => {
    // `aheadOf` needs a branch to count against, so a DELETED `feat/x` leaves it absent and
    // the row read exactly like a collectable sibling — while the removal quietly kept
    // `rennet/feat/x`. The marker is the row's half of what the outcome already said.
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    git(root, "checkout", "-q", "--detach", "feat/x");
    git(root, "branch", "-D", "feat/x");

    const { rows } = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    const row = rows.find((candidate) => candidate.kind === "sibling");

    expect(row?.aheadOf).toBeUndefined();
    expect(row?.keepsBranch).toBe("feat/x no longer exists");
    expect(row?.removable).toBe(true);
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

    // Ahead of the LOCAL branch: the row says by how much.
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
  });

  it("is not fooled by a TAG named like the sibling branch (refs, not searches)", async () => {
    // `rennet/feat/x` as a short name is a SEARCH, and git looks in `refs/tags/` before
    // `refs/heads/`. A tag of that name on a merged commit — which `git tag` makes as
    // easily by accident as on purpose — answers D5's question for the branch, and the
    // caller then deletes unmerged commits believing they were reachable. Reproduced
    // against real git; the fix is spelling every ref `refs/heads/…`.
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    git(root, "tag", "rennet/feat/x", "feat/x"); // reachable from feat/x — the shadow

    expect(await siblingIsCollectable(execaGit, root, "rennet/feat/x", "feat/x")).toBe(false);
    const inventory = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
    });
    expect(inventory.rows[0]?.aheadOf).toEqual({ branch: "feat/x", commits: 1 });
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

  it("caps ONE row's session ids on their own bound, not on the row cap", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, branchWorktree, "feat/y", headOid);
    const sessions: WorkspaceSessionRef[] = Array.from({ length: 21 }, (_unused, index) => ({
      id: `s${String(index).padStart(2, "0")}`,
      boundRoot: branchWorktree,
    }));

    const inventory = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
      sessions,
    });

    expect(inventory.rows[0]?.sessionIds).toHaveLength(20);
    expect(inventory.rows[0]?.sessionsTruncated).toBe(true);
    // Twenty of twenty-one: a silent prefix would read as "twenty sessions are bound".
    expect(inventory.rows[0]?.sessionIds).not.toContain("s20");
  });

  it("never reports a createdAt that is really a directory mtime", async () => {
    // A LINKED worktree's `.git` is a file git writes once; the MAIN checkout's is a
    // directory whose mtime advances on every commit. Reporting that mtime would give the
    // reviewer's checkout a "created" date that moves every time they work.
    const { root, worktreeRoot, headOid } = fixture();
    addBranchWorktree(root, join(worktreeRoot, "repo-key", "feat", "y"), "feat/y", headOid);
    commitIn(root, "c.txt", "later\n", "two");
    const gitDirMtime = statSync(join(root, ".git")).mtimeMs;

    const inventory = await listWorkspaces(execaGit, root, {
      root: worktreeRoot,
      measureSizes: false,
      sessions: [{ id: "s1", boundRoot: root }],
    });

    const own = inventory.rows.find((row) => row.kind === "own-checkout");
    expect(own).toBeDefined();
    expect(own?.createdAt).not.toBe(gitDirMtime);
    // Either the filesystem records a birth time, or the cell honestly reads "—".
    expect(own?.createdAt === undefined || own.createdAt <= gitDirMtime).toBe(true);
    // The linked worktree's `.git` IS a file, and its mtime is the creation it claims.
    const linked = inventory.rows.find((row) => row.kind === "branch");
    expect(linked?.createdAt).toBe(statSync(join(linked?.path ?? "", ".git")).mtimeMs);
  });

  it("matches a bound session across the WSL spelling gap (`spellPath`)", async () => {
    // A Windows daemon stores `\\wsl$\Ubuntu\home\u\repo\work` on the session, while the
    // git inside the distro answers `/home/u/repo/work`. No filesystem on this machine has
    // both spellings, so the runner is canned; the spelling is the whole subject.
    const gitMain = "/home/u/repo";
    const gitWork = "/home/u/repo/work";
    const unc = (path: string) => `\\\\wsl$\\Ubuntu${path.split("/").join("\\")}`;
    const runner = cannedGit(`${record(gitMain, "feat/x")}${record(gitWork, "feat/y")}`);
    const options = {
      root: "\\\\wsl$\\Ubuntu\\home\\u\\rennet\\worktrees",
      measureSizes: false,
      sessions: [{ id: "s-wsl", boundRoot: unc(gitWork) }],
    };

    const spelled = await listWorkspaces(runner, unc(gitMain), {
      ...options,
      spellPath: (gitPath) => unc(gitPath),
    });

    expect(spelled.rows).toHaveLength(1);
    expect(spelled.rows[0]?.path).toBe(unc(gitWork));
    expect(spelled.rows[0]?.sessionIds).toEqual(["s-wsl"]);
    // The path a git command must be handed stays git's own — the UNC form names nothing
    // inside the distro, so a removal that sent it would be refused.
    expect(spelled.rows[0]?.gitPath).toBe(gitWork);

    // Without the re-speller the session matches nothing and the bound workspace vanishes
    // from the card entirely — which is the defect, not a milder version of it.
    const unspelled = await listWorkspaces(runner, unc(gitMain), options);
    expect(unspelled.rows).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps two workspaces whose paths differ only in case apart",
    async () => {
      // Git branch names are case-sensitive, so `feat/ABC-1` and `feat/abc-1` are two
      // worktrees on Linux. Folding case unconditionally makes them one row's worth of
      // matching: the session bound to one lands on BOTH, and both read as busy.
      // Canned, because this machine's filesystem may not hold both directories.
      const lower = "/w/repo-key/feat/abc-1";
      const upper = "/w/repo-key/feat/ABC-1";
      const runner = cannedGit(
        `${record("/w/repo", "feat/x")}${record(lower, "feat/abc-1")}${record(upper, "feat/ABC-1")}`,
      );

      const inventory = await listWorkspaces(runner, "/w/repo", {
        root: "/w/repo-key",
        measureSizes: false,
        sessions: [{ id: "s-lower", boundRoot: lower }],
      });

      expect(inventory.rows.map((row) => row.path).sort()).toEqual([upper, lower].sort());
      expect(inventory.rows.find((row) => row.path === lower)?.sessionIds).toEqual(["s-lower"]);
      expect(inventory.rows.find((row) => row.path === upper)?.sessionIds).toEqual([]);
      expect(inventory.rows.find((row) => row.path === upper)?.removable).toBe(true);
    },
  );

  it("folds a Windows daemon's own paths but never a WSL repository's", async () => {
    // `process.platform === "win32"` folded EVERY path, so a Windows daemon driving a
    // WSL-locus repository folded `\\wsl$\…\feat\ABC-1` onto `\\wsl$\…\feat\abc-1` — two
    // real worktrees, because the distro's filesystem is case-sensitive — and the session
    // bound to the lower-case one landed on the upper-case row as well.
    //
    // The predicate is INJECTED rather than the platform monkeypatched: `windowsFoldsCase`
    // is the exact function a Windows daemon runs, and neither arrangement below can be
    // built on the machine this suite runs on, so the runner is canned. Both pairs are
    // candidates only through their bound session — `underPath` compares with the HOST's
    // separator, which is not the one in these paths.
    const wslLower = "\\\\wsl$\\Ubuntu\\home\\u\\wt\\feat\\abc-1";
    const wslUpper = "\\\\wsl$\\Ubuntu\\home\\u\\wt\\feat\\ABC-1";
    const wsl = await listWorkspaces(
      cannedGit(
        `${record("\\\\wsl$\\Ubuntu\\home\\u\\repo", "feat/x")}` +
          `${record(wslLower, "feat/abc-1")}${record(wslUpper, "feat/ABC-1")}`,
      ),
      "\\\\wsl$\\Ubuntu\\home\\u\\repo",
      {
        root: "\\\\wsl$\\Ubuntu\\home\\u\\nothing-here",
        measureSizes: false,
        foldsCase: windowsFoldsCase,
        sessions: [{ id: "s-lower", boundRoot: wslLower }],
      },
    );

    expect(wsl.rows.map((row) => row.path)).toEqual([wslLower]);
    expect(wsl.rows[0]?.sessionIds).toEqual(["s-lower"]);

    // The same daemon, a path that really is on Windows: `C:\work\Feat\x` and
    // `C:\work\feat\x` ARE one directory there, so the fold still applies.
    const winLower = "C:\\work\\feat\\x";
    const winUpper = "C:\\work\\Feat\\x";
    const win = await listWorkspaces(
      cannedGit(
        `${record("C:\\work\\repo", "feat/x")}` +
          `${record(winLower, "feat/x")}${record(winUpper, "feat/x")}`,
      ),
      "C:\\work\\repo",
      {
        root: "C:\\nothing-here",
        measureSizes: false,
        foldsCase: windowsFoldsCase,
        sessions: [{ id: "s-win", boundRoot: winLower }],
      },
    );

    expect(win.rows.map((row) => row.path).sort()).toEqual([winLower, winUpper].sort());
    expect(win.rows.every((row) => row.sessionIds[0] === "s-win")).toBe(true);
  });

  it("folds a WSL path's UNC HEAD but not the distro path behind it", async () => {
    // Windows resolves the share name and the distro name case-INSENSITIVELY, so
    // `\\WSL$\ubuntu\home\u\wt` and `\\wsl$\Ubuntu\home\u\wt` are ONE directory — and a
    // project opened through one spelling with a session bound through the other showed
    // the workspace as idle and removable while a session was working in it. Behind the
    // head is the distro's own case-SENSITIVE filesystem, which must NOT fold.
    const gitSpelling = "\\\\wsl$\\Ubuntu\\home\\u\\wt\\feat\\abc-1";
    const sessionSpelling = "\\\\WSL$\\ubuntu\\home\\u\\wt\\feat\\abc-1";
    const upperTail = "\\\\wsl$\\Ubuntu\\home\\u\\wt\\feat\\ABC-1";
    const inventory = await listWorkspaces(
      cannedGit(
        `${record("\\\\wsl$\\Ubuntu\\home\\u\\repo", "feat/x")}` +
          `${record(gitSpelling, "feat/abc-1")}${record(upperTail, "feat/ABC-1")}`,
      ),
      "\\\\wsl$\\Ubuntu\\home\\u\\repo",
      {
        root: "\\\\wsl$\\Ubuntu\\home\\u\\nothing-here",
        measureSizes: false,
        foldsCase: windowsFoldsCase,
        sessions: [{ id: "s-wsl", boundRoot: sessionSpelling }],
      },
    );

    // The HEAD folded: the differently spelled session matched its own directory.
    expect(inventory.rows.map((row) => row.path)).toEqual([gitSpelling]);
    expect(inventory.rows[0]?.sessionIds).toEqual(["s-wsl"]);
    // …and the TAIL did not. `…\feat\ABC-1` is a different directory on the distro's
    // case-sensitive filesystem, nothing claims it, and it is absent rather than folded
    // onto the row above and dragging that session's id with it.
    expect(inventory.rows).toHaveLength(1);
  });

  it.skipIf(!CASE_SENSITIVE_SCRATCH)(
    "removes exactly the case-differing worktree it was asked for",
    async () => {
      // Skipped on a case-insensitive filesystem (macOS's default APFS): the arrangement
      // cannot be built there, and cannot occur there either.
      const { root, worktreeRoot, headOid } = fixture();
      const lower = join(worktreeRoot, "repo-key", "feat", "abc-1");
      const upper = join(worktreeRoot, "repo-key", "feat", "ABC-1");
      addBranchWorktree(root, lower, "feat/abc-1", headOid);
      addBranchWorktree(root, upper, "feat/ABC-1", headOid);
      const { rows } = await listWorkspaces(execaGit, root, {
        root: worktreeRoot,
        measureSizes: false,
      });
      expect(rows).toHaveLength(2);

      const lowerRow = rows.find((row) => row.path === lower);
      const outcome = await removeWorkspace(execaGit, root, { id: lowerRow?.id ?? "", rows });

      expect(outcome.status).toBe("removed");
      expect(existsSync(lower)).toBe(false);
      expect(existsSync(upper)).toBe(true);
      expect(git(root, "branch", "--list", "feat/ABC-1")).toContain("feat/ABC-1");
    },
  );

  it("lists only THIS repository's workspaces when two share one root and one branch name", async () => {
    // A workspace project maps many repositories onto one identity and that mapping is not
    // invertible (CLAUDE.md, 2026-08-28). Two repositories both on `feat/x`, both with a
    // Rennet worktree under ONE root, both with a live session: asking git which worktrees
    // belong to repository A is the only question whose answer cannot include B's.
    const sharedRoot = mkdtempSync(join(tmpdir(), "rennet-wsinv-shared-"));
    const alpha = mkdtempSync(join(tmpdir(), "rennet-wsinv-alpha-"));
    const beta = mkdtempSync(join(tmpdir(), "rennet-wsinv-beta-"));
    scratch.push(sharedRoot, alpha, beta);
    initRepo(alpha);
    initRepo(beta);
    const alphaWork = join(sharedRoot, "alpha", "feat", "y");
    const betaWork = join(sharedRoot, "beta", "feat", "y");
    addBranchWorktree(alpha, alphaWork, "feat/y", "feat/x");
    addBranchWorktree(beta, betaWork, "feat/y", "feat/x");
    const sessions: WorkspaceSessionRef[] = [
      { id: "s-alpha", boundRoot: alphaWork },
      { id: "s-beta", boundRoot: betaWork },
    ];

    const inventory = await listWorkspaces(execaGit, alpha, {
      root: sharedRoot,
      measureSizes: false,
      sessions,
    });

    expect(inventory.rows).toHaveLength(1);
    expect(inventory.rows[0]?.sessionIds).toEqual(["s-alpha"]);
    const paths = inventory.rows.map((row) => row.path);
    expect(paths.some((path) => path.includes(join("beta", "feat")))).toBe(false);
    expect(inventory.rows.flatMap((row) => row.sessionIds)).not.toContain("s-beta");
  });

  it("surfaces git's own failure instead of an empty inventory", async () => {
    // `{ reject: false }` here turned "not a repository" into `{ rows: [], truncated: false }`,
    // which the card renders as "Nothing yet" — a lie about a repository whose worktrees
    // were never read at all.
    const notARepo = mkdtempSync(join(tmpdir(), "rennet-wsinv-bare-"));
    scratch.push(notARepo);

    await expect(
      listWorkspaces(execaGit, notARepo, { root: notARepo, measureSizes: false }),
    ).rejects.toThrow(/not a git repository/i);
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
  async function inventory(
    root: string,
    worktreeRoot: string,
    sessions: WorkspaceSessionRef[] = [],
  ): Promise<{ rows: WorkspaceRow[] }> {
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

    const outcome = await removeWorkspace(execaGit, root, { id: rows[0]?.id ?? "", rows });

    expect(outcome).toEqual({ status: "removed", id: rows[0]?.id, path: rows[0]?.path });
    expect(existsSync(branchWorktree)).toBe(false);
    expect((await inventory(root, worktreeRoot)).rows).toEqual([]);
  });

  it("reports git's refusal verbatim for a dirty worktree, and the directory stays", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, branchWorktree, "feat/y", headOid);
    writeFileSync(join(branchWorktree, "a.txt"), "uncommitted\n");
    const { rows } = await inventory(root, worktreeRoot);

    const outcome = await removeWorkspace(execaGit, root, { id: rows[0]?.id ?? "", rows });

    expect(outcome.status).toBe("refused");
    // Git's own words, not Rennet's paraphrase of them.
    expect(outcome.status === "refused" && outcome.reason).toMatch(/contains modified/);
    expect(existsSync(join(branchWorktree, "a.txt"))).toBe(true);
    expect((await inventory(root, worktreeRoot)).rows).toHaveLength(1);
  });

  it("cannot address the reviewer's own checkout, a bound workspace, or an unknown id", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
    addBranchWorktree(root, branchWorktree, "feat/y", headOid);
    const rows = (
      await inventory(root, worktreeRoot, [
        { id: "s-own", boundRoot: root },
        { id: "s-work", boundRoot: branchWorktree },
      ])
    ).rows;

    const ownRow = rows.find((row) => row.kind === "own-checkout");
    const own = await removeWorkspace(execaGit, root, { id: ownRow?.id ?? "", rows });
    expect(own).toEqual({
      status: "not-removable",
      id: ownRow?.id,
      path: ownRow?.path,
      reason: "your own checkout",
    });
    expect(existsSync(join(root, "a.txt"))).toBe(true);

    const busyRow = rows.find((row) => row.kind === "branch");
    const busy = await removeWorkspace(execaGit, root, { id: busyRow?.id ?? "", rows });
    expect(busy).toEqual({
      status: "not-removable",
      id: busyRow?.id,
      path: busyRow?.path,
      reason: "bound to session s-work",
    });
    expect(existsSync(branchWorktree)).toBe(true);

    const unknown = await removeWorkspace(execaGit, root, { id: "0123456789abcdef", rows });
    expect(unknown).toEqual({
      status: "not-removable",
      id: "0123456789abcdef",
      reason: "not a workspace Rennet knows for this repository",
    });
  });

  it("deletes a merged sibling's branch with its worktree (D5)", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    const { rows } = await inventory(root, worktreeRoot);

    const outcome = await removeWorkspace(execaGit, root, { id: rows[0]?.id ?? "", rows });

    expect(outcome).toEqual({
      status: "removed",
      id: rows[0]?.id,
      path: rows[0]?.path,
      siblingBranchDeleted: true,
    });
    expect(existsSync(sibling)).toBe(false);
    expect(git(root, "branch", "--list", "rennet/feat/x")).toBe("");
  });

  it("removes an AHEAD sibling's worktree and keeps its branch, saying which (D5)", async () => {
    // D5 gates the deletion of a BRANCH. Removing the worktree loses nothing — the commits
    // stay on `rennet/feat/x`, a ref the reviewer can check out — so refusing the removal
    // would be Rennet inventing a "no" where git would have said yes.
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    commitIn(sibling, "c.txt", "more\n", "more work");
    const { rows } = await inventory(root, worktreeRoot);

    const outcome = await removeWorkspace(execaGit, root, { id: rows[0]?.id ?? "", rows });

    expect(outcome).toEqual({
      status: "removed",
      id: rows[0]?.id,
      path: rows[0]?.path,
      siblingBranchDeleted: false,
      note: "rennet/feat/x kept: ahead of feat/x by 2 commits",
    });
    expect(existsSync(sibling)).toBe(false);
    expect(git(root, "branch", "--list", "rennet/feat/x")).toContain("rennet/feat/x");
    expect(git(root, "rev-list", "--count", "refs/heads/rennet/feat/x")).toBe("3");
  });

  it("keeps an ahead sibling's branch even when a TAG of that name is reachable", async () => {
    // The reproduction, end to end: with the tag shadowing the branch, a short-name
    // ancestry check answers "collectable" and `branch -D` then deletes two unmerged
    // commits. Spelled `refs/heads/…` it answers "no" and the branch survives the removal.
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    const siblingTip = git(sibling, "rev-parse", "HEAD");
    git(root, "tag", "rennet/feat/x", "feat/x");
    const { rows } = await inventory(root, worktreeRoot);

    const outcome = await removeWorkspace(execaGit, root, { id: rows[0]?.id ?? "", rows });

    expect(outcome.status === "removed" && outcome.siblingBranchDeleted).toBe(false);
    expect(existsSync(sibling)).toBe(false);
    expect(git(root, "rev-parse", "refs/heads/rennet/feat/x")).toBe(siblingTip);
  });

  it("says the branch is GONE, not that it holds commits, when the branch was deleted", async () => {
    const { root, worktreeRoot, headOid } = fixture();
    const sibling = join(worktreeRoot, "repo-key", "rennet", "feat", "x");
    addBranchWorktree(root, sibling, "rennet/feat/x", headOid);
    commitIn(sibling, "b.txt", "sibling work\n", "round work");
    git(root, "checkout", "-q", "--detach", "feat/x");
    git(root, "branch", "-D", "feat/x");
    const { rows } = await inventory(root, worktreeRoot);
    const siblingRow = rows.find((row) => row.kind === "sibling");

    const outcome = await removeWorkspace(execaGit, root, { id: siblingRow?.id ?? "", rows });

    expect(outcome.status === "removed" && outcome.note).toBe(
      "rennet/feat/x kept: feat/x no longer exists",
    );
    expect(git(root, "branch", "--list", "rennet/feat/x")).toContain("rennet/feat/x");
  });
});
