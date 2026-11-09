import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  absoluteGitDir,
  LARGE_FILE_SKIP_CONFIG,
  LargeFileSkipIndex,
  largeFileSkipEnv,
  largeFileSkipIndexPath,
  withGitConfigEnv,
  withLargeFileSkipIndex,
} from "./large-file-env";

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

describe("withGitConfigEnv", () => {
  it("appends after the entries the environment already carries, keeping their numbers", () => {
    const env = withGitConfigEnv(
      {
        PATH: "/usr/bin",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "input",
      },
      LARGE_FILE_SKIP_CONFIG,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "input",
      GIT_CONFIG_KEY_1: "filter.lfs.process",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "filter.lfs.smudge",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "filter.lfs.required",
      GIT_CONFIG_VALUE_3: "false",
    });
  });

  it("starts at zero with no count, and leaves a count git would refuse untouched", () => {
    expect(withGitConfigEnv({}, [["a.b", "c"]])).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
    });
    expect(withGitConfigEnv({ GIT_CONFIG_COUNT: "lots" }, [["a.b", "c"]])).toEqual({
      GIT_CONFIG_COUNT: "lots",
    });
  });

  it("largeFileSkipEnv adds the three filter overrides and GIT_LFS_SKIP_SMUDGE", () => {
    const env = largeFileSkipEnv({ HOME: "/home/acme" });
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_2).toBe("filter.lfs.required");
  });

  it("withLargeFileSkipIndex adds the include once, however often it is applied", () => {
    const once = withLargeFileSkipIndex({ GIT_CONFIG_COUNT: "0" }, "/data/large-files/x");
    expect(once).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "include.path",
      GIT_CONFIG_VALUE_0: "/data/large-files/x",
    });
    expect(withLargeFileSkipIndex(once, "/data/large-files/x")).toEqual(once);
  });
});

/**
 * The behaviour the index exists for, against a real git: the user's global config marks the
 * LFS filter required, `git-lfs` is on no PATH, and two worktrees of one repository hold an
 * LFS file. Only the one registered in the index runs git as skip mode; the other is exactly
 * as the user's config makes it.
 */
describe("LargeFileSkipIndex", () => {
  function fixture() {
    const home = scratchDir("rennet-skipidx-home-");
    const root = scratchDir("rennet-skipidx-repo-");
    const trees = scratchDir("rennet-skipidx-wt-");
    const data = scratchDir("rennet-skipidx-data-");
    const bin = scratchDir("rennet-skipidx-bin-");
    const realGit = realpathSync(
      execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
    );
    symlinkSync(realGit, join(bin, "git"));
    const plain = join(home, "plain.gitconfig");
    writeFileSync(plain, "[user]\n\temail = rennet@example.test\n\tname = Rennet Test\n");
    const plainEnv = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: plain,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, env: plainEnv, encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "model.bin"), POINTER);
    run("add", "-A");
    run("commit", "-q", "-m", "add a large file");
    const skip = join(trees, "skip");
    const download = join(trees, "download");
    // Created under the plain config, so both checkouts exist before the filter is required.
    run("worktree", "add", "-q", "--detach", skip, "HEAD");
    run("worktree", "add", "-q", "--detach", download, "HEAD");

    const lfsConfig = join(home, "lfs.gitconfig");
    writeFileSync(
      lfsConfig,
      [
        "[user]",
        "\temail = rennet@example.test",
        '[filter "lfs"]',
        "\tclean = git-lfs clean -- %f",
        "\tsmudge = git-lfs smudge -- %f",
        "\tprocess = git-lfs filter-process",
        "\trequired = true",
        "",
      ].join("\n"),
    );
    const index = new LargeFileSkipIndex(largeFileSkipIndexPath(data));
    // The environment a daemon child runs with: the user's config, no git-lfs, and the index.
    const childEnv = withLargeFileSkipIndex(
      { PATH: bin, HOME: home, GIT_CONFIG_GLOBAL: lfsConfig, GIT_CONFIG_NOSYSTEM: "1" },
      index.indexPath,
    );
    const restore = (cwd: string) => {
      unlinkSync(join(cwd, "assets", "model.bin"));
      return spawnSync("git", ["checkout", "--", "assets/model.bin"], {
        cwd,
        env: childEnv,
        encoding: "utf8",
      });
    };
    return { root, skip, download, index, childEnv, restore };
  }

  it("makes git in a registered checkout skip Git LFS, and leaves every other checkout alone", async () => {
    const { skip, download, index, childEnv, restore } = fixture();
    const git = (cwd: string, args: string[]) =>
      execaGit(cwd, args, { env: childEnv as Record<string, string> });
    index.add(await absoluteGitDir(git, skip));

    // The registered checkout: a later checkout of the large file succeeds as a pointer.
    const skipped = restore(skip);
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(readFileSync(join(skip, "assets", "model.bin"), "utf8")).toBe(POINTER);
    expect((await git(skip, ["config", "--get", "filter.lfs.required"])).trim()).toBe("false");

    // The other checkout of the SAME repository is untouched: the user's required filter
    // runs and fails, because git-lfs is not installed.
    const downloaded = restore(download);
    expect(downloaded.status).not.toBe(0);
    expect(downloaded.stderr).toMatch(/git-lfs/);
    expect((await git(download, ["config", "--get", "filter.lfs.required"])).trim()).toBe("true");
  });

  it("registers idempotently, survives a fresh reader, and unregisters", async () => {
    const { skip, index, childEnv } = fixture();
    const git = (cwd: string, args: string[]) =>
      execaGit(cwd, args, { env: childEnv as Record<string, string> });
    const gitDir = await absoluteGitDir(git, skip);
    index.add(gitDir);
    index.add(gitDir);
    const reread = new LargeFileSkipIndex(index.indexPath);
    expect(reread.gitDirs()).toEqual([gitDir]);
    reread.remove((dir) => dir === gitDir);
    expect(index.gitDirs()).toEqual([]);
    expect((await git(skip, ["config", "--get", "filter.lfs.required"])).trim()).toBe("true");
  });

  it("matches a checkout whose path carries glob and quoting characters", () => {
    const data = scratchDir("rennet-skipidx-odd-");
    const index = new LargeFileSkipIndex(largeFileSkipIndexPath(data));
    const odd = '/tmp/acme [widget]/*?"q"/.git/worktrees/pr-1';
    index.add(odd);
    expect(new LargeFileSkipIndex(index.indexPath).gitDirs()).toEqual([odd]);
  });
});
