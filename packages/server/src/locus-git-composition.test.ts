import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type GitExec, gitForRepoFactory } from "@rennet/adapters";
import { detectLocus, locusCommand } from "@rennet/core";
import { describe, expect, it } from "vitest";

const WSL_ROOT = "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo";

describe("desktop repo-facing git composition", () => {
  it.each([
    ["PR open", ["rev-parse", "HEAD"]],
    ["project discovery", ["rev-parse", "--show-toplevel"]],
    ["project detail", ["worktree", "list", "--porcelain", "-z"]],
    ["worktree cleanup", ["worktree", "remove", "/home/rai/repo-wt"]],
    ["snapshot", ["ls-tree", "-r", "-z", "HEAD"]],
    ["settings identity", ["rev-parse", "--show-toplevel"]],
    ["settings visibility", ["check-ignore", ".rennet"]],
  ])("constructs WSL argv at the %s seam", async (_seam, gitArgs) => {
    const commands: ReturnType<typeof locusCommand>[] = [];
    const runnerForLocus =
      (locus: ReturnType<typeof detectLocus>): GitExec =>
      async (root, args) => {
        commands.push(locusCommand(locus, "git", args, root));
        return "";
      };
    const gitForRepo = gitForRepoFactory(detectLocus, runnerForLocus);

    await gitForRepo(WSL_ROOT)(WSL_ROOT, gitArgs);

    expect(commands).toEqual([
      {
        file: "wsl.exe",
        args: ["-d", "Ubuntu", "--cd", "/home/rai/repo", "-e", "git", ...gitArgs],
      },
    ]);
  });

  it("keeps every converted index.ts seam on the path-aware factory", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./create-server.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("const gitInLocus = gitForRepo(root);");
    expect(source).toContain("new ProjectSnapshotGenerator({ store: snapshotStore, gitForRepo })");
    expect(source).toContain("defaultProjectDiscoveryDeps(gitForRepo(path))");
    expect(source).toContain("defaultProjectDetailSourceDeps(gitForRepo(projectRoot)");
    expect(source).toContain("git: gitForRepo(projectRoot)");
    expect(source).toContain("await gitForRepo(workingPath)(workingPath");
    expect(source).toContain("defaultProjectDiscoveryDeps(gitForRepo(project.path))");
    expect(source).toContain("gitForRepo(repoRoot)");
    // The workspace inventory (workspace-settings D6) resolves git from the REPOSITORY
    // PATH the command names, so a WSL repository lists and removes its worktrees through
    // the git inside its own distro. `worktrees.test.ts` drives that argv end to end; this
    // pins the composition that hands it the locus-aware runner.
    expect(source).toContain(
      "listWorkspaces(gitForRepo(repoPath), repoPath, await inventoryOptions(",
    );
    expect(source).toContain("removeWorkspace(gitForRepo(repoPath), repoPath, { id, rows })");
    // And the same repository path decides the SPELLING git's answers are read in, so a
    // WSL repository's bound sessions still match the paths its distro's git printed.
    expect(source).toContain("inRepoSpelling(gitPath, repoPath, locus)");
  });
});
