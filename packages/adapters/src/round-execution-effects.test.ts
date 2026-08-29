import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_LOCUS } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  createOrAdoptRoundSourceCommit,
  inspectRoundWorktree,
  landRoundChanges,
  prepareRoundWorkspace,
  prepareRoundWorktree,
  RoundLandingConflictError,
  RoundSourceRefMismatchError,
  RoundWorktreeDirtyError,
  RoundWorktreeMismatchError,
  releaseRoundSourceCommit,
  removeRoundWorktree,
  roundSourceRef,
  roundWorktreeGitPath,
  runConfiguredRoundGate,
  settleRoundCommits,
} from "./round-execution-effects";

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

describe("round detached worktree", () => {
  it("creates an isolated detached worktree and adopts the exact reservation", async () => {
    const repo = await createRepo();
    const worktreePath = join(repo.tempRoot, "rounds", "operation-1", "worktree");
    const input = {
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      worktreePath,
      sourceHead: repo.baseHead,
    };

    await expect(prepareRoundWorktree(input)).resolves.toEqual({
      path: worktreePath,
      head: repo.baseHead,
      created: true,
    });
    await expect(prepareRoundWorktree(input)).resolves.toEqual({
      path: worktreePath,
      head: repo.baseHead,
      created: false,
    });
    expect(await git(worktreePath, "symbolic-ref", "--quiet", "HEAD").catch(() => "")).toBe("");

    await writeFile(join(worktreePath, "base.txt"), "worker\n");
    expect(await readFile(join(repo.root, "base.txt"), "utf8")).toBe("base\n");
  });

  it("refuses a worktree whose detached HEAD no longer matches without replacing it", async () => {
    const repo = await createRepo();
    const worktreePath = join(repo.tempRoot, "round-worktree");
    const input = {
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      worktreePath,
      sourceHead: repo.baseHead,
    };
    await prepareRoundWorktree(input);
    const advancedHead = await git(
      worktreePath,
      "commit",
      "--allow-empty",
      "-m",
      "worker commit",
    ).then(() => git(worktreePath, "rev-parse", "HEAD"));

    await expect(inspectRoundWorktree(input)).resolves.toEqual({
      kind: "mismatch",
      reason: "different-head",
      expectedHead: repo.baseHead,
      actualHead: advancedHead,
    });
    await expect(prepareRoundWorktree(input)).rejects.toBeInstanceOf(RoundWorktreeMismatchError);
    expect(await git(worktreePath, "rev-parse", "HEAD")).toBe(advancedHead);
  });

  it("never force-removes a dirty operation worktree", async () => {
    const repo = await createRepo();
    const worktreePath = join(repo.tempRoot, "round-worktree");
    const input = {
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      worktreePath,
      sourceHead: repo.baseHead,
    };
    await prepareRoundWorktree(input);
    await writeFile(join(worktreePath, "dirty.txt"), "keep me\n");

    await expect(removeRoundWorktree(input)).rejects.toBeInstanceOf(RoundWorktreeDirtyError);
    expect(await readFile(join(worktreePath, "dirty.txt"), "utf8")).toBe("keep me\n");
  });

  it("never removes a checkout from a different repository", async () => {
    const repo = await createRepo();
    const other = await createRepo();

    await expect(
      removeRoundWorktree({
        git: execaGit,
        locus: HOST_LOCUS,
        repoRoot: repo.root,
        worktreePath: other.root,
        sourceHead: repo.baseHead,
      }),
    ).rejects.toBeInstanceOf(RoundWorktreeMismatchError);
    expect(await readFile(join(other.root, "base.txt"), "utf8")).toBe("base\n");
  });
});

