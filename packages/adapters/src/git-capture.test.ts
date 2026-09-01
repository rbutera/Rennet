import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCaptureAdapter } from "./git-capture";
import { EXCLUDE_APP_OWNED_PATHSPEC, type GitExec } from "./git-range-diff";

// win32 git operations on a cold disk exceed vitest's 5s default (measured 6-11s on
// lancelot); give this git-heavy suite room. Not a hang — the same tests pass fast on
// macOS/Linux and complete well under this ceiling on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const directories: string[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-git-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "tracked.txt"), "before\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "initial");
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("GitCaptureAdapter", () => {
  it("keeps the Windows-view root for WSL identity and snapshot pinning", async () => {
    const windowsRoot = "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo";
    const distroRoot = "/home/rai/repo";
    const pinnedRoots: string[] = [];
    const run: GitExec = async (_root, args) => {
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return `${distroRoot}\n`;
      if (command === "rev-parse --git-common-dir") return `${distroRoot}/.git\n`;
      if (command === "rev-parse HEAD") return "head\n";
      if (command === "symbolic-ref --short -q HEAD") return "feature\n";
      if (command === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return "origin/main\n";
      }
      if (command === "rev-parse --verify origin/main^{commit}") return "base\n";
      if (command === "merge-base origin/main HEAD") return "base\n";
      if (
        command ===
        "ls-files --others --ignored --exclude-standard -z -- :(glob).superpowers/sdd/*/progress.md"
      ) {
        return "";
      }
      // Every whole-tree diff carries the app-owned exclusion (#729, D6). Spelling the
      // commands out exactly is the point: a capture that quietly stopped passing it
      // would fail here rather than in production.
      if (
        command ===
        `diff --binary --full-index --no-ext-diff --no-textconv base tree -- ${EXCLUDE_APP_OWNED_PATHSPEC}`
      ) {
        return "";
      }
      if (command === `diff --name-status -z base tree -- ${EXCLUDE_APP_OWNED_PATHSPEC}`) return "";
      if (command === `diff --numstat -z base tree -- ${EXCLUDE_APP_OWNED_PATHSPEC}`) return "";
      if (command === "log --format=%s base..head") return "";
      throw new Error(`unexpected git command: ${command}`);
    };

    const patchset = await new GitCaptureAdapter(
      undefined,
      (repoRoot) => {
        pinnedRoots.push(repoRoot);
        return "snapshot";
      },
      () => ({ kind: "wsl", distro: "Ubuntu" }),
      {
        gitFor: () => run,
        captureReviewedTree: async (root) => {
          pinnedRoots.push(root);
          return "tree";
        },
      },
    ).capture(windowsRoot);

    expect(pinnedRoots).toEqual([distroRoot, windowsRoot]);
    expect(patchset.repository.root).toBe(windowsRoot);
    expect(patchset.repository.commonDir).toBe(`${windowsRoot}\\.git`);
    expect(patchset.repository.reviewedTreeOid).toBe("tree");
  });

  it("stamps the effective project snapshot identity resolved at capture time", async () => {
    const root = repository();
    const seen: string[] = [];
    const patchset = await new GitCaptureAdapter(undefined, (repoRoot, baseOid) => {
      seen.push(repoRoot, baseOid);
      return "project-snapshot";
    }).capture(root);
    expect(patchset.projectSnapshotId).toBe("project-snapshot");
    expect(seen[0]).toBe(patchset.repository.root);
    expect(seen[1]).toBe(patchset.repository.baseOid);
  });

  it("captures an unchanged repository as an empty patchset", async () => {
    const root = repository();
    const patchset = await new GitCaptureAdapter().capture(root);
    expect(patchset.files).toEqual([]);
    expect(patchset.rawDiff).toBe("");
  });

  it("captures branch, staged, unstaged, and nonignored untracked content", async () => {
    const root = repository();
    git(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "branch.txt"), "branch\n");
    git(root, "add", "branch.txt");
    git(root, "commit", "-qm", "branch change");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    writeFileSync(join(root, "tracked.txt"), "after\n");
    writeFileSync(join(root, "untracked.txt"), "untracked\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(root, "ignored.txt"), "ignored\n");

    const patchset = await new GitCaptureAdapter().capture(root);
    const paths = patchset.files.map((file) => file.path);

    expect(paths).toEqual([
      ".gitignore",
      "branch.txt",
      "staged.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(patchset.rawDiff).toContain("+untracked");
    expect(patchset.rawDiff).not.toContain("ignored\n");
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("after\n");
  });

  it("captures only ignored Superpowers progress ledgers in the immutable reviewed tree", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitignore"), ".superpowers/\nignored.txt\n");
    mkdirSync(join(root, ".superpowers", "sdd", "search", "nested"), { recursive: true });
    mkdirSync(join(root, ".superpowers", "sdd", "billing"), { recursive: true });
    mkdirSync(join(root, ".superpowers", "other"), { recursive: true });
    writeFileSync(
      join(root, ".superpowers", "sdd", "search", "progress.md"),
      "captured search progress\n",
    );
    writeFileSync(
      join(root, ".superpowers", "sdd", "billing", "progress.md"),
      "captured billing progress\n",
    );
    writeFileSync(join(root, ".superpowers", "sdd", "search", "review.md"), "private review\n");
    writeFileSync(
      join(root, ".superpowers", "sdd", "search", "nested", "progress.md"),
      "nested decoy\n",
    );
    writeFileSync(join(root, ".superpowers", "other", "progress.md"), "other decoy\n");
    writeFileSync(join(root, "ignored.txt"), "unrelated ignored content\n");
    const statusBefore = git(root, "status", "--porcelain=v1", "-z");

    const patchset = await new GitCaptureAdapter().capture(root);
    const reviewedTree = patchset.repository.reviewedTreeOid;
    if (reviewedTree === undefined) throw new Error("capture omitted reviewedTreeOid");
    const treePaths = git(root, "ls-tree", "-r", "--name-only", reviewedTree).trim().split("\n");

    expect(treePaths).toContain(".superpowers/sdd/search/progress.md");
    expect(treePaths).toContain(".superpowers/sdd/billing/progress.md");
    expect(treePaths).not.toContain(".superpowers/sdd/search/review.md");
    expect(treePaths).not.toContain(".superpowers/sdd/search/nested/progress.md");
    expect(treePaths).not.toContain(".superpowers/other/progress.md");
    expect(treePaths).not.toContain("ignored.txt");
    expect(patchset.files.map((file) => file.path)).toEqual([".gitignore"]);
    expect(patchset.rawDiff).not.toContain("captured search progress");
    expect(patchset.rawDiff).not.toContain("captured billing progress");
    expect(patchset.rawDiff).not.toContain("private review");
    expect(patchset.rawDiff).not.toContain("unrelated ignored content");
    expect(git(root, "status", "--porcelain=v1", "-z")).toBe(statusBefore);

    writeFileSync(
      join(root, ".superpowers", "sdd", "search", "progress.md"),
      "later mutable progress\n",
    );
    expect(git(root, "show", `${reviewedTree}:.superpowers/sdd/search/progress.md`)).toBe(
      "captured search progress\n",
    );
  });

  it("captures the head BRANCH ref (#107) — the ref an own-branch PR opens against", async () => {
    const root = repository();
    git(root, "checkout", "-qb", "feat/reviewed");
    writeFileSync(join(root, "tracked.txt"), "after\n");
    const patchset = await new GitCaptureAdapter().capture(root);
    // The branch name, not a slice of the head SHA.
    expect(patchset.repository.headRef).toBe("feat/reviewed");
    expect(patchset.repository.headRef).not.toBe(patchset.repository.headOid.slice(0, 7));
  });

  it("omits headRef honestly on a detached HEAD (no branch to submit from)", async () => {
    const root = repository();
    // Detach HEAD onto the commit itself — there is no branch ref.
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "--detach", head);
    writeFileSync(join(root, "tracked.txt"), "after\n");
    const patchset = await new GitCaptureAdapter().capture(root);
    expect(patchset.repository.headRef).toBeUndefined();
  });

  it("returns the same identity for unchanged repository content", async () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "after\n");
    const adapter = new GitCaptureAdapter();
    expect((await adapter.capture(root)).id).toBe((await adapter.capture(root)).id);
  });

  it("changes identity when captured content changes", async () => {
    const root = repository();
    const adapter = new GitCaptureAdapter();
    writeFileSync(join(root, "tracked.txt"), "first\n");
    const first = await adapter.capture(root);
    writeFileSync(join(root, "tracked.txt"), "second\n");
    const second = await adapter.capture(root);
    expect(second.id).not.toBe(first.id);
  });

  it("retains the exact working-tree bytes after the checkout changes", async () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "captured tracked\n");
    writeFileSync(join(root, "untracked-before.txt"), "captured untracked\n");

    const patchset = await new GitCaptureAdapter().capture(root);
    const reviewedTree = patchset.repository.reviewedTreeOid;
    if (reviewedTree === undefined) throw new Error("capture omitted reviewedTreeOid");

    writeFileSync(join(root, "tracked.txt"), "later tracked\n");
    writeFileSync(join(root, "untracked-before.txt"), "later untracked\n");
    writeFileSync(join(root, "untracked-after.txt"), "not captured\n");

    expect(git(root, "show", `${reviewedTree}:tracked.txt`)).toBe("captured tracked\n");
    expect(git(root, "show", `${reviewedTree}:untracked-before.txt`)).toBe("captured untracked\n");
    expect(git(root, "ls-tree", "-r", "--name-only", reviewedTree)).not.toContain(
      "untracked-after.txt",
    );
    expect(patchset.rawDiff).toContain("+captured tracked");
    expect(patchset.rawDiff).toContain("+captured untracked");
    expect(patchset.rawDiff).not.toContain("later tracked");
  });

  it("attributes rename counts and provenance to the destination path", async () => {
    const root = repository();
    git(root, "mv", "tracked.txt", "renamed.txt");

    const patchset = await new GitCaptureAdapter().capture(root);

    expect(patchset.files).toEqual([
      expect.objectContaining({
        path: "renamed.txt",
        previousPath: "tracked.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
      }),
    ]);
  });

  it("captures the working-tree intent surface honestly: no PR body, commit subjects, spec snapshot (#136)", async () => {
    const root = repository();
    git(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "branch.txt"), "branch\n");
    git(root, "add", "branch.txt");
    git(root, "commit", "-qm", "add the branch file");
    // A spec document changed in the working tree (uncommitted).
    mkdirSync(join(root, "specs"));
    writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\nthe rule\n");

    const patchset = await new GitCaptureAdapter().capture(root);
    // No PR: the missing body is marked honestly, never an empty-string intent.
    expect(patchset.intent?.surface).toBe("working-tree");
    expect(patchset.intent?.prBodyAbsent).toBe(true);
    expect(patchset.intent?.prBody).toBeUndefined();
    // The available surface is the commit subjects between base and head.
    expect(patchset.intent?.commitSubjects).toContain("add the branch file");
    // The changeset's spec doc is snapshotted from the working-tree content.
    const snap = patchset.intent?.specSnapshots?.find((s) => s.path === "specs/spec.md");
    expect(snap?.content).toBe("# Spec\n\nthe rule\n");
    expect(snap?.digest.length).toBe(64);
  });

  it("marks the intent absent-of-PR-body even when there are no commits since base", async () => {
    const root = repository();
    // Only an uncommitted working-tree edit: no commits between base and head.
    writeFileSync(join(root, "tracked.txt"), "after\n");
    const patchset = await new GitCaptureAdapter().capture(root);
    expect(patchset.intent?.surface).toBe("working-tree");
    expect(patchset.intent?.prBodyAbsent).toBe(true);
    expect(patchset.intent?.commitSubjects).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // #729 / D6 — app-owned board artifacts never enter a working-tree capture.
  //
  // The fixture deliberately has NO `.rennet` ignore rule, because that is the
  // repository the bug lived in: Rennet wrote a board, the next capture picked it up,
  // and the review invalidated itself. Everything else under `.rennet` is the user's
  // and still captures — that asymmetry is the requirement, not a side effect.
  // ───────────────────────────────────────────────────────────────────────────
  it("excludes app-owned board artifacts from files, raw diff and the reviewed tree", async () => {
    const root = repository();
    // Tracked project content under `.rennet`, plus the prefix-boundary directory.
    mkdirSync(join(root, ".rennet", "boards-extra"), { recursive: true });
    writeFileSync(join(root, ".rennet", "conventions.json"), '{"rules":[]}\n');
    writeFileSync(join(root, ".rennet", "boards-extra", "notes.md"), "mine\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "project content under .rennet");
    git(root, "checkout", "-qb", "feature");

    // The change under review.
    writeFileSync(join(root, "tracked.txt"), "after\n");
    writeFileSync(join(root, ".rennet", "conventions.json"), '{"rules":["one"]}\n');
    writeFileSync(join(root, ".rennet", "boards-extra", "notes.md"), "mine, edited\n");

    // Board artifacts in all three states a repository without an ignore rule reaches.
    mkdirSync(join(root, ".rennet", "boards", "gen-1"), { recursive: true });
    writeFileSync(join(root, ".rennet", "boards", "untracked.jsonl"), '{"seq":1}\n');
    writeFileSync(join(root, ".rennet", "boards", "gen-1", "staged.jsonl"), '{"seq":2}\n');
    git(root, "add", join(".rennet", "boards", "gen-1", "staged.jsonl"));
    writeFileSync(join(root, ".rennet", "boards", "committed.jsonl"), '{"seq":3}\n');
    git(root, "add", "-f", join(".rennet", "boards", "committed.jsonl"));
    git(root, "commit", "-qm", "a board that got committed");

    const patchset = await new GitCaptureAdapter().capture(root);
    const paths = patchset.files.map((file) => file.path);

    // No board artifact in the file list, in any state.
    expect(paths).toEqual([
      ".rennet/boards-extra/notes.md",
      ".rennet/conventions.json",
      "tracked.txt",
    ]);
    expect(patchset.rawDiff).not.toContain(".rennet/boards/");
    expect(patchset.rawDiff).not.toContain('{"seq":');
    // …nor in the reviewed tree, which is where identity and every lens read come from.
    const reviewedTree = patchset.repository.reviewedTreeOid;
    if (reviewedTree === undefined) throw new Error("capture omitted reviewedTreeOid");
    const treePaths = git(root, "ls-tree", "-r", "--name-only", reviewedTree).trim().split("\n");
    expect(treePaths.filter((path) => path.startsWith(".rennet/boards/"))).toEqual([]);
    // The user's content under `.rennet` is all still there — tracked means intentional.
    expect(treePaths).toContain(".rennet/conventions.json");
    expect(treePaths).toContain(".rennet/boards-extra/notes.md");
    expect(patchset.rawDiff).toContain("boards-extra");
  });

  it("keeps identity stable when Rennet writes a board, and moves it when the user edits", async () => {
    const root = repository();
    mkdirSync(join(root, ".rennet"), { recursive: true });
    writeFileSync(join(root, ".rennet", "conventions.json"), '{"rules":[]}\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "house rules");
    writeFileSync(join(root, "tracked.txt"), "after\n");

    const adapter = new GitCaptureAdapter();
    const pinned = await adapter.capture(root);

    // Rennet writes a board into the review's own repository. This is the #729 harm:
    // the app invalidating the review it is drafting.
    mkdirSync(join(root, ".rennet", "boards", "gen-1"), { recursive: true });
    writeFileSync(join(root, ".rennet", "boards", "gen-1", "events.jsonl"), '{"seq":1}\n');
    const afterBoardWrite = await adapter.capture(root);
    expect(afterBoardWrite.id).toBe(pinned.id);
    expect(afterBoardWrite.repository.reviewedTreeOid).toBe(pinned.repository.reviewedTreeOid);

    // POSITIVE CONTROL 1 — a reviewed source file changes, so identity must move.
    writeFileSync(join(root, "tracked.txt"), "edited again\n");
    const afterSourceEdit = await adapter.capture(root);
    expect(afterSourceEdit.id).not.toBe(pinned.id);

    // POSITIVE CONTROL 2 — a TRACKED `.rennet` project file changes, so identity must
    // move too. Excluding all of `.rennet` would pass every assertion above and fail
    // this one, which is exactly the shortcut D6 forbids.
    writeFileSync(join(root, "tracked.txt"), "after\n");
    expect((await adapter.capture(root)).id).toBe(pinned.id);
    writeFileSync(join(root, ".rennet", "conventions.json"), '{"rules":["one"]}\n');
    const afterConventionsEdit = await adapter.capture(root);
    expect(afterConventionsEdit.id).not.toBe(pinned.id);
    expect(afterConventionsEdit.files.map((file) => file.path)).toContain(
      ".rennet/conventions.json",
    );
  });

  it("does not render a board file committed at the BASE as a deletion", async () => {
    const root = repository();
    // The board landed on the base branch — a repository with no ignore rule and a
    // `git add -A` habit. Sanitizing the reviewed tree alone would show it deleted.
    mkdirSync(join(root, ".rennet", "boards"), { recursive: true });
    writeFileSync(join(root, ".rennet", "boards", "old.jsonl"), '{"seq":1}\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "board committed on main");
    git(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "tracked.txt"), "after\n");

    const patchset = await new GitCaptureAdapter().capture(root);
    expect(patchset.files.map((file) => file.path)).toEqual(["tracked.txt"]);
    expect(patchset.rawDiff).not.toContain("old.jsonl");
  });

  it("marks a visible diff as truncated without changing its content identity", async () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "x".repeat(1024));
    const patchset = await new GitCaptureAdapter(64).capture(root);
    expect(patchset.truncated).toBe(true);
    expect(Buffer.byteLength(patchset.rawDiff)).toBeGreaterThan(64);
  });
});
