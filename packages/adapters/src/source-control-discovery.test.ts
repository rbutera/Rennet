import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  detectGit,
  detectGitLfs,
  detectSourceControlTool,
  detectSourceControlTools,
  gitattributesUseLfs,
  parseGitLfsVersion,
  repoUsesLfs,
  type SourceControlDetectionDeps,
} from "./source-control-discovery";

interface Fixture {
  readonly loginShellPath?: string | null;
  readonly envPath?: string;
  readonly dirContents?: Record<string, readonly string[]>;
  readonly executables?: ReadonlySet<string>;
  readonly versions?: Record<string, string>;
  /** `git lfs version` answers, keyed by the git path that ran it. */
  readonly lfsHealth?: Record<string, string>;
  readonly platform?: NodeJS.Platform;
  readonly throwOnList?: boolean;
}

function recordingDeps(fixture: Fixture): { deps: SourceControlDetectionDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: SourceControlDetectionDeps = {
    loginShellPath: () => Promise.resolve(fixture.loginShellPath ?? null),
    envPath: fixture.envPath ?? "/usr/bin:/bin",
    home: "/home/rai",
    listDir: (directory) => {
      if (fixture.throwOnList) return Promise.reject(new Error("wsl.exe is not running"));
      return Promise.resolve(fixture.dirContents?.[directory] ?? []);
    },
    isExecutable: (path) => Promise.resolve(fixture.executables?.has(path) ?? false),
    probeVersion: (path) => {
      calls.push(`version ${path}`);
      return Promise.resolve(fixture.versions?.[path] ?? null);
    },
    probeGitLfs: (gitPath) => {
      calls.push(`lfs-health ${gitPath}`);
      return Promise.resolve(fixture.lfsHealth?.[gitPath] ?? null);
    },
    platform: fixture.platform ?? "darwin",
  };
  return { deps, calls };
}

/** The sighting's machine: both tools live only in Homebrew's directory, which the
 *  launch PATH does not carry. */
const HOMEBREW: Fixture = {
  envPath: "/usr/bin:/bin",
  dirContents: { "/opt/homebrew/bin": ["git", "git-lfs", "brew"] },
  executables: new Set(["/opt/homebrew/bin/git", "/opt/homebrew/bin/git-lfs"]),
  versions: { "/opt/homebrew/bin/git": "2.53.0", "/opt/homebrew/bin/git-lfs": "3.7.0" },
  lfsHealth: { "/opt/homebrew/bin/git": "3.7.0" },
};

