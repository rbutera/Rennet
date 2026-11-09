import { userInfo } from "node:os";
import { execa } from "execa";

/**
 * The user's tool PATH, resolved the way their terminal sees it (daemon-process-environment).
 *
 * A Rennet launched from the Dock starts its detached daemon with launchd's bare PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), and every git child inherits it. When the user's git
 * config requires the LFS filter and `git-lfs` lives in `/opt/homebrew/bin`, `git worktree
 * add` dies with "git-lfs: command not found", and no retry can fix it because the daemon
 * outlives the app. So the daemon resolves PATH once at startup, from:
 *
 *   1. the user's login shell (`$SHELL -ilc`), read between markers so rc-file banners,
 *      motd text and "can't set tty pgrp" noise never leak into the value, bounded by a
 *      5 s timeout;
 *   2. else, on macOS, the session manager's PATH (`launchctl getenv PATH`);
 *
 * unioned with the inherited PATH and the platform's package-manager directories, in that
 * order, duplicates removed. Every step can fail and the daemon still starts.
 *
 * Ported from the vendored T3 Code precedent (`vendor/t3code/apps/server/src/os-jank.ts`,
 * `vendor/t3code/packages/shared/src/shell.ts`), not imported: Rennet code may not import
 * `@t3tools/*` outside its two seams. Windows has no POSIX login shell, so there it is a
 * no-op that returns the inherited PATH.
 */

/** The login-shell read gives up after this long and falls back (spec: slow or noisy shell). */
export const LOGIN_SHELL_TIMEOUT_MS = 5_000;
/** `launchctl getenv` is a local IPC call; it answers in milliseconds or not at all. */
export const LAUNCHCTL_TIMEOUT_MS = 2_000;

const PATH_START_MARKER = "__RENNET_PATH_START__";
const PATH_END_MARKER = "__RENNET_PATH_END__";

/**
 * Printed between two markers so only the value between them is read. `printenv` rather
 * than `echo $PATH` keeps the command shell-agnostic (fish has no `$PATH` string form).
 */
export const LOGIN_SHELL_PATH_COMMAND = [
  `printf '%s\\n' '${PATH_START_MARKER}'`,
  "printenv PATH || true",
  `printf '%s\\n' '${PATH_END_MARKER}'`,
].join("; ");

/** What one bounded child run reported. Never throws: a spawn failure is `failed`. */
export interface UserPathRunResult {
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly failed: boolean;
}

export interface UserPathDeps {
  readonly platform: NodeJS.Platform;
  /** The environment being hydrated: its `SHELL` picks the login shell, its `PATH` is kept. */
  readonly env: NodeJS.ProcessEnv;
  /** The account's login shell from the user database, tried after `$SHELL`. */
  readonly userShell: () => string | undefined;
  /** Run one command with a timeout, stdin closed and no shell wrapper. */
  readonly run: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<UserPathRunResult>;
  /** Told why a step fell through, for the daemon log. */
  readonly warn: (message: string) => void;
}

