import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_LOCUS } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import { observeRoundCommits } from "./round-execution-effects";

const tempRoots: string[] = [];

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execaGit(root, args)).trim();
}

async function createRepo(): Promise<{ root: string; tempRoot: string; baseHead: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "rennet-round-effects-"));
  tempRoots.push(tempRoot);
  const root = join(tempRoot, "repo");
  await mkdir(root);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Rennet Test");
  await git(root, "config", "user.email", "rennet-test@example.invalid");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "base");
  return { root, tempRoot, baseHead: await git(root, "rev-parse", "HEAD") };
}

async function commitFile(root: string, path: string, content: string): Promise<string> {
  await writeFile(join(root, path), content);
  await git(root, "add", path);
  await git(root, "commit", "-m", `change ${path}`);
  return git(root, "rev-parse", "HEAD");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("round commit observation", () => {
  it.each([0, 2])("counts %i commits the worker left on the bound root", async (expectedCount) => {
    const repo = await createRepo();
    if (expectedCount === 2) {
      await commitFile(repo.root, "one.txt", "one\n");
      await commitFile(repo.root, "two.txt", "two\n");
    }
    const input = {
      git: execaGit,
      root: repo.root,
      executionId: "commit-attempt",
      baseHead: repo.baseHead,
      startedAt: 100,
      now: () => 150,
    };
    const settled = await observeRoundCommits(input);
    expect(settled).toEqual(
      expect.objectContaining({
        baseHead: repo.baseHead,
        from: repo.baseHead,
        count: expectedCount,
        committedAt: 150,
        durationMs: 50,
      }),
    );
    const headAfter = await git(repo.root, "rev-parse", "HEAD");
    const repeated = await observeRoundCommits(input);
    expect(repeated.count).toBe(expectedCount);
    expect(repeated.to).toBe(headAfter);
    expect(await git(repo.root, "rev-parse", "HEAD")).toBe(headAfter);
  });

  // The rule this file exists to hold: Rennet never stages or commits in the reviewer's
  // own checkout on their behalf (session-bound-workspace). An uncommitted worker edit
  // and an untracked stray both survive the observation untouched, and the round reads as
  // zero commits — which the coordinator turns into an honest failure, not a blanket add.
  it("never stages or commits what the worker left uncommitted", async () => {
    const repo = await createRepo();
    await writeFile(join(repo.root, "worker.txt"), "uncommitted worker output\n");
    await writeFile(join(repo.root, "stray.txt"), "someone else's file\n");

    const settled = await observeRoundCommits({
      git: execaGit,
      root: repo.root,
      executionId: "commit-attempt",
      baseHead: repo.baseHead,
      startedAt: 100,
    });

    expect(settled.count).toBe(0);
    expect(settled.to).toBe(repo.baseHead);
    expect(await git(repo.root, "rev-parse", "HEAD")).toBe(repo.baseHead);
    expect(await git(repo.root, "status", "--porcelain")).toContain("?? stray.txt");
    expect(await readFile(join(repo.root, "worker.txt"), "utf8")).toBe(
      "uncommitted worker output\n",
    );
  });
});
