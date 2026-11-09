import { readFile } from "node:fs/promises";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { execa } from "execa";
import { defaultForgeDetectionDeps, type ForgeDetectionDeps } from "./forge-discovery";
import type { SourceControlToolId } from "./git-failure";
import type { GitExec } from "./git-range-diff";

/**
 * Source-control tool detection: `git` and `git-lfs` (review-preparation-reliability,
 * source-control-tooling spec, design decision 3).
 *
 * The same discipline as forge discovery, and the same effects: harvest the login-shell
 * PATH, union it with the inherited PATH and curated install directories, resolve each
 * candidate ourselves, and PROVE it by executing it. A file that is there but will not
 * answer is not reported as installed.
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

/** Forge detection's effects, minus the auth probe, plus the Git LFS health probe. */
export interface SourceControlDetectionDeps extends Omit<ForgeDetectionDeps, "probeAuth"> {
  /** Run `<gitPath> lfs version` under the daemon's environment; the version, or `null`. */
  probeGitLfs(gitPath: string): Promise<string | null>;
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
  | { readonly kind: "unanswered"; readonly path: string }
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

/** The first candidate that proves itself, else the first that was there and would not
 *  answer, else nothing. */
async function resolveBinary(
  binary: string,
  deps: SourceControlDetectionDeps,
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
  const tried = new Set<string>();
  let unanswered: string | null = null;
  for (const directory of directories) {
    const filename = resolveBinaryFilename(
      await deps.listDir(directory),
      binary,
      deps.platform,
      deps.pathExt,
    );
    if (filename === null) continue;
    const path = joinFor(directory, filename);
    if (tried.has(path)) continue;
    tried.add(path);
    if (!(await deps.isExecutable(path))) continue;
    const version = await deps.probeVersion(path);
    if (version !== null) return { kind: "resolved", path, version };
    unanswered ??= path;
  }
  return unanswered === null ? { kind: "missing" } : { kind: "unanswered", path: unanswered };
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
    const resolved = await resolveBinary("git", deps);
    switch (resolved.kind) {
      case "resolved":
        return {
          id: "git",
          version: resolved.version,
          status: "available",
          path: resolved.path,
          detail: "Git is installed.",
        };
      case "unanswered":
        return {
          id: "git",
          version: null,
          status: "unreachable",
          path: resolved.path,
          detail: `A \`git\` was found at \`${resolved.path}\`, but it did not answer \`git --version\`.`,
        };
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
    if (resolved.kind === "unanswered") {
      return {
        id: "git-lfs",
        version: null,
        status: "unreachable",
        path: resolved.path,
        ...required,
        detail: `A \`git-lfs\` was found at \`${resolved.path}\`, but it did not answer \`git-lfs --version\`.`,
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

/** The default effects: forge discovery's (login-shell PATH, filesystem, `--version`)
 *  plus `git lfs version` under this process's environment. */
export function defaultSourceControlDetectionDeps(): SourceControlDetectionDeps {
  const { probeAuth: _probeAuth, ...forge } = defaultForgeDetectionDeps();
  // One login-shell harvest per detection pass, however many binaries it resolves.
  let harvested: Promise<string | null> | undefined;
  return {
    ...forge,
    loginShellPath: () => {
      harvested ??= forge.loginShellPath();
      return harvested;
    },
    async probeGitLfs(gitPath: string): Promise<string | null> {
      try {
        const result = await execa(gitPath, ["lfs", "version"], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: COMMAND_TIMEOUT_MS,
        });
        return result.exitCode === 0 ? parseGitLfsVersion(result.stdout) : null;
      } catch {
        return null;
      }
    },
  };
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
