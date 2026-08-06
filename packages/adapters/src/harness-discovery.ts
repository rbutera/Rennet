import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessHealth } from "@rennet/core";
import { execa } from "execa";

/**
 * Harness discovery (slice 1, Claude Code only).
 *
 * The finding that motivates every line here: a GUI app launched from Finder
 * inherits launchd's minimal PATH, which finds neither `claude` nor `codex` on
 * this machine, and in an interactive shell both are shell FUNCTIONS, so
 * `which`/`command -v` return a function body, not a path. So we never ask a
 * shell to resolve a binary. We harvest PATH, union it with known locations,
 * resolve candidates ourselves with readdir + X_OK, and prove each one is real
 * by EXECUTING it. Every effect is injected so the whole thing is testable and
 * so a test can prove we never touch a credential file.
 */

export interface DiscoveryDeps {
  /** The user's login-shell PATH, harvested once. `null` when the harvest fails. */
  loginShellPath(): Promise<string | null>;
  /** `process.env.PATH` at app start. */
  readonly envPath: string;
  /** The user's home directory. */
  readonly home: string;
  /** Directory listing; returns `[]` on any error (missing dir, permission). */
  listDir(directory: string): Promise<readonly string[]>;
  /** X_OK check on a resolved path. */
  isExecutable(path: string): Promise<boolean>;
  /** Execute `<path> --version` and return the parsed version, or `null`. */
  probeVersion(path: string): Promise<string | null>;
}

export interface DiscoveredCandidate {
  readonly path: string;
  readonly version: string | null;
  /** True when the path came from a curated known location rather than a PATH entry. */
  readonly fromKnownLocation: boolean;
}

export interface DiscoveryResult {
  readonly candidates: readonly DiscoveredCandidate[];
  readonly chosen: { readonly path: string; readonly version: string } | null;
  readonly health: HarnessHealth;
}

export interface VersionRange {
  readonly min: string;
  readonly maxTested: string;
}

const CLAUDE_BINARY = "claude";

/** Curated locations, checked even when they are not on PATH (the launchd case). */
function knownDirectories(home: string): readonly string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".volta", "bin"),
  ];
}

function splitPath(value: string): readonly string[] {
  return value.split(":").filter((entry) => entry.length > 0);
}

/** Numeric-tuple version compare. Returns <0, 0, or >0. Non-numeric segments sort as 0. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.parseInt(leftParts[index] ?? "0", 10) || 0;
    const rightValue = Number.parseInt(rightParts[index] ?? "0", 10) || 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function healthFor(version: string, range: VersionRange): HarnessHealth {
  if (compareVersions(version, range.min) < 0) {
    return { state: "degraded", version, reason: "below-floor" };
  }
  if (compareVersions(version, range.maxTested) > 0) {
    return { state: "degraded", version, reason: "above-tested" };
  }
  return { state: "ready", version };
}

export async function discoverClaude(
  deps: DiscoveryDeps,
  range: VersionRange,
): Promise<DiscoveryResult> {
  const known = knownDirectories(deps.home);
  const knownSet = new Set(known);
  const harvested = await deps.loginShellPath();
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const directory of [...splitPath(harvested ?? ""), ...splitPath(deps.envPath), ...known]) {
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }

  const candidates: DiscoveredCandidate[] = [];
  const resolved = new Set<string>();
  for (const directory of directories) {
    const entries = await deps.listDir(directory);
    if (!entries.includes(CLAUDE_BINARY)) continue;
    const path = join(directory, CLAUDE_BINARY);
    if (resolved.has(path)) continue;
    if (!(await deps.isExecutable(path))) continue;
    resolved.add(path);
    const version = await deps.probeVersion(path);
    candidates.push({ path, version, fromKnownLocation: knownSet.has(directory) });
  }

  // Rank: a known-location hit with a version first, then highest version, then
  // PATH order (already the insertion order of `candidates`).
  const withVersion = candidates.filter(
    (candidate): candidate is DiscoveredCandidate & { version: string } =>
      candidate.version !== null,
  );
  const ranked = [...withVersion].sort((left, right) => {
    if (left.fromKnownLocation !== right.fromKnownLocation) return left.fromKnownLocation ? -1 : 1;
    return compareVersions(right.version, left.version);
  });
  const best = ranked[0];

  if (!best) {
    return {
      candidates,
      chosen: null,
      health: {
        state: "unavailable",
        reason: candidates.length > 0 ? "spawn-failed" : "not-found",
        detail:
          candidates.length > 0
            ? "A claude binary was found but did not report a version."
            : "No claude binary found on PATH or in any known location.",
      },
    };
  }

  return {
    candidates,
    chosen: { path: best.path, version: best.version },
    health: healthFor(best.version, range),
  };
}

/** The default effects: real login shell, filesystem, and process execution. */
export function defaultDiscoveryDeps(): DiscoveryDeps {
  return {
    async loginShellPath(): Promise<string | null> {
      const shell = process.env.SHELL ?? "/bin/zsh";
      try {
        const result = await execa(shell, ["-ilc", 'printf %s "$PATH"'], {
          reject: false,
          shell: false,
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
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async probeVersion(path: string): Promise<string | null> {
      try {
        const result = await execa(path, ["--version"], { reject: false, shell: false });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
  };
}
