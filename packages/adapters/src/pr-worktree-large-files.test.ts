import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyGitFailure } from "./git-failure";
import { execaGit, type GitExec } from "./git-range-diff";
import {
  ensureBranchWorktree,
  ensurePrWorktree,
  ensureSiblingWorktree,
  LARGE_FILES_HOOK_SKIPPED_WARNING,
  largeFileGitInvocation,
} from "./pr-worktree";

/**
 * Large-file checkout modes against a REAL git, in the configuration the sighting had:
 * the LFS filter marked required with `git-lfs filter-process` as its process, and no
 * `git-lfs` anywhere on the PATH git runs with. Skip must succeed with pointer files;
 * download must fail the way the sighting did, and be classified as Git LFS missing.
 */

const POINTER = [
  "version https://git-lfs.github.com/spec/v1",
  "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393",
  "size 12345",
  "",
].join("\n");

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

interface Fixture {
  readonly root: string;
  readonly headOid: string;
  readonly worktrees: string;
  /** The global config git reads: the LFS filter, required. */
  readonly globalConfig: string;
  /** A GitExec whose children see ONLY a PATH with git and no git-lfs, plus the config. */
  readonly git: GitExec;
}

function fixture(): Fixture {
  const home = scratchDir("rennet-lfs-home-");
  const root = scratchDir("rennet-lfs-repo-");
  const worktrees = scratchDir("rennet-lfs-wt-");

  // A bin directory holding git and nothing else: the PATH a launchd-started daemon had.
  const bin = scratchDir("rennet-lfs-bin-");
  const realGit = realpathSync(
    execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
  );
  symlinkSync(realGit, join(bin, "git"));

  // Committing the pointer runs under a config with NO lfs filter, so the pointer text is
  // stored verbatim, exactly as git-lfs itself would have stored it.
  const plainConfig = join(home, "plain.gitconfig");
  writeFileSync(plainConfig, "[user]\n\temail = rennet@example.test\n\tname = Rennet Test\n");
  const plainEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: plainConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: plainEnv, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "model.bin"), POINTER);
  writeFileSync(join(root, "README.md"), "acme widget\n");
  run("add", "-A");
  run("commit", "-q", "-m", "add a large file");
  run("branch", "feat/large");
  const headOid = run("rev-parse", "HEAD");

  const globalConfig = join(home, "lfs.gitconfig");
  writeFileSync(
    globalConfig,
    [
      "[user]",
      "\temail = rennet@example.test",
      "\tname = Rennet Test",
      '[filter "lfs"]',
      "\tclean = git-lfs clean -- %f",
      "\tsmudge = git-lfs smudge -- %f",
      "\tprocess = git-lfs filter-process",
      "\trequired = true",
      "",
    ].join("\n"),
  );
  const isolated = {
    PATH: bin,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  // The runner under test, with this fixture's environment layered over each call's own.
  const git: GitExec = (cwd, args, options) =>
    execaGit(cwd, args, { ...options, env: { ...options?.env, ...isolated } });

  // The precondition the whole file rests on: nothing on that PATH answers to git-lfs.
  expect(() =>
    execFileSync("sh", ["-c", "command -v git-lfs"], { env: { PATH: bin }, stdio: "pipe" }),
  ).toThrow();

  return { root, headOid, worktrees, globalConfig, git };
}

describe("largeFileGitInvocation", () => {
  it("adds nothing for download or an absent mode", () => {
    expect(largeFileGitInvocation("download")).toEqual({ config: [] });
    expect(largeFileGitInvocation(undefined)).toEqual({ config: [] });
  });

  it("disables the LFS filter per call and skips smudge for skip", () => {
    expect(largeFileGitInvocation("skip")).toEqual({
      config: [
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.required=false",
      ],
      env: { GIT_LFS_SKIP_SMUDGE: "1" },
    });
  });
});

