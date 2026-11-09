import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  defaultSourceControlDetectionDeps,
  detectGit,
  detectGitLfs,
  detectSourceControlTool,
  detectSourceControlTools,
  gitattributesUseLfs,
  type LocusRun,
  parseGitLfsVersion,
  repoUsesLfs,
  type SourceControlDetectionDeps,
  wslSourceControlDetectionDeps,
} from "./source-control-discovery";

interface Fixture {
  readonly loginShellPath?: string | null;
  readonly envPath?: string;
  readonly dirContents?: Record<string, readonly string[]>;
  readonly executables?: ReadonlySet<string>;
  readonly versions?: Record<string, string>;
  /** What a binary that does not answer its version prints instead, keyed by path. */
  readonly failures?: Record<string, string>;
  /** `git lfs version` answers, keyed by the git path that ran it. */
  readonly lfsHealth?: Record<string, string>;
  readonly platform?: NodeJS.Platform;
  readonly throwOnList?: boolean;
  /** What `xcode-select -p` says about the developer tools. Absent ⇒ no such probe. */
  readonly developerToolsMissing?: boolean;
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
      const version = fixture.versions?.[path];
      return Promise.resolve(
        version === undefined
          ? { version: null, output: fixture.failures?.[path] ?? "" }
          : { version },
      );
    },
    probeGitLfs: (gitPath) => {
      calls.push(`lfs-health ${gitPath}`);
      return Promise.resolve(fixture.lfsHealth?.[gitPath] ?? null);
    },
    platform: fixture.platform ?? "darwin",
    ...(fixture.developerToolsMissing === undefined
      ? {}
      : {
          developerToolsMissing: () => {
            calls.push("xcode-select -p");
            return Promise.resolve(fixture.developerToolsMissing === true);
          },
        }),
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

  it("reports the first git on the PATH when it is broken, not a working one after it", async () => {
    const { deps, calls } = recordingDeps({
      loginShellPath: "/usr/local/bin:/opt/homebrew/bin",
      dirContents: { "/usr/local/bin": ["git"], "/opt/homebrew/bin": ["git"] },
      executables: new Set(["/usr/local/bin/git", "/opt/homebrew/bin/git"]),
      versions: { "/opt/homebrew/bin/git": "2.53.0" },
      failures: { "/usr/local/bin/git": "dyld: Library not loaded: libpcre2-8.0.dylib" },
    });
    const git = await detectGit(deps);
    expect(git).toMatchObject({ status: "unreachable", version: null, path: "/usr/local/bin/git" });
    expect(git.detail).toContain("dyld: Library not loaded");
    expect(calls).not.toContain("version /opt/homebrew/bin/git");
  });

  it("reports the macOS developer-tools shim as Git not installed, naming xcode-select", async () => {
    const shim =
      "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun";
    const fixture = {
      envPath: "/usr/bin:/bin",
      dirContents: { "/usr/bin": ["git"] },
      executables: new Set(["/usr/bin/git"]),
      failures: { "/usr/bin/git": shim },
    };
    const git = await detectGit(recordingDeps({ ...fixture, platform: "darwin" }).deps);
    expect(git).toMatchObject({ status: "not-installed", version: null, path: "/usr/bin/git" });
    expect(git.detail).toContain("`xcode-select --install`");
    // Only macOS has the shim; elsewhere the same words are a broken git, reported as such.
    expect(await detectGit(recordingDeps({ ...fixture, platform: "linux" }).deps)).toMatchObject({
      status: "unreachable",
    });
  });

  it.each([
    "xcode-select: note: No developer tools were found, requesting install. If developer tools are located at a non-default location on disk, use `sudo xcode-select --switch path/to/Xcode.app` to specify the Xcode that you wish to use for command line developer tools, and cancel the installation dialog.",
    "xcode-select: note: No developer tools were found, and no install could be requested (perhaps no UI is present), please install manually from 'developer.apple.com'.",
  ])("reads the fresh-Mac shim's words as Git not installed: %s", async (shim) => {
    const git = await detectGit(
      recordingDeps({
        envPath: "/usr/bin:/bin",
        dirContents: { "/usr/bin": ["git"] },
        executables: new Set(["/usr/bin/git"]),
        failures: { "/usr/bin/git": shim },
        platform: "darwin",
      }).deps,
    );
    expect(git).toMatchObject({ status: "not-installed", version: null, path: "/usr/bin/git" });
    expect(git.detail).toContain("`xcode-select --install`");
  });

  it("never runs /usr/bin/git when xcode-select says the developer tools are missing", async () => {
    const shim = {
      envPath: "/usr/bin:/bin",
      dirContents: { "/usr/bin": ["git"] },
      executables: new Set(["/usr/bin/git"]),
      platform: "darwin" as const,
    };
    const missing = recordingDeps({ ...shim, developerToolsMissing: true });
    const git = await detectGit(missing.deps);
    expect(git).toMatchObject({ status: "not-installed", version: null, path: "/usr/bin/git" });
    expect(git.detail).toContain("`xcode-select --install`");
    expect(missing.calls).toEqual(["xcode-select -p"]);

    // With the tools present, /usr/bin/git is the real git and is asked as before.
    const present = recordingDeps({
      ...shim,
      developerToolsMissing: false,
      versions: { "/usr/bin/git": "2.39.5" },
    });
    expect(await detectGit(present.deps)).toMatchObject({ status: "available", version: "2.39.5" });
    expect(present.calls).toEqual(["xcode-select -p", "version /usr/bin/git"]);
  });

  it("the host deps ask xcode-select -p and never hand /usr/bin/git to the runner", async () => {
    const ran: string[] = [];
    const run: LocusRun = async (file, args) => {
      ran.push([file, ...args].join(" "));
      return file === "/usr/bin/xcode-select"
        ? {
            exitCode: 2,
            stdout: "",
            stderr:
              "xcode-select: error: unable to get active developer directory, use `sudo xcode-select --switch path/to/Xcode.app` to set one (or see `man xcode-select`)",
          }
        : { exitCode: 0, stdout: "git version 2.39.5 (Apple Git-154)", stderr: "" };
    };
    const deps: SourceControlDetectionDeps = {
      ...defaultSourceControlDetectionDeps(run),
      platform: "darwin",
      envPath: "/usr/bin:/bin",
      loginShellPath: () => Promise.resolve(null),
      listDir: (directory) => Promise.resolve(directory === "/usr/bin" ? ["git"] : []),
      isExecutable: (path) => Promise.resolve(path === "/usr/bin/git"),
    };

    expect(await detectGit(deps)).toMatchObject({
      status: "not-installed",
      path: "/usr/bin/git",
    });
    expect(ran).toEqual(["/usr/bin/xcode-select -p"]);
  });

  it("asks xcode-select only when the git that would run is /usr/bin/git on macOS", async () => {
    const homebrewFirst = recordingDeps({
      ...HOMEBREW,
      dirContents: { ...HOMEBREW.dirContents, "/usr/bin": ["git"] },
      envPath: "/opt/homebrew/bin:/usr/bin",
      developerToolsMissing: true,
    });
    expect(await detectGit(homebrewFirst.deps)).toMatchObject({ status: "available" });
    expect(homebrewFirst.calls).not.toContain("xcode-select -p");

    const linux = recordingDeps({
      envPath: "/usr/bin:/bin",
      dirContents: { "/usr/bin": ["git"] },
      executables: new Set(["/usr/bin/git"]),
      versions: { "/usr/bin/git": "2.43.0" },
      platform: "linux",
      developerToolsMissing: true,
    });
    expect(await detectGit(linux.deps)).toMatchObject({ status: "available" });
    expect(linux.calls).toEqual(["version /usr/bin/git"]);
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

/** A directory holding one executable shell script. */
function scriptDir(prefix: string, name: string, body: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return dir;
}

/** The host deps with every PATH source pinned to `envPath`, so nothing on this machine's
 *  own PATH or login shell can answer for the fixture. */
function hostDepsOn(envPath: string, platform: NodeJS.Platform = process.platform) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rennet-scd-home-")));
  scratch.push(home);
  return {
    ...defaultSourceControlDetectionDeps(),
    envPath,
    home,
    platform,
    loginShellPath: () => Promise.resolve(null),
  } satisfies SourceControlDetectionDeps;
}

describe.skipIf(process.platform === "win32")("detection runs the binary bare git runs", () => {
  it("reports a broken git that shadows a working one as unreachable, as the checkout runner sees it", async () => {
    const broken = scriptDir("rennet-broken-git-", "git", 'echo "git: broken build" >&2\nexit 1');
    const working = realpathSync(mkdtempSync(join(tmpdir(), "rennet-working-git-")));
    scratch.push(working);
    const realGit = realpathSync(
      execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
    );
    symlinkSync(realGit, join(working, "git"));
    const path = `${broken}:${working}`;

    // What the checkout runner does: a bare `git` on this PATH runs the broken one.
    const bare = await execa("git", ["--version"], {
      env: { PATH: path },
      extendEnv: false,
      reject: false,
    });
    expect(bare.exitCode).toBe(1);

    const git = await detectGit(hostDepsOn(path));
    expect(git).toMatchObject({ status: "unreachable", version: null, path: join(broken, "git") });
    expect(git.detail).toContain("git: broken build");
  });

  it("applies the same rule to git-lfs", async () => {
    const broken = scriptDir("rennet-broken-lfs-", "git-lfs", "exit 1");
    const working = scriptDir(
      "rennet-working-lfs-",
      "git-lfs",
      'echo "git-lfs/3.7.0 (GitHub; darwin arm64; go 1.24.4)"',
    );
    const lfs = await detectGitLfs(hostDepsOn(`${broken}:${working}`));
    expect(lfs).toMatchObject({
      status: "unreachable",
      version: null,
      path: join(broken, "git-lfs"),
    });
  });

  it("reads a real xcrun-shim git's output on macOS as not installed", async () => {
    const shim = scriptDir(
      "rennet-xcrun-git-",
      "git",
      'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun" >&2\nexit 1',
    );
    const git = await detectGit(hostDepsOn(shim, "darwin"));
    expect(git).toMatchObject({ status: "not-installed", path: join(shim, "git") });
    expect(git.detail).toContain("`xcode-select --install`");
  });
});

describe("wslSourceControlDetectionDeps", () => {
  it("runs the version and git lfs probes inside the distro, never on the host", async () => {
    const ran: string[][] = [];
    const run: LocusRun = async (file, args) => {
      ran.push([file, ...args]);
      const command = args.slice(args.indexOf("-e") + 1).join(" ");
      if (command === "/usr/bin/git --version") {
        return { exitCode: 0, stdout: "git version 2.43.0", stderr: "" };
      }
      if (command === "/usr/bin/git-lfs --version") {
        return {
          exitCode: 0,
          stdout: "git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2)",
          stderr: "",
        };
      }
      if (command === "/usr/bin/git lfs version") {
        return {
          exitCode: 0,
          stdout: "git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2)",
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    };
    const deps = await wslSourceControlDetectionDeps("Ubuntu", {
      discovery: {
        platform: "linux",
        envPath: "",
        home: "/home/rai",
        loginShellPath: () => Promise.resolve("/usr/bin:/bin"),
        listDir: (directory) => Promise.resolve(directory === "/usr/bin" ? ["git", "git-lfs"] : []),
        isExecutable: (path) => Promise.resolve(path.startsWith("/usr/bin/")),
      },
      run,
    });

    const [git, lfs] = await detectSourceControlTools(deps);

    expect(git).toMatchObject({ status: "available", version: "2.43.0", path: "/usr/bin/git" });
    expect(lfs).toMatchObject({ status: "available", version: "3.4.1", path: "/usr/bin/git-lfs" });
    expect(ran).toContainEqual(["wsl.exe", "-d", "Ubuntu", "-e", "/usr/bin/git", "lfs", "version"]);
    // Every probe went through the distro.
    for (const call of ran) expect(call.slice(0, 4)).toEqual(["wsl.exe", "-d", "Ubuntu", "-e"]);
  });

  it("reports git-lfs as unreachable when the distro's git cannot run it", async () => {
    const run: LocusRun = async (_file, args) => {
      const command = args.slice(args.indexOf("-e") + 1).join(" ");
      if (command.endsWith("--version")) {
        return { exitCode: 0, stdout: "version 3.4.1", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "git: 'lfs' is not a git command." };
    };
    const deps = await wslSourceControlDetectionDeps("Ubuntu", {
      discovery: {
        envPath: "",
        home: "/home/rai",
        loginShellPath: () => Promise.resolve("/usr/bin"),
        listDir: () => Promise.resolve(["git", "git-lfs"]),
        isExecutable: () => Promise.resolve(true),
      },
      run,
    });
    expect(await detectGitLfs(deps)).toMatchObject({ status: "unreachable" });
  });
});
