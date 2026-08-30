import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix as posixPath, win32 as win32Path } from "node:path";
import { locusCommand } from "@rennet/core";
import { execa } from "execa";
import { wslDiscoveryDeps } from "./harness-discovery";

/**
 * Forge (source-control) CLI detection — the `gh` engine, mirroring `harness-discovery.ts`.
 *
 * Restored in C17 (#483, "gh rides again": enterprise orgs forbid OAuth-app installs, so
 * the `gh auth token` path is wanted again). Reached through a `ForgeDetector` registry
 * shaped for #484's future (a second forge *could* register), but built with EXACTLY ONE
 * entry — GitHub / `gh`. Building GitLab / Bitbucket is out of scope (#484 is planning-only).
 *
 * Same discipline as harness discovery: never ask a shell to resolve the binary (a launchd
 * GUI PATH finds nothing, and `gh` may be shadowed by a shell function). We harvest PATH,
 * union it with curated install dirs, resolve candidates ourselves, and prove each by
 * EXECUTING `<gh> --version`; a proven binary's auth is then read from `gh auth status`.
 * Every effect is injected so a test can prove absence maps to `not-installed`, never a
 * stale hit (the rename-out-of-PATH positive control at unit scale).
 */

/** The honest state of a detected forge CLI. A subset of the client's `ToolStatus`: a
 *  forge CLI probe never yields `unreachable` (that is a host-daemon state, not a CLI one). */
export type ForgeStatus = "available" | "not-authenticated" | "not-installed";

/** One detected forge CLI on the host its daemon runs on. Structurally the wire
 *  `DetectedForge` (protocol) — validated at the dispatch boundary, mapped to a
 *  `DetectedTool` row by the client (which adds the label + enable toggle). */
export interface DetectedForge {
  readonly id: string;
  readonly version: string | null;
  readonly status: ForgeStatus;
  /** One line of honest state and the exact fix; backticked spans render as code. */
  readonly detail: string;
}

/** A forge the detector knows how to probe. The registry is singleton today (#484). */
export interface ForgeSpec {
  readonly id: string;
  readonly binary: string;
  /** Curated install dirs for `binary`, checked even when not on PATH (the launchd case). */
  knownDirectories(home: string, platform: NodeJS.Platform | undefined): readonly string[];
  /** Compose this forge's honest `detail` line from its detection outcome. */
  detailFor(status: ForgeStatus): string;
}

/** Injected effects — mirrors `DiscoveryDeps`, plus the forge auth probe. */
export interface ForgeDetectionDeps {
  /** The user's login-shell PATH, harvested once. `null` when the harvest fails. */
  loginShellPath(): Promise<string | null>;
  /** `process.env.PATH` at app start. */
  readonly envPath: string;
  /** The user's home directory. */
  readonly home: string;
  /** Directory listing; returns `[]` on any error (missing dir, permission). */
  listDir(directory: string): Promise<readonly string[]>;
  /** X_OK (F_OK on Windows) check on a resolved path. */
  isExecutable(path: string): Promise<boolean>;
  /** Execute `<path> --version` and return the parsed version, or `null`. */
  probeVersion(path: string): Promise<string | null>;
  /** Probe the forge CLI's auth state (`gh auth status`): true iff authenticated. */
  probeAuth(path: string): Promise<boolean>;
  /** The platform the binary lives on. Absent ⇒ POSIX. */
  readonly platform?: NodeJS.Platform;
  /** PATHEXT for the candidate locus, not necessarily the host process. */
  readonly pathExt?: string;
}

function delimiterFor(platform: NodeJS.Platform | undefined): string {
  return platform === "win32" ? ";" : ":";
}

function joinFor(platform: NodeJS.Platform | undefined): (...parts: string[]) => string {
  return platform === "win32" ? win32Path.join : posixPath.join;
}

function splitPath(value: string, delimiter: string): readonly string[] {
  return value.split(delimiter).filter((entry) => entry.length > 0);
}

/** Which filename in a directory listing IS the binary, honouring Windows PATHEXT. */
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

