import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCaptureAdapter } from "./git-capture";

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
    rmSync(directory, { recursive: true, force: true });
});

describe("GitCaptureAdapter", () => {
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

  it("marks a visible diff as truncated without changing its content identity", async () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "x".repeat(1024));
    const patchset = await new GitCaptureAdapter(64).capture(root);
    expect(patchset.truncated).toBe(true);
    expect(Buffer.byteLength(patchset.rawDiff)).toBeGreaterThan(64);
  });
});