async function runBounded(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<UserPathRunResult> {
  try {
    const result = await execa(file, [...args], {
      reject: false,
      shell: false,
      stdin: "ignore",
      timeout: timeoutMs,
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      timedOut: result.timedOut === true,
      failed: result.failed === true,
    };
  } catch {
    return { stdout: "", timedOut: false, failed: true };
  }
}

function readUserShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/** The real effects: process env, the account's shell, execa with a timeout. */
export function defaultUserPathDeps(env: NodeJS.ProcessEnv = process.env): UserPathDeps {
  return {
    platform: process.platform,
    env,
    userShell: readUserShell,
    run: runBounded,
    warn: () => undefined,
  };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The value between the markers, or undefined when either marker is missing or it is empty. */
export function extractMarkedPath(output: string): string | undefined {
  const start = output.indexOf(PATH_START_MARKER);
  if (start === -1) return undefined;
  const valueStart = start + PATH_START_MARKER.length;
  const end = output.indexOf(PATH_END_MARKER, valueStart);
  if (end === -1) return undefined;
  return nonEmpty(output.slice(valueStart, end));
}

/** `$SHELL`, then the account's shell, then the platform default, each once. */
export function listLoginShells(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell: string | undefined,
): readonly string[] {
  const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  const shells: string[] = [];
  for (const candidate of [nonEmpty(shell), nonEmpty(userShell), fallback]) {
    if (candidate && !shells.includes(candidate)) shells.push(candidate);
  }
  return shells;
}

/** The package-manager directories a Dock-launched process misses (Homebrew on both arches). */
export function curatedPathDirectories(platform: NodeJS.Platform): readonly string[] {
  if (platform === "win32") return [];
  if (platform === "darwin") return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  return ["/usr/local/bin"];
}

/** Concatenate PATH lists in order, dropping blanks and every repeat after the first. */
export function mergePathEntries(
  lists: ReadonlyArray<string | null | undefined>,
  delimiter: string,
): string {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list.split(delimiter)) {
      const entry = raw.trim();
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(delimiter);
}

/**
 * The login shell's PATH, read between markers, or null. Tries each candidate shell in
 * turn, but a TIMEOUT ends the search: a shell that hangs once will hang again, and the
 * daemon must not pay the budget twice before it serves. Null on Windows.
 */
export async function readLoginShellPath(
  deps: UserPathDeps = defaultUserPathDeps(),
): Promise<string | null> {
  if (deps.platform === "win32") return null;
  for (const shell of listLoginShells(deps.platform, deps.env.SHELL, deps.userShell())) {
    // csh and tcsh reject `-ilc` (`Unknown option: -lc`: `-l` must be their only flag), so
    // they print no markers. That is not fatal: the loop moves on to the account's shell
    // and then the platform default (`/bin/zsh` on macOS, `/bin/sh` elsewhere).
    const result = await deps.run(
      shell,
      ["-ilc", LOGIN_SHELL_PATH_COMMAND],
      LOGIN_SHELL_TIMEOUT_MS,
    );
    // Markers, not the exit code, decide: an interactive shell whose rc file errors still
    // prints the value, and one that exits 0 after printing only a banner did not.
    const path = extractMarkedPath(result.stdout);
    if (path) return path;
    if (result.timedOut) {
      deps.warn(`login shell ${shell} did not answer within ${LOGIN_SHELL_TIMEOUT_MS}ms`);
      return null;
    }
    deps.warn(`login shell ${shell} did not report PATH`);
  }
  return null;
}

/** macOS's session-manager PATH (`launchctl getenv PATH`), or null elsewhere and on failure. */
export async function readLaunchctlPath(
  deps: UserPathDeps = defaultUserPathDeps(),
): Promise<string | null> {
  if (deps.platform !== "darwin") return null;
  const result = await deps.run("/bin/launchctl", ["getenv", "PATH"], LAUNCHCTL_TIMEOUT_MS);
  if (result.failed || result.timedOut) return null;
  return nonEmpty(result.stdout) ?? null;
}

/**
 * The PATH the daemon and every child it spawns should run with: login shell (else launchctl),
 * then the inherited PATH, then the curated directories, in order and without repeats.
 * Windows returns the inherited PATH untouched.
 */
export async function resolveUserPath(deps: UserPathDeps = defaultUserPathDeps()): Promise<string> {
  const inherited = deps.env.PATH ?? "";
  if (deps.platform === "win32") return inherited;
  const shellPath = await readLoginShellPath(deps);
  const sessionPath = shellPath ? null : await readLaunchctlPath(deps);
  return mergePathEntries(
    [shellPath ?? sessionPath, inherited, curatedPathDirectories(deps.platform).join(":")],
    ":",
  );
}

/**
 * Resolve the user's PATH and assign it to `env.PATH` (the daemon passes `process.env`, so
 * every execa call after this inherits it with no per-call-site change). Returns the value.
 */
export async function hydrateProcessPath(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<UserPathDeps> = {},
): Promise<string> {
  const resolved = await resolveUserPath({ ...defaultUserPathDeps(env), ...overrides, env });
  if (resolved) env.PATH = resolved;
  return resolved;
}
