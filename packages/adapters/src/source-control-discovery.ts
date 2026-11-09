import { readFile } from "node:fs/promises";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { type Locus, locusCommand } from "@rennet/core";
import { execa } from "execa";
import { defaultForgeDetectionDeps, type ForgeDetectionDeps } from "./forge-discovery";
import type { SourceControlToolId } from "./git-failure";
import type { GitExec } from "./git-range-diff";
import { type DiscoveryDeps, wslDiscoveryDeps } from "./harness-discovery";

/**
 * Source-control tool detection: `git` and `git-lfs` (review-preparation-reliability,
 * source-control-tooling spec, design decision 3).
 *
 * The same discipline as forge discovery, and the same effects: harvest the login-shell
 * PATH, union it with the inherited PATH and curated install directories, resolve each
 * candidate ourselves, and PROVE it by executing it. A file that is there but will not
 * answer is not reported as installed.
 *
 * ⚠️ THE FIRST CANDIDATE IS THE ANSWER, WORKING OR NOT. Checkouts run a bare `git`, which
 * resolves to the first executable `git` on the PATH, in the same order the daemon's PATH
 * is hydrated (login shell, then inherited, then curated). If that one is broken, every
 * checkout hits it, so detection reports it as unreachable with its path. It does not
 * skip to a later, working `git` that no checkout would ever run. `git-lfs` follows the
 * same rule, because git finds `git lfs` on the PATH the same way.
 *
 * Probes run per execution locus: `defaultSourceControlDetectionDeps` for the host,
 * `wslSourceControlDetectionDeps` for a WSL distro, chosen by `sourceControlDetectionDepsFor`.
 *
 * The states are the detection row's own (`available`, `not-installed`, `unreachable`),
 * so Settings and the first-run tools stage render these rows with no new vocabulary:
 *
 *   • available — proven by its version answer (and, for Git LFS, by git running it);
 *   • not-installed — nothing on any searched directory answers to the name;
 *   • unreachable — a binary is there but could not be asked, or git cannot run it.
 *
 * `git-lfs` health is `git lfs version` run through the proven git under the daemon's own
 * environment. That is the question the sighting turned on: `git-lfs` sat in
 * `/opt/homebrew/bin`, the user's terminal found it, and git under launchd's PATH did not.
 */

export type SourceControlToolStatus = "available" | "not-installed" | "unreachable";

export interface DetectedSourceControlTool {
  readonly id: SourceControlToolId;
  /** The proven version, or `null` when nothing was proven. Never a guess. */
  readonly version: string | null;
  readonly status: SourceControlToolStatus;
  /** The resolved binary, when one was found (proven or not). */
  readonly path: string | null;
  /** Whether any project on this locus needs the tool. Present only when the caller said. */
  readonly required?: boolean;
  /** One line of honest state and the exact fix; backticked spans render as code. */
  readonly detail: string;
}

/** What `<binary> --version` answered: a version, or nothing and what it printed instead. */
export type ToolVersionProbe =
  | { readonly version: string }
  | { readonly version: null; readonly output: string };

/** Forge detection's effects, minus the auth probe, with a version probe that keeps what a
 *  failing binary printed, plus the Git LFS health probe. Every probe runs in the locus. */
export interface SourceControlDetectionDeps
  extends Omit<ForgeDetectionDeps, "probeAuth" | "probeVersion"> {
  /** Run `<path> --version` in the locus. */
  probeVersion(path: string): Promise<ToolVersionProbe>;
  /** Run `<gitPath> lfs version` in the locus, under the daemon's environment; the version,
   *  or `null`. */
  probeGitLfs(gitPath: string): Promise<string | null>;
  /** macOS: whether `xcode-select -p` says the command line developer tools are missing.
   *  `false` when it could not be asked. Absent ⇒ never asked. */
  developerToolsMissing?(): Promise<boolean>;
}

export interface DetectSourceControlOptions {
  /** Whether a project on this locus uses Git LFS. Absent ⇒ not reported either way. */
  readonly lfsRequired?: boolean;
}

const COMMAND_TIMEOUT_MS = 10_000;