describe("round source commit", () => {
  it("prepares the persisted reviewed tree when it differs from the checkout HEAD", async () => {
    const repo = await createRepo();
    await writeFile(join(repo.root, "dirty-reviewed.txt"), "reviewed before dispatch\n");
    await git(repo.root, "add", "dirty-reviewed.txt");
    const sourceTreeOid = await git(repo.root, "write-tree");
    const attempt = {
      kind: "detached-worktree",
      worktreePath: join(repo.tempRoot, "round-worktree"),
      sourceTreeOid,
      sourceParentHead: repo.baseHead,
      startedAt: 10,
    } as const;

    const prepared = await prepareRoundWorkspace({
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      operationId: "dirty-reviewed-operation",
      attempt,
      now: () => 20,
    });

    expect(prepared).toEqual({
      ...attempt,
      sourceHead: expect.any(String),
      preparedAt: 20,
    });
    expect(prepared.sourceHead).not.toBe(repo.baseHead);
    expect(await git(attempt.worktreePath, "rev-parse", "HEAD^{tree}")).toBe(sourceTreeOid);
    expect(await git(attempt.worktreePath, "rev-parse", "HEAD^")).toBe(repo.baseHead);
    expect(await readFile(join(attempt.worktreePath, "dirty-reviewed.txt"), "utf8")).toBe(
      "reviewed before dispatch\n",
    );
    expect(await git(repo.root, "rev-parse", "HEAD")).toBe(repo.baseHead);

    const recovered = await prepareRoundWorkspace({
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      operationId: "dirty-reviewed-operation",
      attempt,
      now: () => 30,
    });
    expect(recovered.sourceHead).toBe(prepared.sourceHead);
  });

  it("adopts the deterministic ref for the same tree and replaces only its own stale ref", async () => {
    const repo = await createRepo();
    const treeOid = await git(repo.root, "rev-parse", `${repo.baseHead}^{tree}`);
    const input = {
      git: execaGit,
      repoRoot: repo.root,
      operationId: "operation/with unsafe ref bytes",
      treeOid,
      parentHead: repo.baseHead,
    };
    await git(repo.root, "update-ref", roundSourceRef(input.operationId), treeOid);
    const created = await createOrAdoptRoundSourceCommit(input);
    const adopted = await createOrAdoptRoundSourceCommit(input);
    expect(adopted).toEqual({ ...created, created: false });

    await writeFile(join(repo.root, "reviewed.txt"), "reviewed tree\n");
    await git(repo.root, "add", "reviewed.txt");
    const replacement = await createOrAdoptRoundSourceCommit({
      ...input,
      treeOid: await git(repo.root, "write-tree"),
    });
    expect(replacement.ref).toBe(created.ref);
    expect(replacement.commit).not.toBe(created.commit);
    await expect(
      releaseRoundSourceCommit({ ...input, commit: created.commit }),
    ).rejects.toBeInstanceOf(RoundSourceRefMismatchError);
    await expect(
      releaseRoundSourceCommit({ ...input, commit: replacement.commit }),
    ).resolves.toEqual({ released: true });
    await expect(
      releaseRoundSourceCommit({ ...input, commit: replacement.commit }),
    ).resolves.toEqual({ released: false });
  });
});

