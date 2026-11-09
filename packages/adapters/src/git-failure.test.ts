import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { classifyGitFailure, GIT_FAILURE_DETAIL_CAP, type GitFailureKind } from "./git-failure";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The sighting this change exists for, verbatim apart from the path. */
const OBSERVED =
  "Command failed with exit code 128: git worktree add --detach /Users/x/.rennet/worktrees/acme/widget/pr-1 433815ccab8d" +
  "\n\nPreparing worktree (detached HEAD 433815ccab8)\ngit-lfs filter-process --skip: git-lfs: command not found\nfatal: the remote end hung up unexpectedly";

/** A failure the way execa throws it: the message carries the command; stderr is a field. */
function execaShaped(command: string, stderr: string, exitCode = 128): Error {
  return Object.assign(
    new Error(`Command failed with exit code ${exitCode}: ${command}\n\n${stderr}`),
    { stderr, stdout: "", exitCode },
  );
}

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly input: unknown;
  readonly kind: GitFailureKind;
  readonly tool?: "git" | "git-lfs";
}> = [
  {
    name: "the observed git-lfs filter-process sighting",
    input: OBSERVED,
    kind: "tool-missing",
    tool: "git-lfs",
  },
  {
    name: "git-lfs missing under a required smudge filter (dash)",
    input: execaShaped(
      "git worktree add --detach /tmp/wt 433815ccab8d",
      "Preparing worktree (detached HEAD 433815c)\n/bin/sh: 1: git-lfs: not found\nerror: external filter 'git-lfs filter-process' failed\nfatal: assets/logo.png: smudge filter lfs failed",
    ),
    kind: "tool-missing",
    tool: "git-lfs",
  },
  {
    name: "git-lfs missing on Windows",
    input:
      "'git-lfs' is not recognized as an internal or external command,\noperable program or batch file.\nfatal: the remote end hung up unexpectedly",
    kind: "tool-missing",
    tool: "git-lfs",
  },
  {
    name: "git has no lfs subcommand",
    input: "git: 'lfs' is not a git command. See 'git --help'.",
    kind: "tool-missing",
    tool: "git-lfs",
  },
  {
    name: "git-lfs pre-push hook without git-lfs",
    input:
      "This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the 'pre-push' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').",
    kind: "tool-missing",
    tool: "git-lfs",
  },
  {
    name: "git-lfs missing in zsh",
    input: execaShaped(
      "git worktree add --detach /tmp/wt 433815ccab8d",
      "Preparing worktree (detached HEAD 433815c)\nzsh:1: command not found: git-lfs\nfatal: the remote end hung up unexpectedly",
    ),
    kind: "tool-missing",
    tool: "git-lfs",
  },
  {
    name: "git missing in sh",
    input: "sh: git: command not found",
    kind: "tool-missing",
    tool: "git",
  },
  {
    name: "git missing in zsh",
    input: "zsh:1: command not found: git",
    kind: "tool-missing",
    tool: "git",
  },
  {
    name: "macOS developer tools missing",
    input:
      "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun",
    kind: "tool-missing",
    tool: "git",
  },
  {
    name: "fresh Mac, the developer-tools shim asks to install",
    input:
      "xcode-select: note: No developer tools were found, requesting install. If developer tools are located at a non-default location on disk, use `sudo xcode-select --switch path/to/Xcode.app` to specify the Xcode that you wish to use for command line developer tools, and cancel the installation dialog.\nSee `man xcode-select` for more details.",
    kind: "tool-missing",
    tool: "git",
  },
  {
    name: "fresh Mac, the developer-tools shim cannot ask",
    input:
      "xcode-select: note: No developer tools were found, and no install could be requested (perhaps no UI is present), please install manually from 'developer.apple.com'.",
    kind: "tool-missing",
    tool: "git",
  },
  {
    name: "git-lfs present but the download fails",
    input: execaShaped(
      "git worktree add --detach /tmp/wt 433815ccab8d",
      "Downloading assets/logo.png (1.2 MB)\nError downloading object: assets/logo.png (a1b2c3d): Smudge error: Error downloading assets/logo.png (a1b2c3d4e5): batch response: Bad credentials\n\nErrors logged to '/Users/x/acme/widget/.git/lfs/logs/20261109T101500.log'.\nUse `git lfs logs last` to view the log.\nerror: external filter 'git-lfs filter-process' failed\nfatal: assets/logo.png: smudge filter lfs failed",
    ),
    kind: "large-file",
  },
  {
    name: "LFS object missing on the server",
    input:
      "Error downloading object: data/model.bin (9f8e7d6): Smudge error: Error downloading data/model.bin: [9f8e7d6] Object does not exist on the server: [404] Object does not exist on the server",
    kind: "large-file",
  },
  {
    name: "https credentials refused",
    input: execaShaped(
      "git fetch origin refs/pull/1/head",
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/widget.git/'",
    ),
    kind: "auth",
  },
  {
    name: "no terminal to prompt for a username",
    input: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    kind: "auth",
  },
  {
    name: "ssh key refused",
    input:
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    kind: "auth",
  },
  {
    name: "GitLab basic auth denied",
    input:
      "remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password.\nfatal: Authentication failed for 'https://gitlab.com/acme/widget.git/'",
    kind: "auth",
  },
  {
    name: "403 from the host",
    input:
      "fatal: unable to access 'https://github.com/acme/widget.git/': The requested URL returned error: 403",
    kind: "auth",
  },
  {
    name: "private repository read without access",
    input:
      "remote: Repository not found.\nfatal: repository 'https://github.com/acme/widget.git/' not found",
    kind: "auth",
  },
  {
    name: "worktree add at a commit that is gone",
    input: execaShaped(
      "git worktree add --detach /tmp/wt 433815ccab8d0000000000000000000000000000",
      "fatal: invalid reference: 433815ccab8d0000000000000000000000000000",
    ),
    kind: "ref-gone",
  },
  {
    name: "unknown revision",
    input:
      "fatal: ambiguous argument 'deadbeef': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:",
    kind: "ref-gone",
  },
  {
    name: "pull ref deleted on the remote",
    input: "fatal: couldn't find remote ref refs/pull/42/head",
    kind: "ref-gone",
  },
  {
    name: "force-pushed head no longer advertised",
    input: "fatal: remote error: upload-pack: not our ref 433815ccab8d0000000000000000000000000000",
    kind: "ref-gone",
  },
  {
    name: "an auth failure for a repository named after git-lfs is still auth",
    input: execaShaped(
      "git fetch https://github.com/acme/git-lfs-tools.git refs/pull/7/head",
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/git-lfs-tools.git/'",
    ),
    kind: "auth",
  },
  {
    name: "a missing branch named after git-lfs is ref-gone",
    input: execaShaped(
      "git fetch origin refs/heads/fix/git-lfs",
      "fatal: couldn't find remote ref refs/heads/fix/git-lfs",
    ),
    kind: "ref-gone",
  },
  {
    name: "an invalid reference added at a path named after git-lfs is ref-gone",
    input: execaShaped(
      "git worktree add /tmp/wt/acme/upgrade-git-lfs nope-ref",
      "fatal: invalid reference: nope-ref",
    ),
    kind: "ref-gone",
  },
  {
    name: "execa's invalid-cwd ENOENT is not git missing",
    input: Object.assign(
      new Error(
        "Command failed with ENOENT: git status\nThe \"cwd\" option is invalid: /tmp/acme/widget.\nENOENT: no such file or directory, stat '/tmp/acme/widget'\nspawn git ENOENT",
      ),
      { code: "ENOENT", stderr: "", stdout: "" },
    ),
    kind: "unknown",
  },
  {
    name: "a path collision is not any known cause",
    input: execaShaped(
      "git worktree add --detach /tmp/wt 433815ccab8d",
      "fatal: '/tmp/wt' already exists",
    ),
    kind: "unknown",
  },
  {
    name: "a network failure is not an auth failure",
    input:
      "fatal: unable to access 'https://github.com/acme/widget.git/': Could not resolve host: github.com",
    kind: "unknown",
  },
];