function knownDirectories(home: string, platform: NodeJS.Platform | undefined): readonly string[] {
  if (platform === "win32") {
    const env = process.env;
    const dirs: string[] = [];
    const programFiles = env.ProgramW6432 ?? env.ProgramFiles;
    if (programFiles) {
      dirs.push(win32Path.join(programFiles, "Git", "cmd"));
      dirs.push(win32Path.join(programFiles, "Git LFS"));
    }
    const userProfile = env.USERPROFILE ?? env.HOME ?? home;
    if (userProfile) dirs.push(win32Path.join(userProfile, "scoop", "shims"));
    return dirs;
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    posixPath.join(home, ".local", "bin"),
    "/home/linuxbrew/.linuxbrew/bin",
  ];
}

type Resolution =
  | { readonly kind: "resolved"; readonly path: string; readonly version: string }
  | { readonly kind: "unanswered"; readonly path: string; readonly output: string }
  /** A placeholder that is known not to be the tool, so it was never run. */
  | { readonly kind: "shim"; readonly path: string }
  | { readonly kind: "missing" };

function resolveBinaryFilename(
  entries: readonly string[],
  base: string,
  platform: NodeJS.Platform | undefined,
  pathExt: string | undefined,
): string | null {
  if (platform === "win32") {
    const byLowerCase = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
    for (const extension of (pathExt ?? "").split(";").filter(Boolean)) {
      const actual = byLowerCase.get(`${base}${extension}`.toLowerCase());
      if (actual !== undefined) return actual;
    }
    return byLowerCase.get(base.toLowerCase()) ?? null;
  }
  return entries.includes(base) ? base : null;
}

/** The first executable candidate, in PATH order, proven or not: the one a bare `binary`
 *  would run. Nothing when no searched directory has one. `isShim` is asked before the
 *  candidate is run, and a shim is reported without running it. */
async function resolveBinary(
  binary: string,
  deps: SourceControlDetectionDeps,
  isShim?: (path: string) => Promise<boolean>,
): Promise<Resolution> {
  const delimiter = deps.platform === "win32" ? ";" : ":";
  const joinFor = deps.platform === "win32" ? win32Path.join : posixPath.join;
  const harvested = await deps.loginShellPath();
  const directories: string[] = [];
  for (const directory of [
    ...(harvested ?? "").split(delimiter),
    ...deps.envPath.split(delimiter),
    ...knownDirectories(deps.home, deps.platform),
  ]) {
    if (directory.length > 0 && !directories.includes(directory)) directories.push(directory);
  }
  for (const directory of directories) {
    const filename = resolveBinaryFilename(
      await deps.listDir(directory),
      binary,
      deps.platform,
      deps.pathExt,
    );
    if (filename === null) continue;
    const path = joinFor(directory, filename);
    // A file the OS will not execute is skipped by the PATH search too.
    if (!(await deps.isExecutable(path))) continue;
    // The first executable one is what runs. A failure here is the answer: a later
    // candidate that works is one no bare `git` would ever reach.
    if (isShim !== undefined && (await isShim(path))) return { kind: "shim", path };
    const probe = await deps.probeVersion(path);
    return probe.version === null
      ? { kind: "unanswered", path, output: probe.output }
      : { kind: "resolved", path, version: probe.version };
  }
  return { kind: "missing" };
}

/** The xcrun shim `/usr/bin/git` is on a Mac without the Command Line Tools: it is on the
 *  PATH, it is executable, and all it does is say the tools are missing. A broken tools
 *  install says "invalid active developer path"; a fresh Mac says "No developer tools were
 *  found", whether or not it could open the install dialog. */
const XCRUN_WITHOUT_TOOLS =
  /xcrun: error: invalid active developer path|No developer tools were found/i;

/** Where macOS keeps that shim. */
const MACOS_GIT_SHIM = "/usr/bin/git";

/**
 * Whether the git that would run is the macOS shim with no developer tools behind it.
 * Asked of `xcode-select -p`, which only reads the configured path, because running the
 * shim itself on a fresh Mac opens the system's install dialog: detection must never do
 * that. Only for `/usr/bin/git` on macOS, the one path the shim lives at.
 */
