import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  execaGit,
  type GitExec,
  gitForRepoFactory,
  listWorkspaces,
  removeWorkspace,
} from "@rennet/adapters";
import { detectLocus, locusCommand } from "@rennet/core";
import type { WorktreeInventory, WorktreeRemoveOutcome } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createDispatch, type DispatchDeps } from "./index";

// The two inventory commands driven through the real router, over real temporary git
// repositories: the refusals below are git's own bytes crossing the wire schema, not a
// fake's idea of what git would say.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** A repository on `feat/x`, plus a Rennet worktree root holding one branch worktree. */
function fixture(): { root: string; worktreeRoot: string; branchWorktree: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-wtcmd-"));
  const dataDir = mkdtempSync(join(tmpdir(), "rennet-wtcmd-data-"));
  scratch.push(root, dataDir);
  git(root, "init", "-q", "-b", "feat/x");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const worktreeRoot = join(dataDir, "worktrees");
  const branchWorktree = join(worktreeRoot, "repo-key", "feat", "y");
  mkdirSync(join(branchWorktree, ".."), { recursive: true });
  git(root, "worktree", "add", "-q", "-b", "feat/y", branchWorktree, "feat/x");
  return { root, worktreeRoot, branchWorktree };
}

/**
 * The composition `create-server.ts` builds, with its own resolved root and session set —
 * git resolved PER REPOSITORY PATH, which is what carries a WSL repository's calls into
 * its own distro.
 */
function deps(
  worktreeRoot: string,
  sessions: { id: string; boundRoot?: string; archivedAt?: number }[] = [],
  gitFor: (repoPath: string) => GitExec = () => execaGit,
): DispatchDeps {
  return {
    worktrees: {
      list: (repoPath: string) =>
        listWorkspaces(gitFor(repoPath), repoPath, { root: worktreeRoot, sessions }),
      remove: async ({ repoPath, path }: { repoPath: string; path: string }) => {
        const { rows } = await listWorkspaces(gitFor(repoPath), repoPath, {
          root: worktreeRoot,
          sessions,
          measureSizes: false,
        });
        return removeWorkspace(gitFor(repoPath), repoPath, { path, rows });
      },
    },
  } as unknown as DispatchDeps;
}

describe("worktrees.list", () => {
  it("lists this repository's workspaces, keyed by its path", async () => {
    const { root, worktreeRoot } = fixture();
    const dispatch = createDispatch(deps(worktreeRoot, [{ id: "s1", boundRoot: root }]));

    const inventory = (await dispatch("worktrees.list", { repoPath: root })) as WorktreeInventory;

    expect(inventory.truncated).toBe(false);
    expect(inventory.rows.map((row) => row.kind).sort()).toEqual(["branch", "own-checkout"]);
    expect(inventory.rows.find((row) => row.kind === "branch")?.path).toContain(
      join("repo-key", "feat", "y"),
    );
    expect(inventory.rows.find((row) => row.kind === "branch")?.ref).toBe("feat/y");
    expect(inventory.rows.find((row) => row.kind === "own-checkout")?.sessionIds).toEqual(["s1"]);
  });

  it("answers an honestly empty list when no inventory seam is wired", async () => {
    const dispatch = createDispatch({} as DispatchDeps);
    expect(await dispatch("worktrees.list", { repoPath: "/nowhere" })).toEqual({
      rows: [],
      truncated: false,
    });
  });

  it("runs its git through the repository's own locus (a WSL repo asks the distro's git)", async () => {
    const commands: ReturnType<typeof locusCommand>[] = [];
    const runnerForLocus =
      (locus: ReturnType<typeof detectLocus>): GitExec =>
      async (repoRoot, args) => {
        commands.push(locusCommand(locus, "git", args, repoRoot));
        return "";
      };
    const wslRoot = "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo";
    const dispatch = createDispatch(
      deps("/data/worktrees", [], gitForRepoFactory(detectLocus, runnerForLocus)),
    );

    await dispatch("worktrees.list", { repoPath: wslRoot });

    expect(commands).toEqual([
      {
        file: "wsl.exe",
        args: [
          "-d",
          "Ubuntu",
          "--cd",
          "/home/rai/repo",
          "-e",
          "git",
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ],
      },
    ]);
  });
});

describe("worktrees.remove", () => {
  it("removes an idle Rennet worktree on the first call, with no confirmation step", async () => {
    const { root, worktreeRoot, branchWorktree } = fixture();
    const dispatch = createDispatch(deps(worktreeRoot));

    const outcome = (await dispatch("worktrees.remove", {
      repoPath: root,
      path: branchWorktree,
    })) as WorktreeRemoveOutcome;

    expect(outcome.status).toBe("removed");
    expect(existsSync(branchWorktree)).toBe(false);
  });

  it("returns git's refusal verbatim for a dirty worktree, and leaves the directory", async () => {
    const { root, worktreeRoot, branchWorktree } = fixture();
    writeFileSync(join(branchWorktree, "a.txt"), "uncommitted\n");
    const dispatch = createDispatch(deps(worktreeRoot));

    const outcome = (await dispatch("worktrees.remove", {
      repoPath: root,
      path: branchWorktree,
    })) as WorktreeRemoveOutcome;

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/contains modified/);
    // The refusal is git's sentence, not a Rennet paraphrase of it.
    expect(outcome.status === "refused" && outcome.reason).toContain(branchWorktree);
    expect(existsSync(join(branchWorktree, "a.txt"))).toBe(true);
  });

  it("cannot address the reviewer's own checkout", async () => {
    const { root, worktreeRoot } = fixture();
    const dispatch = createDispatch(deps(worktreeRoot, [{ id: "s1", boundRoot: root }]));

    const outcome = (await dispatch("worktrees.remove", {
      repoPath: root,
      path: root,
    })) as WorktreeRemoveOutcome;

    expect(outcome).toMatchObject({ status: "not-removable", reason: "your own checkout" });
    expect(existsSync(join(root, "a.txt"))).toBe(true);
  });
});