describe("worktree adds under a large-file mode", () => {
  it("passes download calls through untouched, and puts skip overrides before the subcommand", async () => {
    const calls: { args: string[]; env?: Readonly<Record<string, string>> }[] = [];
    const fake: GitExec = async (_root, args, options) => {
      calls.push({ args, ...(options?.env === undefined ? {} : { env: options.env }) });
      return "";
    };
    const root = scratchDir("rennet-lfs-fake-");
    await ensurePrWorktree(fake, root, join(root, "a"), "abc123");
    await ensurePrWorktree(fake, root, join(root, "b"), "abc123", { largeFiles: "skip" });
    const adds = calls.filter((call) => call.args.includes("worktree"));
    expect(adds[0]).toEqual({ args: ["worktree", "add", "--detach", join(root, "a"), "abc123"] });
    expect(adds[1]).toEqual({
      args: [
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.required=false",
        "worktree",
        "add",
        "--detach",
        join(root, "b"),
        "abc123",
      ],
      env: { GIT_LFS_SKIP_SMUDGE: "1" },
    });
  });

  it("skip checks a pull request out with pointer files and leaves the user's config alone", async () => {
    const { root, headOid, worktrees, globalConfig, git } = fixture();
    const configBefore = readFileSync(globalConfig, "utf8");
    const repoConfigBefore = readFileSync(join(root, ".git", "config"), "utf8");
    const target = join(worktrees, "acme", "widget", "pr-1");

    const result = await ensurePrWorktree(git, root, target, headOid, { largeFiles: "skip" });

    expect(result).toEqual({ path: target, created: true });
    expect(readFileSync(join(target, "assets", "model.bin"), "utf8")).toBe(POINTER);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("acme widget\n");
    expect(readFileSync(globalConfig, "utf8")).toBe(configBefore);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(repoConfigBefore);
  });

  it("download fails without git-lfs, and the failure is classified as Git LFS missing", async () => {
    const { root, headOid, worktrees, git } = fixture();
    const target = join(worktrees, "acme", "widget", "pr-1");

    const failure: unknown = await ensurePrWorktree(git, root, target, headOid).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(classifyGitFailure(failure)).toMatchObject({
      kind: "tool-missing",
      tool: "git-lfs",
      action: "install",
    });

    // The explicit download mode is the same call.
    const explicit: unknown = await ensurePrWorktree(git, root, join(worktrees, "pr-2"), headOid, {
      largeFiles: "download",
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(classifyGitFailure(explicit)).toMatchObject({ kind: "tool-missing", tool: "git-lfs" });
  });

  it("skip also covers the branch and sibling worktree adds", async () => {
    const { root, worktrees, git } = fixture();
    const branchPath = join(worktrees, "branch", "feat", "large");
    const branch = await ensureBranchWorktree(git, root, branchPath, "feat/large", {
      largeFiles: "skip",
    });
    expect(branch).toEqual({ path: branchPath, created: true });
    expect(readFileSync(join(branchPath, "assets", "model.bin"), "utf8")).toBe(POINTER);

    // `main` is checked out in the clone, so the sibling forks `rennet/main` beside it.
    const siblingPath = join(worktrees, "sibling", "main");
    const sibling = await ensureSiblingWorktree(git, root, siblingPath, "main", {
      largeFiles: "skip",
    });
    expect(sibling).toEqual({ path: siblingPath, created: true, workBranch: "rennet/main" });
    expect(readFileSync(join(siblingPath, "assets", "model.bin"), "utf8")).toBe(POINTER);
  });

  it("download fails for the branch add too, so the skip pass above is the mode's doing", async () => {
    const { root, worktrees, git } = fixture();
    const failure: unknown = await ensureBranchWorktree(
      git,
      root,
      join(worktrees, "branch", "feat", "large"),
      "feat/large",
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(classifyGitFailure(failure, { subject: "branch" })).toMatchObject({
      kind: "tool-missing",
      tool: "git-lfs",
    });
  });
});

/**
 * The hook `git lfs install` writes into `.git/hooks/post-checkout`, verbatim. It runs after
 * every checkout git makes, worktree adds included, and exits 2 when `git-lfs` is not on the
 * PATH. Git propagates that exit code, so `worktree add` "fails" AFTER the worktree exists.
 */
const LFS_POST_CHECKOUT_HOOK = [
  "#!/bin/sh",
  `command -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the 'post-checkout' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks')."; exit 2; }`,
  'git lfs post-checkout "$@"',
  "",
].join("\n");

function installHook(root: string, body: string): void {
  const hook = join(root, ".git", "hooks", "post-checkout");
  writeFileSync(hook, body);
  chmodSync(hook, 0o755);
}

describe("skip under git-lfs's own post-checkout hook", () => {
  it("checks a pull request out with pointer files and says the hook was skipped", async () => {
    const { root, headOid, worktrees, git } = fixture();
    installHook(root, LFS_POST_CHECKOUT_HOOK);
    const target = join(worktrees, "acme", "widget", "pr-1");

    const result = await ensurePrWorktree(git, root, target, headOid, { largeFiles: "skip" });

    expect(result).toEqual({
      path: target,
      created: true,
      warning: LARGE_FILES_HOOK_SKIPPED_WARNING,
    });
    expect(readFileSync(join(target, "assets", "model.bin"), "utf8")).toBe(POINTER);
    // Re-opening the same snapshot is a plain hit, with no hook in the way.
    expect(await ensurePrWorktree(git, root, target, headOid, { largeFiles: "skip" })).toEqual({
      path: target,
      created: false,
    });
  });

  it("checks a branch out with pointer files", async () => {
    const { root, worktrees, git } = fixture();
    installHook(root, LFS_POST_CHECKOUT_HOOK);
    const branchPath = join(worktrees, "branch", "feat", "large");

    const branch = await ensureBranchWorktree(git, root, branchPath, "feat/large", {
      largeFiles: "skip",
    });

    expect(branch).toEqual({
      path: branchPath,
      created: true,
      warning: LARGE_FILES_HOOK_SKIPPED_WARNING,
    });
    expect(readFileSync(join(branchPath, "assets", "model.bin"), "utf8")).toBe(POINTER);
  });

  it("forks a sibling with pointer files", async () => {
    const { root, worktrees, git } = fixture();
    installHook(root, LFS_POST_CHECKOUT_HOOK);
    const siblingPath = join(worktrees, "sibling", "main");

    const sibling = await ensureSiblingWorktree(git, root, siblingPath, "main", {
      largeFiles: "skip",
    });

    expect(sibling).toEqual({
      path: siblingPath,
      created: true,
      workBranch: "rennet/main",
      warning: LARGE_FILES_HOOK_SKIPPED_WARNING,
    });
    expect(readFileSync(join(siblingPath, "assets", "model.bin"), "utf8")).toBe(POINTER);
  });

  it("still fails download under the hook, classified as Git LFS missing", async () => {
    const { root, headOid, worktrees, git } = fixture();
    installHook(root, LFS_POST_CHECKOUT_HOOK);
    const failure: unknown = await ensurePrWorktree(
      git,
      root,
      join(worktrees, "pr-1"),
      headOid,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(classifyGitFailure(failure)).toMatchObject({ kind: "tool-missing", tool: "git-lfs" });
  });

  it("surfaces any other hook's failure in skip mode", async () => {
    const { root, headOid, worktrees, git } = fixture();
    installHook(root, '#!/bin/sh\necho "acme policy: checkouts are frozen" >&2\nexit 1\n');

    const failure: unknown = await ensurePrWorktree(git, root, join(worktrees, "pr-1"), headOid, {
      largeFiles: "skip",
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as { stderr?: unknown }).stderr)).toContain(
      "acme policy: checkouts are frozen",
    );

    const branchFailure: unknown = await ensureBranchWorktree(
      git,
      root,
      join(worktrees, "branch", "feat", "large"),
      "feat/large",
      { largeFiles: "skip" },
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(branchFailure).toBeInstanceOf(Error);
  });
});