type ForgeBinaryResolution =
  | { readonly kind: "resolved"; readonly path: string; readonly version: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failure" };

/**
 * Resolve the first proven binary while preserving whether an executable candidate
 * existed. Detection still projects both negative outcomes as "not installed", but
 * credential resolution must not mistake a broken present CLI for an absent one.
 */
async function resolveForgeBinaryDetailed(
  spec: ForgeSpec,
  deps: ForgeDetectionDeps,
): Promise<ForgeBinaryResolution> {
  const delimiter = delimiterFor(deps.platform);
  const join = joinFor(deps.platform);
  const known = spec.knownDirectories(deps.home, deps.platform);
  const harvested = await deps.loginShellPath();
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const directory of [
    ...splitPath(harvested ?? "", delimiter),
    ...splitPath(deps.envPath, delimiter),
    ...known,
  ]) {
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }

  const resolved = new Set<string>();
  let foundExecutableCandidate = false;
  for (const directory of directories) {
    const entries = await deps.listDir(directory);
    const filename = resolveBinaryFilename(entries, spec.binary, deps.platform, deps.pathExt);
    if (filename === null) continue;
    const path = join(directory, filename);
    if (resolved.has(path)) continue;
    resolved.add(path);
    if (!(await deps.isExecutable(path))) continue;
    foundExecutableCandidate = true;
    const version = await deps.probeVersion(path);
    // A binary that will not answer `--version` is not proven to be the forge CLI; keep
    // looking (a later candidate may be real) rather than reporting a stale/false hit.
    if (version !== null) return { kind: "resolved", path, version };
  }
  return foundExecutableCandidate ? { kind: "failure" } : { kind: "missing" };
}

/** Resolve the first proven (executable + version-answering) binary for `spec`, or null. */
export async function resolveForgeBinary(
  spec: ForgeSpec,
  deps: ForgeDetectionDeps,
): Promise<{ readonly path: string; readonly version: string } | null> {
  const resolved = await resolveForgeBinaryDetailed(spec, deps);
  return resolved.kind === "resolved" ? { path: resolved.path, version: resolved.version } : null;
}

/**
 * Detect one forge CLI. Absent binary ⇒ `not-installed`; present-and-proven ⇒
 * `available` when `gh auth status` succeeds, `not-authenticated` when it does not.
 * Never fabricates a version for a binary that is not there.
 */
export async function detectForge(
  spec: ForgeSpec,
  deps: ForgeDetectionDeps,
): Promise<DetectedForge> {
  const resolved = await resolveForgeBinary(spec, deps);
  if (resolved === null) {
    return {
      id: spec.id,
      version: null,
      status: "not-installed",
      detail: spec.detailFor("not-installed"),
    };
  }
  const authed = await deps.probeAuth(resolved.path);
  const status: ForgeStatus = authed ? "available" : "not-authenticated";
  return { id: spec.id, version: resolved.version, status, detail: spec.detailFor(status) };
}

/** GitHub / `gh` — the sole built forge (#484 seam; #483 gh rides again). */
export const githubForge: ForgeSpec = {
  id: "github",
  binary: "gh",
  knownDirectories(home, platform) {
    if (platform === "win32") {
      const env = process.env;
      const dirs: string[] = [];
      if (env.ProgramFiles) dirs.push(win32Path.join(env.ProgramFiles, "GitHub CLI"));
      const userProfile = env.USERPROFILE ?? env.HOME ?? home;
      if (userProfile) dirs.push(win32Path.join(userProfile, "scoop", "shims"));
      return dirs;
    }
    const join = posixPath.join;
    return [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".local", "bin"),
      "/home/linuxbrew/.linuxbrew/bin",
    ];
  },
  detailFor(status) {
    switch (status) {
      case "available":
        return "Authenticated with GitHub through the `gh` CLI.";
      case "not-authenticated":
        return "`gh` is installed but not signed in. Run `gh auth login`.";
      case "not-installed":
        return "The `gh` CLI was not found on this host. Install it from `cli.github.com`.";
    }
  },
};

/** The forge detector registry — EXACTLY ONE entry (#484 boundary: no GitLab/Bitbucket). */
export const FORGE_REGISTRY: readonly ForgeSpec[] = [githubForge];

export type ForgeCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

/** Host-only result of asking the proven GitHub CLI for its active github.com token. */
export type GitHubCliTokenResult =
  | { readonly kind: "missing" }
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "failure" };

