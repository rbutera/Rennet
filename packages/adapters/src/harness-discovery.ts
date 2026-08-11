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

// ── Codex discovery (bead workspace-6qp15) ─────────────────────────────────────
//
// `codex` cannot be resolved by a plain PATH lookup. On this class of machine the
// `codex` on PATH is the asdf SHIM, which defers to asdf's per-directory version
// resolution and, under version drift, launches a broken/missing install — one
// real install on this machine 400s with `ENOENT` on its vendored native binary.
// The DEPENDABLE binary is the absolute install path
// `~/.asdf/installs/nodejs/<ver>/bin/codex`. So, exactly like `discoverClaude`, we
// never trust bare `codex`: we harvest candidate directories (login-shell PATH +
// env PATH + curated locations INCLUDING every asdf node install's `bin`), resolve
// each `codex`, prove it by EXECUTING `codex --version`, and prefer a real install
// over the shim. Resolving to an ABSOLUTE path is what stops the Codex seat from
// silently failing to launch — dual-model degrading to single-Claude at the
// PROCESS layer (a different layer than the #212 schema fix).

const CODEX_BINARY = "codex";

/**
 * A codex-safe `--version` probe: stdin CLOSED and a hard timeout, both
 * load-bearing. A broken asdf install (missing vendored native binary) HANGS on
 * `codex --version` when stdin is an open pipe (observed: a multi-minute wedge);
 * closing stdin turns that hang into a fast non-zero exit. Without this, one
 * broken install poisons discovery for the whole app. The rest of the effects are
 * the shared `defaultDiscoveryDeps` (login-shell PATH harvest, listing, X_OK).
 */
export function defaultCodexDiscoveryDeps(): DiscoveryDeps {
  const base = defaultDiscoveryDeps();
  return {
    ...base,
    async probeVersion(path: string): Promise<string | null> {
      try {
        const result = await execa(path, ["--version"], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: 10_000,
        });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Curated codex locations, checked even when they are not on PATH. Every asdf node
 * install's `bin` is included (listed dynamically) so a real absolute binary is a
 * candidate even though normally only the shim is on PATH. The shims directory is
 * included too — but DEMOTED at ranking time, so a real install always wins.
 */
async function codexKnownDirectories(
  home: string,
  listDir: (directory: string) => Promise<readonly string[]>,
): Promise<{ readonly dirs: readonly string[]; readonly shimsDir: string }> {
  const asdfInstallsRoot = join(home, ".asdf", "installs", "nodejs");
  const versions = await listDir(asdfInstallsRoot);
  const asdfInstallBins = versions.map((version) => join(asdfInstallsRoot, version, "bin"));
  const shimsDir = join(home, ".asdf", "shims");
  return {
    dirs: [
      ...asdfInstallBins,
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".bun", "bin"),
      join(home, ".volta", "bin"),
      shimsDir,
    ],
    shimsDir,
  };
}

/** True when `binaryPath` is the codex under the asdf shims directory — the
 *  unreliable indirection we prefer to skip whenever a real install is present. */
function isAsdfShim(binaryPath: string, shimsDir: string): boolean {
  return binaryPath === join(shimsDir, CODEX_BINARY);
}

/** Options for {@link discoverCodex}. */
export interface DiscoverCodexOptions {
  /**
   * An operator-configured absolute `codex` path (the composition root passes
   * `RENNET_CODEX_BIN`). Honoured only if it actually answers `--version`; a
   * stale/broken override falls through to normal discovery rather than bricking
   * the app.
   */
  readonly explicitBin?: string;
}

/**
 * Resolve an ABSOLUTE `codex` binary. Resolution order: (1) an explicit override
 * that probes to a version, else (2) the union of login-shell PATH + env PATH +
 * curated codex locations, each resolved, X_OK-checked, and PROVEN by executing
 * `codex --version`, ranked to prefer a real install over the asdf shim and then
 * the highest version. Returns `chosen: null` with an `unavailable` health when
 * nothing resolvable is found, so the caller fails LOUD (no Codex seat) rather
 * than launching a bad `codex` that would silently degrade dual-model to single.
 */
export async function discoverCodex(
  deps: DiscoveryDeps,
  options: DiscoverCodexOptions = {},
): Promise<DiscoveryResult> {
  // (1) Explicit override wins, but only if it truly runs.
  if (options.explicitBin !== undefined && options.explicitBin.length > 0) {
    const path = options.explicitBin;
    if (await deps.isExecutable(path)) {
      const version = await deps.probeVersion(path);
      if (version !== null) {
        return {
          candidates: [{ path, version, fromKnownLocation: true }],
          chosen: { path, version },
          health: { state: "ready", version },
        };
      }
    }
  }

  const { dirs: known, shimsDir } = await codexKnownDirectories(deps.home, deps.listDir);
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
    if (!entries.includes(CODEX_BINARY)) continue;
    const path = join(directory, CODEX_BINARY);
    if (resolved.has(path)) continue;
    if (!(await deps.isExecutable(path))) continue;
    resolved.add(path);
    const version = await deps.probeVersion(path);
    candidates.push({ path, version, fromKnownLocation: knownSet.has(directory) });
  }

  const withVersion = candidates.filter(
    (candidate): candidate is DiscoveredCandidate & { version: string } =>
      candidate.version !== null,
  );
  const ranked = [...withVersion].sort((left, right) => {
    // A real install beats the asdf shim, whatever their reported versions.
    const leftShim = isAsdfShim(left.path, shimsDir);
    const rightShim = isAsdfShim(right.path, shimsDir);
    if (leftShim !== rightShim) return leftShim ? 1 : -1;
    // Then a curated known location beats a bare PATH hit.
    if (left.fromKnownLocation !== right.fromKnownLocation) return left.fromKnownLocation ? -1 : 1;
    // Then the highest version.
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
            ? "A codex binary was found but did not report a version."
            : "No codex binary found on PATH or in any known location.",
      },
    };
  }

  return {
    candidates,
    chosen: { path: best.path, version: best.version },
    health: { state: "ready", version: best.version },
  };
}