function isGitShimWithoutTools(
  deps: SourceControlDetectionDeps,
): ((path: string) => Promise<boolean>) | undefined {
  const developerToolsMissing = deps.developerToolsMissing;
  if (deps.platform !== "darwin" || developerToolsMissing === undefined) return undefined;
  return async (path) => path === MACOS_GIT_SHIM && (await developerToolsMissing());
}

const DEVELOPER_TOOLS_MISSING_DETAIL =
  "Git is not installed: the macOS command line developer tools are missing. Run `xcode-select --install`, or `brew install git`.";

/** One line of what a failing binary printed, for a detail. */
function firstLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.slice(0, 200) ?? ""
  );
}

function gitMissingDetail(platform: NodeJS.Platform | undefined): string {
  if (platform === "darwin") {
    return "Git was not found on this host. Run `xcode-select --install`, or `brew install git`.";
  }
  if (platform === "win32")
    return "Git was not found on this host. Run `winget install --id Git.Git`.";
  return "Git was not found on this host. Install it with your package manager, for example `sudo apt-get install git`.";
}

function lfsMissingDetail(platform: NodeJS.Platform | undefined): string {
  if (platform === "darwin") {
    return "Git LFS was not found on this host. Run `brew install git-lfs`, then `git lfs install`.";
  }
  if (platform === "win32") {
    return "Git LFS was not found on this host. Run `winget install --id GitHub.GitLFS`, then `git lfs install`.";
  }
  return "Git LFS was not found on this host. Install `git-lfs` with your package manager, then run `git lfs install`.";
}

/** Detect `git` on the host these deps describe. */
export async function detectGit(
  deps: SourceControlDetectionDeps,
): Promise<DetectedSourceControlTool> {
  try {
    const resolved = await resolveBinary("git", deps, isGitShimWithoutTools(deps));
    switch (resolved.kind) {
      case "resolved":
        return {
          id: "git",
          version: resolved.version,
          status: "available",
          path: resolved.path,
          detail: "Git is installed.",
        };
      case "shim":
        return {
          id: "git",
          version: null,
          status: "not-installed",
          path: resolved.path,
          detail: DEVELOPER_TOOLS_MISSING_DETAIL,
        };
      case "unanswered": {
        if (deps.platform === "darwin" && XCRUN_WITHOUT_TOOLS.test(resolved.output)) {
          return {
            id: "git",
            version: null,
            status: "not-installed",
            path: resolved.path,
            detail: DEVELOPER_TOOLS_MISSING_DETAIL,
          };
        }
        const said = firstLine(resolved.output);
        return {
          id: "git",
          version: null,
          status: "unreachable",
          path: resolved.path,
          detail: `The first \`git\` on the PATH, \`${resolved.path}\`, did not answer \`git --version\`${said.length > 0 ? ` (it said: ${said})` : ""}. Fix or remove it, or put a working Git before it on the PATH.`,
        };
      }
      case "missing":
        return {
          id: "git",
          version: null,
          status: "not-installed",
          path: null,
          detail: gitMissingDetail(deps.platform),
        };
    }
  } catch {
    return {
      id: "git",
      version: null,
      status: "unreachable",
      path: null,
      detail: "Git could not be checked on this host.",
    };
  }
}

/**
 * Detect `git-lfs`. Proven twice: the binary answers its own version, and the proven git
 * runs it (`git lfs version`). Pass the `git` row already detected to skip resolving it
 * again.
 */