const FORGE_COMMAND_TIMEOUT_MS = 10_000;

export function createForgeCommandRunner(timeoutMs = FORGE_COMMAND_TIMEOUT_MS): ForgeCommandRunner {
  return async (executable, args) => {
    const result = await execa(executable, [...args], {
      reject: false,
      shell: false,
      stdin: "ignore",
      stderr: "ignore",
      timeout: timeoutMs,
    });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
  };
}

const runForgeCommand = createForgeCommandRunner();

/**
 * Read the user's GitHub credential from the exact `gh` binary this host proved.
 * Only a missing CLI permits fallback. Once a binary is proven, an empty, non-zero,
 * timed-out, or thrown token command remains a `gh`-owned failure so Rennet never
 * changes identity silently. Neither output nor errors escape this boundary.
 */
export async function resolveGitHubCliToken(
  deps: ForgeDetectionDeps,
  run: ForgeCommandRunner = runForgeCommand,
): Promise<GitHubCliTokenResult> {
  const resolved = await resolveForgeBinaryDetailed(githubForge, deps);
  if (resolved.kind === "missing") return { kind: "missing" };
  if (resolved.kind === "failure") return { kind: "failure" };
  try {
    const result = await run(resolved.path, ["auth", "token", "--hostname", "github.com"]);
    if (result.exitCode !== 0) return { kind: "failure" };
    const token = result.stdout.trim();
    return token.length > 0 ? { kind: "token", token } : { kind: "failure" };
  } catch {
    return { kind: "failure" };
  }
}

/** Detect every registered forge on the host these deps run on. */
export function detectForges(
  deps: ForgeDetectionDeps,
  registry: readonly ForgeSpec[] = FORGE_REGISTRY,
): Promise<DetectedForge[]> {
  return Promise.all(registry.map((spec) => detectForge(spec, deps)));
}

/**
 * Forge-detection effects for a WSL DISTRO (C17 amendment B) — the distro's own PATH, its own
 * filesystem, its own `gh`. Reuses `wslDiscoveryDeps` verbatim (identical harvest/list/probe
 * contract) and adds the one effect forge detection needs beyond harness discovery: `gh auth
 * status`, run INSIDE the distro. So a WSL host card shows the distro's `gh` and its real auth
 * state, never the Windows host's.
 */
export async function wslForgeDetectionDeps(distro: string): Promise<ForgeDetectionDeps> {
  const discovery = await wslDiscoveryDeps(distro);
  return {
    ...discovery,
    async probeAuth(path: string): Promise<boolean> {
      const command = locusCommand({ kind: "wsl", distro }, path, ["auth", "status"]);
      try {
        const result = await execa(command.file, [...command.args], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: FORGE_COMMAND_TIMEOUT_MS,
        });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
  };
}

/** The default effects: real login shell, filesystem, and process execution. Mirrors
 *  `defaultDiscoveryDeps`, adding the `gh auth status` probe. */
export function defaultForgeDetectionDeps(): ForgeDetectionDeps {
  const platform = process.platform;
  return {
    platform,
    pathExt: process.env.PATHEXT ?? "",
    async loginShellPath(): Promise<string | null> {
      if (platform === "win32") return null;
      const shell = process.env.SHELL ?? "/bin/zsh";
      try {
        const result = await execa(shell, ["-ilc", 'printf %s "$PATH"'], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: FORGE_COMMAND_TIMEOUT_MS,
        });
        return result.exitCode === 0 ? result.stdout : null;
      } catch {
        return null;
      }
    },
    envPath: process.env.PATH ?? "",
    home: homedir(),
    async listDir(directory: string): Promise<readonly string[]> {
      try {
        return await readdir(directory);
      } catch {
        return [];
      }
    },
    async isExecutable(path: string): Promise<boolean> {
      try {
        await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async probeVersion(path: string): Promise<string | null> {
      try {
        const result = await execa(path, ["--version"], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: FORGE_COMMAND_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
    async probeAuth(path: string): Promise<boolean> {
      // `gh auth status` exits 0 iff signed in to at least one host; non-zero otherwise.
      try {
        const result = await execa(path, ["auth", "status"], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: FORGE_COMMAND_TIMEOUT_MS,
        });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
  };
}