describe("git and git-lfs probes", () => {
  it("reports both available, with proven versions, when they live only in Homebrew's directory", async () => {
    const { deps, calls } = recordingDeps(HOMEBREW);
    const [git, lfs] = await detectSourceControlTools(deps);
    expect(git).toEqual({
      id: "git",
      version: "2.53.0",
      status: "available",
      path: "/opt/homebrew/bin/git",
      detail: "Git is installed.",
    });
    expect(lfs).toEqual({
      id: "git-lfs",
      version: "3.7.0",
      status: "available",
      path: "/opt/homebrew/bin/git-lfs",
      detail: "Git LFS is installed and Git can use it.",
    });
    // Health is asked of the proven git, after git-lfs itself answered.
    expect(calls.indexOf("version /opt/homebrew/bin/git-lfs")).toBeLessThan(
      calls.indexOf("lfs-health /opt/homebrew/bin/git"),
    );
  });

  it("prefers the login-shell PATH over the curated directories", async () => {
    const { deps } = recordingDeps({
      loginShellPath: "/custom/bin:/usr/bin",
      dirContents: { "/custom/bin": ["git"], "/opt/homebrew/bin": ["git"] },
      executables: new Set(["/custom/bin/git", "/opt/homebrew/bin/git"]),
      versions: { "/custom/bin/git": "2.47.1", "/opt/homebrew/bin/git": "2.53.0" },
    });
    expect(await detectGit(deps)).toMatchObject({ path: "/custom/bin/git", version: "2.47.1" });
  });

  it("reports an absent git-lfs as not installed, with the install command, and never a version", async () => {
    const { deps, calls } = recordingDeps({
      ...HOMEBREW,
      dirContents: { "/opt/homebrew/bin": ["git"] },
    });
    const lfs = await detectGitLfs(deps);
    expect(lfs).toEqual({
      id: "git-lfs",
      version: null,
      status: "not-installed",
      path: null,
      detail:
        "Git LFS was not found on this host. Run `brew install git-lfs`, then `git lfs install`.",
    });
    expect(calls.some((call) => call.startsWith("lfs-health"))).toBe(false);
  });

  it("reports an absent git as not installed", async () => {
    const { deps } = recordingDeps({ dirContents: {} });
    expect(await detectGit(deps)).toMatchObject({
      status: "not-installed",
      version: null,
      path: null,
    });
  });

  it("says Git LFS is not required when no project on the locus uses it", async () => {
    const { deps } = recordingDeps({ ...HOMEBREW, dirContents: { "/opt/homebrew/bin": ["git"] } });
    expect(await detectGitLfs(deps, { lfsRequired: false })).toMatchObject({
      status: "not-installed",
      required: false,
      detail: "Git LFS is not installed. No project here uses it, so nothing needs it yet.",
    });
    expect(await detectGitLfs(deps, { lfsRequired: true })).toMatchObject({ required: true });
    expect(await detectGitLfs(deps)).not.toHaveProperty("required");
  });

  it("reports a binary that will not answer its version as unreachable, not installed", async () => {
    const { deps } = recordingDeps({
      ...HOMEBREW,
      versions: { "/opt/homebrew/bin/git": "2.53.0" },
    });
    expect(await detectGitLfs(deps)).toMatchObject({
      status: "unreachable",
      version: null,
      path: "/opt/homebrew/bin/git-lfs",
    });
  });

  it("reports git-lfs as unreachable when git cannot run it", async () => {
    const { deps } = recordingDeps({ ...HOMEBREW, lfsHealth: {} });
    const lfs = await detectGitLfs(deps);
    expect(lfs).toMatchObject({ status: "unreachable", version: "3.7.0" });
    expect(lfs.detail).toContain("`git lfs version` fails");
  });

  it("reports git-lfs as unreachable when git itself is missing", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["git-lfs"] },
      executables: new Set(["/opt/homebrew/bin/git-lfs"]),
      versions: { "/opt/homebrew/bin/git-lfs": "3.7.0" },
    });
    expect(await detectGitLfs(deps)).toMatchObject({
      status: "unreachable",
      detail: "Git LFS is installed, but Git is not, so it cannot be used.",
    });
  });

  it("reports a locus that cannot be asked at all as unreachable for both tools", async () => {
    const { deps } = recordingDeps({ throwOnList: true });
    const [git, lfs] = await detectSourceControlTools(deps);
    expect(git).toMatchObject({ status: "unreachable", version: null });
    expect(lfs).toMatchObject({ status: "unreachable", version: null });
  });

  it("detects one tool by id", async () => {
    const { deps } = recordingDeps(HOMEBREW);
    expect((await detectSourceControlTool("git", deps)).id).toBe("git");
    expect((await detectSourceControlTool("git-lfs", deps)).id).toBe("git-lfs");
  });

  it("reads the version git lfs prints", () => {
    expect(parseGitLfsVersion("git-lfs/3.7.0 (GitHub; darwin arm64; go 1.24.4)")).toBe("3.7.0");
    expect(parseGitLfsVersion("")).toBeNull();
  });
});

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("repoUsesLfs", () => {
  it("is true when .gitattributes routes paths through the LFS filter", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-uses-lfs-"));
    scratch.push(root);
    writeFileSync(join(root, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
    expect(await repoUsesLfs(root)).toBe(true);
  });

  it("is false without an LFS filter, and false with no .gitattributes at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-uses-lfs-"));
    scratch.push(root);
    expect(await repoUsesLfs(root)).toBe(false);
    writeFileSync(join(root, ".gitattributes"), "* text=auto\n*.sh eol=lf\n");
    expect(await repoUsesLfs(root)).toBe(false);
  });

  it("ignores comments and look-alikes, and counts an attribute macro", () => {
    expect(gitattributesUseLfs("# *.bin filter=lfs\n")).toBe(false);
    expect(gitattributesUseLfs("*.bin filter=lfsx\n*.c filter=lfs-like\n")).toBe(false);
    expect(gitattributesUseLfs("[attr]big filter=lfs diff=lfs merge=lfs -text\n*.bin big\n")).toBe(
      true,
    );
    expect(gitattributesUseLfs("*.bin\tfilter=lfs\r\n")).toBe(true);
  });

  it("reads .gitattributes at a ref through git, not from the working tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-uses-lfs-ref-"));
    scratch.push(root);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "rennet@example.test");
    git("config", "user.name", "Rennet Test");
    writeFileSync(join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    git("add", ".gitattributes");
    git("commit", "-q", "-m", "track bins with lfs");
    // The working tree drops LFS; the committed default branch still uses it.
    writeFileSync(join(root, ".gitattributes"), "* text=auto\n");
    expect(await repoUsesLfs(root)).toBe(false);
    expect(await repoUsesLfs(root, { ref: "main", git: execaGit })).toBe(true);
    expect(await repoUsesLfs(root, { ref: "no-such-branch", git: execaGit })).toBe(false);
  });
});