export async function detectGitLfs(
  deps: SourceControlDetectionDeps,
  options: DetectSourceControlOptions & { readonly git?: DetectedSourceControlTool } = {},
): Promise<DetectedSourceControlTool> {
  const required = options.lfsRequired === undefined ? {} : { required: options.lfsRequired };
  try {
    const resolved = await resolveBinary("git-lfs", deps);
    if (resolved.kind === "missing") {
      return {
        id: "git-lfs",
        version: null,
        status: "not-installed",
        path: null,
        ...required,
        detail:
          options.lfsRequired === false
            ? "Git LFS is not installed. No project here uses it, so nothing needs it yet."
            : lfsMissingDetail(deps.platform),
      };
    }
    // No shim check is passed for git-lfs, so anything unproven here was run and did not answer.
    if (resolved.kind !== "resolved") {
      return {
        id: "git-lfs",
        version: null,
        status: "unreachable",
        path: resolved.path,
        ...required,
        detail: `The first \`git-lfs\` on the PATH, \`${resolved.path}\`, did not answer \`git-lfs --version\`. Fix or remove it, or put a working Git LFS before it on the PATH.`,
      };
    }
    const git = options.git ?? (await detectGit(deps));
    if (git.status !== "available" || git.path === null) {
      return {
        id: "git-lfs",
        version: resolved.version,
        status: "unreachable",
        path: resolved.path,
        ...required,
        detail: "Git LFS is installed, but Git is not, so it cannot be used.",
      };
    }
    const health = await deps.probeGitLfs(git.path);
    if (health === null) {
      return {
        id: "git-lfs",
        version: resolved.version,
        status: "unreachable",
        path: resolved.path,
        ...required,
        detail: `Git LFS is installed at \`${resolved.path}\`, but \`git lfs version\` fails, so Git cannot use it.`,
      };
    }
    return {
      id: "git-lfs",
      version: health,
      status: "available",
      path: resolved.path,
      ...required,
      detail: "Git LFS is installed and Git can use it.",
    };
  } catch {
    return {
      id: "git-lfs",
      version: null,
      status: "unreachable",
      path: null,
      ...required,
      detail: "Git LFS could not be checked on this host.",
    };
  }
}

/** Detect `git` then `git-lfs` (which reuses the proven git). */
export async function detectSourceControlTools(
  deps: SourceControlDetectionDeps,
  options: DetectSourceControlOptions = {},
): Promise<readonly [DetectedSourceControlTool, DetectedSourceControlTool]> {
  const git = await detectGit(deps);
  const lfs = await detectGitLfs(deps, { ...options, git });
  return [git, lfs];
}

/** Detect one tool by id — what an install runner re-probes with. */
export function detectSourceControlTool(
  tool: SourceControlToolId,
  deps: SourceControlDetectionDeps,
  options: DetectSourceControlOptions = {},
): Promise<DetectedSourceControlTool> {
  return tool === "git" ? detectGit(deps) : detectGitLfs(deps, options);
}

/** The version `git lfs version` prints (`git-lfs/3.7.0 (GitHub; darwin arm64; go 1.24)`). */
export function parseGitLfsVersion(output: string): string | null {
  return (
    output.match(/git-lfs\/(\d+\.\d+\.\d+)/)?.[1] ?? output.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  );
}