describe("configured round gate", () => {
  it("returns the real zero exit, timing, and Nx project count", async () => {
    const repo = await createRepo();
    const ticks = [135];
    const result = await runConfiguredRoundGate({
      locus: HOST_LOCUS,
      cwd: repo.root,
      command: "printf 'Successfully ran targets test for 4 projects\\n'",
      executionId: "gate-1",
      startedAt: 100,
      now: () => ticks.shift() ?? 135,
    });

    expect(result).toEqual(
      expect.objectContaining({
        outcome: "passed",
        exitCode: 0,
        executionId: "gate-1",
        startedAt: 100,
        completedAt: 135,
        durationMs: 35,
        projectCount: 4,
      }),
    );
  });

  it("returns the real nonzero exit", async () => {
    const repo = await createRepo();
    const result = await runConfiguredRoundGate({
      locus: HOST_LOCUS,
      cwd: repo.root,
      command: "exit 7",
      executionId: "gate-2",
      startedAt: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({
        outcome: "failed",
        termination: { kind: "exit", exitCode: 7 },
      }),
    );
  });
});

describe("round commit settlement", () => {
  it.each([0, 1, 2])("counts %i commits from the persisted base", async (expectedCount) => {
    const repo = await createRepo();
    const worktreePath = join(repo.tempRoot, "round-worktree");
    await prepareRoundWorktree({
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      worktreePath,
      sourceHead: repo.baseHead,
    });
    if (expectedCount === 1) {
      await writeFile(join(worktreePath, "worker.txt"), "uncommitted worker output\n");
    }
    if (expectedCount === 2) {
      await commitFile(worktreePath, "one.txt", "one\n");
      await commitFile(worktreePath, "two.txt", "two\n");
    }

    const input = {
      git: execaGit,
      worktreePath,
      executionId: "commit-attempt",
      baseHead: repo.baseHead,
      startedAt: 100,
      now: () => 150,
    };
    const settled = await settleRoundCommits(input);
    expect(settled).toEqual(
      expect.objectContaining({
        baseHead: repo.baseHead,
        from: repo.baseHead,
        count: expectedCount,
        committedAt: 150,
        durationMs: 50,
      }),
    );
    const headAfterFirstSettlement = await git(worktreePath, "rev-parse", "HEAD");
    const repeated = await settleRoundCommits(input);
    expect(repeated.count).toBe(expectedCount);
    expect(repeated.to).toBe(headAfterFirstSettlement);
    expect(await git(worktreePath, "rev-parse", "HEAD")).toBe(headAfterFirstSettlement);
  });
});

describe("round landing", () => {
  it("applies only the worker delta without moving the source branch or dropping source edits", async () => {
    const repo = await createRepo();
    await writeFile(join(repo.root, "initial-source-edit.txt"), "kept\n");
    await git(repo.root, "add", "initial-source-edit.txt");
    const source = await createOrAdoptRoundSourceCommit({
      git: execaGit,
      repoRoot: repo.root,
      operationId: "landing-operation",
      treeOid: await git(repo.root, "write-tree"),
      parentHead: repo.baseHead,
    });
    const worktreePath = join(repo.tempRoot, "round-worktree");
    await prepareRoundWorktree({
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      worktreePath,
      sourceHead: source.commit,
    });
    await commitFile(worktreePath, "worker.txt", "worker output\n");
    await writeFile(join(repo.root, "mid-run-source-edit.txt"), "also kept\n");
    const sourceBranchHead = await git(repo.root, "rev-parse", "HEAD");

    const landed = await landRoundChanges({
      git: execaGit,
      locus: HOST_LOCUS,
      sourceRoot: repo.root,
      worktreePath,
      baselineCommit: source.commit,
    });

    expect(landed).toEqual(
      expect.objectContaining({ outcome: "applied", applied: true, changedPaths: ["worker.txt"] }),
    );
    expect(await readFile(join(repo.root, "worker.txt"), "utf8")).toBe("worker output\n");
    expect(await readFile(join(repo.root, "initial-source-edit.txt"), "utf8")).toBe("kept\n");
    expect(await readFile(join(repo.root, "mid-run-source-edit.txt"), "utf8")).toBe("also kept\n");
    expect(await git(repo.root, "rev-parse", "HEAD")).toBe(sourceBranchHead);
    expect(await git(worktreePath, "rev-parse", "HEAD")).not.toBe(sourceBranchHead);

    const recovered = await landRoundChanges({
      git: execaGit,
      locus: HOST_LOCUS,
      sourceRoot: repo.root,
      worktreePath,
      baselineCommit: source.commit,
    });
    expect(recovered).toEqual(
      expect.objectContaining({
        outcome: "already-applied",
        applied: false,
        changedPaths: ["worker.txt"],
      }),
    );
    expect(await readFile(join(repo.root, "worker.txt"), "utf8")).toBe("worker output\n");
  });

  it("fails at apply-check without partially changing a conflicting source checkout", async () => {
    const repo = await createRepo();
    const source = await createOrAdoptRoundSourceCommit({
      git: execaGit,
      repoRoot: repo.root,
      operationId: "conflict-operation",
      treeOid: await git(repo.root, "rev-parse", `${repo.baseHead}^{tree}`),
      parentHead: repo.baseHead,
    });
    const worktreePath = join(repo.tempRoot, "round-worktree");
    await prepareRoundWorktree({
      git: execaGit,
      locus: HOST_LOCUS,
      repoRoot: repo.root,
      worktreePath,
      sourceHead: source.commit,
    });
    await writeFile(join(worktreePath, "base.txt"), "worker version\n");
    await settleRoundCommits({
      git: execaGit,
      worktreePath,
      executionId: "commit-attempt",
      baseHead: source.commit,
      startedAt: 1,
    });
    await writeFile(join(repo.root, "base.txt"), "source version\n");

    await expect(
      landRoundChanges({
        git: execaGit,
        locus: HOST_LOCUS,
        sourceRoot: repo.root,
        worktreePath,
        baselineCommit: source.commit,
      }),
    ).rejects.toBeInstanceOf(RoundLandingConflictError);
    expect(await readFile(join(repo.root, "base.txt"), "utf8")).toBe("source version\n");
  });
});

describe("round worktree path locus", () => {
  it("passes host paths unchanged and translates WSL UNC paths for git argv", () => {
    expect(roundWorktreeGitPath(HOST_LOCUS, "/repo-round")).toBe("/repo-round");
    expect(
      roundWorktreeGitPath(
        { kind: "wsl", distro: "Ubuntu" },
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\round",
      ),
    ).toBe("/home/rai/round");
  });
});
