import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesTouchedByDiff } from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureReviewedTree, GitCheckpointStore, repoHasSubmodules } from "./checkpoint-store";

// win32 git operations on a cold disk exceed vitest's 5s default (measured 6-11s on
// lancelot); give this git-heavy suite room. Not a hang — the same tests pass fast on
// macOS/Linux and complete well under this ceiling on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const directories: string[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trimEnd();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-checkpoint-"));
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

describe("GitCheckpointStore", () => {
  it("brackets a change and extracts the turn diff between two checkpoints", async () => {
    const root = repository();
    const store = new GitCheckpointStore(root);

    const before = await store.capture();
    // The "agent turn": modify a tracked file and add an untracked one.
    writeFileSync(join(root, "tracked.txt"), "after\n");
    writeFileSync(join(root, "new.ts"), "export const x = 1;\n");
    const after = await store.capture();

    const diff = await store.diff(before, after);
    expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
    expect(diff).toContain("diff --git a/new.ts b/new.ts");
    expect(filesTouchedByDiff(diff).sort()).toEqual(["new.ts", "tracked.txt"]);
  });

  it("respects .gitignore (an ignored file is not in the snapshot)", async () => {
    const root = repository();
    const store = new GitCheckpointStore(root);
    writeFileSync(join(root, ".gitignore"), "secret.env\n");

    const before = await store.capture();
    writeFileSync(join(root, "secret.env"), "TOKEN=xyz\n");
    writeFileSync(join(root, "kept.ts"), "ok\n");
    const after = await store.capture();

    const diff = await store.diff(before, after);
    expect(diff).toContain("kept.ts");
    expect(diff).not.toContain("secret.env");
  });

  it("writes only HIDDEN refs — HEAD, the branch, and the reflog stay clean", async () => {
    const root = repository();
    const store = new GitCheckpointStore(root);
    const headBefore = git(root, "rev-parse", "HEAD");
    const branchesBefore = git(root, "branch", "--format=%(refname)");
    const logCountBefore = git(root, "rev-list", "--count", "HEAD");

    writeFileSync(join(root, "tracked.txt"), "changed\n");
    const ref = await store.capture();

    // HEAD unmoved, no new branch, no new commit on the branch.
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(root, "branch", "--format=%(refname)")).toBe(branchesBefore);
    expect(git(root, "rev-list", "--count", "HEAD")).toBe(logCountBefore);
    // The checkpoint lives under refs/rennet/, invisible to `git branch`.
    expect(ref.ref.startsWith("refs/rennet/checkpoints/")).toBe(true);
    expect(git(root, "for-each-ref", "--format=%(refname)", "refs/rennet/")).toContain(ref.ref);
    // The reflog for HEAD did not grow (the checkpoint did not touch HEAD).
    const reflog = execFileSync("git", ["reflog", "show", "HEAD"], { cwd: root, encoding: "utf8" });
    expect(reflog.split("\n").filter((line) => line.includes("rennet")).length).toBe(0);
  });

  it("does NOT touch the user's real git index (their staging area is preserved)", async () => {
    const root = repository();
    const store = new GitCheckpointStore(root);
    // The user has staged one file and left another unstaged.
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    writeFileSync(join(root, "tracked.txt"), "unstaged change\n");
    const statusBefore = git(root, "status", "--porcelain");

    await store.capture();

    // The temp-index snapshot left the real index exactly as it was.
    expect(git(root, "status", "--porcelain")).toBe(statusBefore);
  });

  it("captures a clean tree as an empty turn diff", async () => {
    const root = repository();
    const store = new GitCheckpointStore(root);
    const before = await store.capture();
    const after = await store.capture();
    expect(await store.diff(before, after)).toBe("");
  });

  it("discards a checkpoint ref", async () => {
    const root = repository();
    const store = new GitCheckpointStore(root);
    const ref = await store.capture();
    await store.discard(ref);
    expect(git(root, "for-each-ref", "--format=%(refname)", "refs/rennet/")).not.toContain(ref.ref);
  });
});