/** What one probe process returned. */
export interface LocusRunResult {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one command, bounded, never throwing for a non-zero exit. The seam a test fakes. */
export type LocusRun = (file: string, args: readonly string[]) => Promise<LocusRunResult>;

const execaLocusRun: LocusRun = async (file, args) => {
  const result = await execa(file, [...args], {
    reject: false,
    shell: false,
    stdin: "ignore",
    timeout: COMMAND_TIMEOUT_MS,
  });
  return {
    exitCode: result.exitCode,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
};

/** The version and health probes, run through `locus` with `run`. */
function locusProbes(
  locus: Locus,
  run: LocusRun,
): Pick<SourceControlDetectionDeps, "probeVersion" | "probeGitLfs"> {
  const inLocus = (program: string, args: readonly string[]) => {
    const command = locusCommand(locus, program, args);
    return run(command.file, command.args);
  };
  return {
    async probeVersion(path: string): Promise<ToolVersionProbe> {
      try {
        const result = await inLocus(path, ["--version"]);
        const version =
          result.exitCode === 0 ? (result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
        return version === null
          ? { version: null, output: `${result.stderr}\n${result.stdout}`.trim() }
          : { version };
      } catch (error) {
        return { version: null, output: error instanceof Error ? error.message : String(error) };
      }
    },
    async probeGitLfs(gitPath: string): Promise<string | null> {
      try {
        const result = await inLocus(gitPath, ["lfs", "version"]);
        return result.exitCode === 0 ? parseGitLfsVersion(result.stdout) : null;
      } catch {
        return null;
      }
    },
  };
}

/** The default (host) effects: forge discovery's login-shell PATH and filesystem, with
 *  `--version` and `git lfs version` run on the host under this process's environment. */
export function defaultSourceControlDetectionDeps(
  run: LocusRun = execaLocusRun,
): SourceControlDetectionDeps {
  const {
    probeAuth: _probeAuth,
    probeVersion: _probeVersion,
    ...forge
  } = defaultForgeDetectionDeps();
  // One login-shell harvest per detection pass, however many binaries it resolves.
  let harvested: Promise<string | null> | undefined;
  return {
    ...forge,
    loginShellPath: () => {
      harvested ??= forge.loginShellPath();
      return harvested;
    },
    ...locusProbes({ kind: "host" }, run),
    async developerToolsMissing(): Promise<boolean> {
      try {
        const result = await run("/usr/bin/xcode-select", ["-p"]);
        return result.exitCode !== undefined && result.exitCode !== 0;
      } catch {
        return false;
      }
    },
  };
}

/** The distro-side filesystem and PATH effects a WSL detection pass reads. */
export type WslDiscoveryEffects = Pick<
  DiscoveryDeps,
  "loginShellPath" | "envPath" | "home" | "listDir" | "isExecutable" | "platform" | "pathExt"
>;

/**
 * Source-control detection effects for a WSL DISTRO: the distro's own PATH, filesystem and
 * binaries (harness discovery's `wslDiscoveryDeps`, as forge detection uses them), with the
 * version and `git lfs version` probes run INSIDE the distro through `wsl.exe`. A WSL row
 * never borrows the Windows host's git or git-lfs.
 */
export async function wslSourceControlDetectionDeps(
  distro: string,
  effects: { readonly discovery?: WslDiscoveryEffects; readonly run?: LocusRun } = {},
): Promise<SourceControlDetectionDeps> {
  const discovery = effects.discovery ?? (await wslDiscoveryDeps(distro));
  let harvested: Promise<string | null> | undefined;
  return {
    platform: discovery.platform ?? "linux",
    ...(discovery.pathExt === undefined ? {} : { pathExt: discovery.pathExt }),
    envPath: discovery.envPath,
    home: discovery.home,
    loginShellPath: () => {
      harvested ??= discovery.loginShellPath();
      return harvested;
    },
    listDir: (directory) => discovery.listDir(directory),
    isExecutable: (path) => discovery.isExecutable(path),
    ...locusProbes({ kind: "wsl", distro }, effects.run ?? execaLocusRun),
  };
}

/** The detection effects for one execution locus. */
export function sourceControlDetectionDepsFor(locus: Locus): Promise<SourceControlDetectionDeps> {
  return locus.kind === "wsl"
    ? wslSourceControlDetectionDeps(locus.distro)
    : Promise.resolve(defaultSourceControlDetectionDeps());
}

/** Whether `.gitattributes` text routes any path through the LFS filter. Comments are
 *  ignored; an attribute macro that sets the filter counts. */
export function gitattributesUseLfs(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some(
      (line) => line.length > 0 && !line.startsWith("#") && /(?:^|\s)filter=lfs(?:\s|$)/.test(line),
    );
}

export interface RepoUsesLfsOptions {
  /** Read `.gitattributes` at this ref through git instead of from the working tree —
   *  the design reads it at HEAD of the default branch. Needs `git`. */
  readonly ref?: string;
  readonly git?: GitExec;
}

/**
 * Whether the repository at `root` uses Git LFS: its top-level `.gitattributes` names
 * `filter=lfs`. Read from the working tree by default, or at `options.ref` through
 * `options.git`. A missing or unreadable file is `false`.
 */
export async function repoUsesLfs(
  root: string,
  options: RepoUsesLfsOptions = {},
): Promise<boolean> {
  if (options.ref !== undefined && options.git !== undefined) {
    const text = await options
      .git(root, ["show", `${options.ref}:.gitattributes`], { reject: false })
      .catch(() => "");
    return gitattributesUseLfs(text);
  }
  try {
    return gitattributesUseLfs(await readFile(join(root, ".gitattributes"), "utf8"));
  } catch {
    return false;
  }
}
