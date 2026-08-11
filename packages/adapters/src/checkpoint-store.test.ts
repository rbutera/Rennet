import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesTouchedByDiff } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { GitCheckpointStore } from "./checkpoint-store";

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
    rmSync(directory, { recursive: true, force: true });
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
