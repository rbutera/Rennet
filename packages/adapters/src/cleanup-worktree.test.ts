import { describe, expect, it, vi } from "vitest";
import { cleanupWorktree } from "./cleanup-worktree";
import type { GitExec } from "./git-range-diff";

describe("cleanupWorktree", () => {
  it("runs `git worktree remove <path>` from the project root and reports ok", async () => {
    const git = vi.fn<GitExec>(async () => "");
    const result = await cleanupWorktree(
      { git, resolveProjectRoot: async () => "/repo" },
      { projectId: "p1", worktreeId: "/wt/feat-x" },
    );
    expect(result).toEqual({ ok: true });
    expect(git).toHaveBeenCalledWith("/repo", ["worktree", "remove", "/wt/feat-x"], {
      reject: true,
    });
  });

  it("does NOT force: a git refusal (dirty/locked worktree) reports ok:false, sweeps nothing", async () => {
    const git: GitExec = async (_root, args) => {
      if (args[0] === "worktree")
        throw new Error("contains modified or untracked files, use --force");
      return "";
    };
    const result = await cleanupWorktree(
      { git, resolveProjectRoot: async () => "/repo" },
      { projectId: "p1", worktreeId: "/wt/dirty" },
    );
    expect(result).toEqual({ ok: false });
  });

  it("reports ok:false when the project root cannot be resolved (never runs git)", async () => {
    const git = vi.fn<GitExec>(async () => "");
    const result = await cleanupWorktree(
      { git, resolveProjectRoot: async () => null },
      { projectId: "unknown", worktreeId: "/wt/x" },
    );
    expect(result).toEqual({ ok: false });
    expect(git).not.toHaveBeenCalled();
  });

  it("never passes --force to git (uncommitted work is never discarded)", async () => {
    const git = vi.fn<GitExec>(async () => "");
    await cleanupWorktree(
      { git, resolveProjectRoot: async () => "/repo" },
      { projectId: "p1", worktreeId: "/wt/x" },
    );
    const args = git.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain("--force");
    expect(args).not.toContain("-f");
  });
});