const ACTION = {
  "tool-missing": "install",
  "large-file": "choose-large-files",
  auth: "sign-in",
  "ref-gone": "retry",
  unknown: "retry",
} as const;

describe("classifyGitFailure", () => {
  it.each(CASES)("$name → $kind", ({ input, kind, tool }) => {
    const classified = classifyGitFailure(input);
    expect(classified.kind).toBe(kind);
    expect(classified.tool).toBe(tool);
    expect(classified.action).toBe(ACTION[kind]);
  });

  it("names Git LFS in plain words for the observed sighting and keeps git's text as detail", () => {
    const classified = classifyGitFailure(OBSERVED);
    expect(classified).toMatchObject({ kind: "tool-missing", tool: "git-lfs", action: "install" });
    expect(classified.message).toBe(
      "Git LFS isn't installed, so this pull request's large files can't be checked out.",
    );
    expect(classified.detail).toContain("git-lfs: command not found");
    expect(classified.detail).toContain("fatal: the remote end hung up unexpectedly");
  });

  it("never puts git's own words or machinery nouns in the message", () => {
    for (const { input } of CASES) {
      const { message } = classifyGitFailure(input);
      expect(message).toMatch(/^[A-Z]/);
      expect(message).not.toMatch(/fatal|stderr|exit code|worktree|filter|smudge|ENOENT|spawn/i);
    }
  });

  it("phrases the message for a branch when asked", () => {
    expect(classifyGitFailure(OBSERVED, { subject: "branch" }).message).toBe(
      "Git LFS isn't installed, so this branch's large files can't be checked out.",
    );
  });

  it("keeps stderr that execa's message did not already carry", () => {
    const error = Object.assign(new Error("Command failed with exit code 128: git worktree add"), {
      stderr: "git-lfs filter-process: git-lfs: command not found",
    });
    const classified = classifyGitFailure(error);
    expect(classified.kind).toBe("tool-missing");
    expect(classified.detail).toContain("Command failed with exit code 128");
    expect(classified.detail).toContain("git-lfs: command not found");
  });

  it("reads a real ENOENT from spawning a git that is not there as git missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rennet-nogit-"));
    scratch.push(empty);
    const error: unknown = await execa("git", ["--version"], {
      env: { PATH: empty },
      extendEnv: false,
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(classifyGitFailure(error)).toMatchObject({ kind: "tool-missing", tool: "git" });
  });

  it("reads a real ENOENT from a missing checkout directory as unknown, not git missing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rennet-nocwd-"));
    scratch.push(parent);
    const error: unknown = await execa("git", ["status"], {
      cwd: join(parent, "acme", "widget"),
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: unknown }).code).toBe("ENOENT");
    const classified = classifyGitFailure(error);
    expect(classified).toMatchObject({ kind: "unknown", action: "retry" });
    expect(classified.tool).toBeUndefined();
    expect(classified.detail).toContain('The "cwd" option is invalid');
  });

  it("keeps the command line in detail though it never decides the kind", () => {
    const classified = classifyGitFailure(
      execaShaped(
        "git worktree add /tmp/wt/acme/upgrade-git-lfs nope-ref",
        "fatal: invalid reference: nope-ref",
      ),
    );
    expect(classified.kind).toBe("ref-gone");
    expect(classified.detail).toContain("git worktree add /tmp/wt/acme/upgrade-git-lfs nope-ref");
  });

  it("caps a huge detail, keeping the head and git's final verdict, and says what it cut", () => {
    const noise = "x".repeat(GIT_FAILURE_DETAIL_CAP * 3);
    const classified = classifyGitFailure(
      `Command failed: git worktree add\n${noise}\nfatal: invalid reference: abc`,
    );
    expect(classified.detail.length).toBeLessThan(GIT_FAILURE_DETAIL_CAP + 100);
    expect(classified.detail.startsWith("Command failed: git worktree add")).toBe(true);
    expect(classified.detail.endsWith("fatal: invalid reference: abc")).toBe(true);
    expect(classified.detail).toMatch(/… \d+ characters omitted …/);
    expect(classified.kind).toBe("ref-gone");
  });
});