describe("captureReviewedTree", () => {
  it("pins the complete capture without moving HEAD or changing the real index", async () => {
    const root = repository();
    const headBefore = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, ".gitignore"), "forced.txt\n");
    writeFileSync(join(root, "forced.txt"), "force-added before capture\n");
    git(root, "add", ".gitignore");
    git(root, "add", "-f", "forced.txt");
    writeFileSync(join(root, "tracked.txt"), "working tree before capture\n");
    writeFileSync(join(root, "untracked-before.txt"), "present before capture\n");
    const statusBefore = git(root, "status", "--porcelain=v1", "-z");
    const indexTreeBefore = git(root, "write-tree");

    const reviewedTree = await captureReviewedTree(root);
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(root, "write-tree")).toBe(indexTreeBefore);
    expect(git(root, "status", "--porcelain=v1", "-z")).toBe(statusBefore);

    writeFileSync(join(root, "tracked.txt"), "working tree after capture\n");
    writeFileSync(join(root, "untracked-before.txt"), "changed after capture\n");
    writeFileSync(join(root, "untracked-after.txt"), "created after capture\n");

    expect(git(root, "show", `${reviewedTree}:tracked.txt`)).toBe("working tree before capture");
    expect(git(root, "show", `${reviewedTree}:untracked-before.txt`)).toBe(
      "present before capture",
    );
    expect(git(root, "show", `${reviewedTree}:forced.txt`)).toBe("force-added before capture");
    expect(git(root, "ls-tree", "-r", "--name-only", reviewedTree)).not.toContain(
      "untracked-after.txt",
    );
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(root, "write-tree")).toBe(indexTreeBefore);
    expect(git(root, "rev-parse", `refs/rennet/review-trees/${reviewedTree}^{tree}`)).toBe(
      reviewedTree,
    );
  });
});

describe("GitCheckpointStore.changedPaths + F5/F6/F7", () => {
  // A TAB (0x09) in a filename is legal on POSIX but forbidden by the Windows
  // filesystem, so the file cannot even be created there — the git-quoting behavior under
  // test is unreachable on win32. Scope to POSIX rather than weaken the assertion.
  it.skipIf(process.platform === "win32")(
    "changedPaths returns a path with a TAB intact where the display diff quotes it (F7)",
    async () => {
      const root = repository();
      const store = new GitCheckpointStore(root);
      // A tab in the filename is exactly what git C-quotes in the `diff --git` header.
      const tabbedName = "weird\tname.ts";
      const before = await store.capture();
      writeFileSync(join(root, tabbedName), "x\n");
      const after = await store.capture();

      // The display diff C-quotes the path (`diff --git "a/…" "b/…"`), so parsing the
      // header drops the file — the exact F7 defect.
      const diff = await store.diff(before, after);
      expect(filesTouchedByDiff(diff)).not.toContain(tabbedName);
      // The structural changedPaths (`--name-only -z`) returns it intact.
      expect(await store.changedPaths(before, after)).toContain(tabbedName);
    },
  );

  it("does NOT write a reflog for the checkpoint ref even when core.logAllRefUpdates=always (F5)", async () => {
    const root = repository();
    git(root, "config", "core.logAllRefUpdates", "always");
    const store = new GitCheckpointStore(root);
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    const ref = await store.capture();
    // No reflog exists for the hidden checkpoint ref (`git reflog show` exits non-zero
    // and prints nothing when the ref has no log — which is exactly what we want).
    let reflog: string;
    try {
      reflog = execFileSync("git", ["reflog", "show", ref.ref], { cwd: root, encoding: "utf8" });
    } catch {
      reflog = "";
    }
    expect(reflog.trim()).toBe("");
  });

  it("discard is best-effort — deleting an already-gone ref does not throw", async () => {
    const root = repository();
    const store = new GitCheckpointStore(root);
    const ref = await store.capture();
    await store.discard(ref);
    await expect(store.discard(ref)).resolves.toBeUndefined(); // second discard: no throw
  });

  it("repoHasSubmodules is false for a plain repository (F6)", async () => {
    const root = repository();
    expect(await repoHasSubmodules(root)).toBe(false);
  });
});
