import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix as posixPath, resolve, win32 as win32Path } from "node:path";
import {
  type HarnessHealth,
  HOST_LOCUS,
  type Locus,
  locusCommand,
  toWindowsView,
} from "@rennet/core";
import { execa } from "execa";

/**
 * Join path segments for a platform, NOT the host's (add-windows-support). A Windows
 * host resolving a WSL distro's dirs must build POSIX paths (`/home/u/.local/bin`),
 * so the distro/POSIX branch uses `path.posix.join`; the Windows branch uses win32.
 */
function joinFor(platform: NodeJS.Platform | undefined): (...parts: string[]) => string {
  return platform === "win32" ? win32Path.join : posixPath.join;
}

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
  /**
   * The platform the binaries live on (add-windows-support). `win32` ⇒ `;`-delimited
   * PATH, PATHEXT shim matching (`claude.cmd`/`.exe`/…), Windows curated dirs. Absent
   * ⇒ POSIX (macOS/Linux, and the Linux INSIDE a WSL distro). This is the platform of
   * the LOCUS, not necessarily of the host running Rennet.
   */
  readonly platform?: NodeJS.Platform;
  /** The locus these candidates belong to (add-windows-support). Absent ⇒ host. */
  readonly locus?: Locus;
}

export interface DiscoveredCandidate {
  readonly path: string;
  readonly version: string | null;
  /** True when the path came from a curated known location rather than a PATH entry. */
  readonly fromKnownLocation: boolean;
  /** The locus this candidate lives on (add-windows-support). */
  readonly locus: Locus;
}

/** The PATH delimiter for a platform: `;` on Windows, `:` elsewhere. */
function delimiterFor(platform: NodeJS.Platform | undefined): string {
  return platform === "win32" ? ";" : ":";
}

// The executable shim extensions discovery recognises on Windows (PATHEXT subset,
// plus the bare name for a wrapperless install). `.cmd` first: npm global installs
// `claude.cmd`/`codex.cmd`, the common case.
const WINDOWS_BINARY_EXTENSIONS = [".cmd", ".exe", ".bat", ".ps1", ""] as const;

/**
 * Resolve which filename in a directory listing IS the binary, honouring Windows
 * shims (add-windows-support). POSIX: the bare name if present. Windows: the first
 * of `name.cmd`/`.exe`/`.bat`/`.ps1`/`name` that the directory actually contains.
 */
function resolveBinaryFilename(
  entries: readonly string[],
  base: string,
  platform: NodeJS.Platform | undefined,
): string | null {
  if (platform === "win32") {
    for (const extension of WINDOWS_BINARY_EXTENSIONS) {
      const candidate = `${base}${extension}`;
      if (entries.includes(candidate)) return candidate;
    }
    return null;
  }
  return entries.includes(base) ? base : null;
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

/** Curated Windows per-user install locations for `base` (`claude`/`codex`). */
function windowsKnownDirectories(base: string): readonly string[] {
  const join = win32Path.join;
  const env = process.env;
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;
  const userProfile = env.USERPROFILE ?? env.HOME ?? "";
  const dirs: string[] = [];
  // npm global (`%APPDATA%\npm\claude.cmd`), the most common shim location.
  if (appData) dirs.push(join(appData, "npm"));
  if (localAppData) {
    dirs.push(join(localAppData, "Programs", base)); // per-user "Programs" installs
    dirs.push(join(localAppData, base, "bin"));
  }
  if (userProfile) {
    dirs.push(join(userProfile, ".local", "bin"));
    dirs.push(join(userProfile, ".bun", "bin"));
    dirs.push(join(userProfile, "scoop", "shims")); // scoop per-user
    dirs.push(join(userProfile, ".volta", "bin"));
  }
  return dirs;
}

/**
 * Curated locations, checked even when they are not on PATH (the launchd case, and
 * the GUI-inherited-PATH case). POSIX by default; on Windows the per-user install
 * dirs; inside a WSL distro the POSIX set plus linuxbrew (add-windows-support).
 */
function knownDirectories(home: string, platform: NodeJS.Platform | undefined): readonly string[] {
  if (platform === "win32") {
    return [...windowsKnownDirectories(CLAUDE_BINARY)];
  }
  const join = posixPath.join;
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".volta", "bin"),
  ];
}

function splitPath(value: string, delimiter: string): readonly string[] {
  return value.split(delimiter).filter((entry) => entry.length > 0);
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
  const locus = deps.locus ?? HOST_LOCUS;
  const delimiter = delimiterFor(deps.platform);
  const join = joinFor(deps.platform);
  const known = knownDirectories(deps.home, deps.platform);
  const knownSet = new Set(known);
  const harvested = await deps.loginShellPath();
  const directories: string[] = [];
  const seen = new Set<string>();
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

  const candidates: DiscoveredCandidate[] = [];
  const resolved = new Set<string>();
  for (const directory of directories) {
    const entries = await deps.listDir(directory);
    const filename = resolveBinaryFilename(entries, CLAUDE_BINARY, deps.platform);
    if (filename === null) continue;
    const path = join(directory, filename);
    if (resolved.has(path)) continue;
    if (!(await deps.isExecutable(path))) continue;
    resolved.add(path);
    const version = await deps.probeVersion(path);
    candidates.push({ path, version, fromKnownLocation: knownSet.has(directory), locus });
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
    // Name the distro in the reason so a WSL-locus miss reads "…inside the Ubuntu
    // distro", never a host binary silently chosen (harness-discovery spec).
    const where = locus.kind === "wsl" ? ` inside the ${locus.distro} distro` : "";
    return {
      candidates,
      chosen: null,
      health: {
        state: "unavailable",
        reason: candidates.length > 0 ? "spawn-failed" : "not-found",
        detail:
          candidates.length > 0
            ? `A claude binary was found${where} but did not report a version.`
            : `No claude binary found on PATH or in any known location${where}.`,
      },
    };
  }

  return {
    candidates,
    chosen: { path: best.path, version: best.version },
    health: healthFor(best.version, range),
  };
}

/**
 * The default effects: real login shell, filesystem, and process execution.
 *
 * On Windows there is NO POSIX login shell to harvest (windows-native-runtime spec):
 * `loginShellPath` returns `null` and discovery proceeds from the process env plus
 * the curated Windows locations, and `probeVersion` runs the shim directly (execa
 * launches a `.cmd`/`.bat` through the Windows launcher). PATH is `;`-delimited and
 * candidate matching honours PATHEXT — all driven by `platform`.
 */
export function defaultDiscoveryDeps(): DiscoveryDeps {
  const platform = process.platform;
  return {
    platform,
    locus: HOST_LOCUS,
    async loginShellPath(): Promise<string | null> {
      if (platform === "win32") return null; // no POSIX shell on Windows
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
      // On Windows, X_OK is not meaningful for a `.cmd`/`.exe`; presence + a readable
      // check is the signal, and the version probe is the real proof (as on POSIX).
      try {
        await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
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

// ── WSL-locus discovery (add-windows-support) ──────────────────────────────────
//
// Discovery INSIDE a distro: the exact POSIX algorithm above, executed across the
// wsl.exe boundary. PATH is harvested from the distro's login shell, directory
// listings read the distro filesystem through its `\\wsl.localhost\<distro>\…` UNC
// view (spike: UNC reads are clean), and executability/version probes run the
// candidate INSIDE the distro via `wsl.exe … -e`. Every candidate is stamped with
// the WSL locus, so a host binary can never satisfy a WSL-locus project: the
// composition picks these deps for a WSL project and the host deps for a host one.

/** Run a fixed-literal command in the distro and return trimmed stdout, or null. */
async function wslProbe(distro: string, argv: readonly string[]): Promise<string | null> {
  const command = locusCommand({ kind: "wsl", distro }, argv[0] ?? "", argv.slice(1));
  try {
    const result = await execa(command.file, [...command.args], {
      reject: false,
      shell: false,
      stdin: "ignore",
    });
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * Discovery effects for a WSL distro. `home`/`loginShellPath` are harvested from the
 * distro's own login shell (a fixed-literal `bash -lc` payload — the one sanctioned
 * `-e bash -lc` use, since the payload is not user data). Listings read the distro
 * via UNC; executability and version probes run inside the distro. Async because the
 * distro home must be probed before the deps can be built.
 */
export async function wslDiscoveryDeps(distro: string): Promise<DiscoveryDeps> {
  const locus: Locus = { kind: "wsl", distro };
  const home = (await wslProbe(distro, ["bash", "-lc", 'printf %s "$HOME"'])) ?? "/root";
  return {
    platform: "linux",
    locus,
    home,
    envPath: "", // the distro's PATH is harvested via loginShellPath, not the host env
    loginShellPath: () => wslProbe(distro, ["bash", "-lc", 'printf %s "$PATH"']),
    async listDir(directory: string): Promise<readonly string[]> {
      try {
        return await readdir(toWindowsView(directory, distro));
      } catch {
        return [];
      }
    },
    async isExecutable(path: string): Promise<boolean> {
      const command = locusCommand(locus, "test", ["-x", path]);
      try {
        const result = await execa(command.file, [...command.args], {
          reject: false,
          shell: false,
          stdin: "ignore",
        });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    async probeVersion(path: string): Promise<string | null> {
      const command = locusCommand(locus, path, ["--version"]);
      try {
        const result = await execa(command.file, [...command.args], {
          reject: false,
          shell: false,
          stdin: "ignore",
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

/** WSL codex discovery: the WSL deps with the codex-safe (stdin-closed, timed) probe. */
export async function wslCodexDiscoveryDeps(distro: string): Promise<DiscoveryDeps> {
  const base = await wslDiscoveryDeps(distro);
  const locus: Locus = { kind: "wsl", distro };
  return {
    ...base,
    async probeVersion(path: string): Promise<string | null> {
      const command = locusCommand(locus, path, ["--version"]);
      try {
        const result = await execa(command.file, [...command.args], {
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
  platform: NodeJS.Platform | undefined,
): Promise<{ readonly dirs: readonly string[]; readonly shimsDir: string }> {
  if (platform === "win32") {
    // Windows codex installs are npm/scoop shims, not asdf; no asdf-install scan.
    return { dirs: windowsKnownDirectories(CODEX_BINARY), shimsDir: "" };
  }
  const join = posixPath.join;
  const asdfInstallsRoot = join(home, ".asdf", "installs", "nodejs");
  const versions = await listDir(asdfInstallsRoot);
  const asdfInstallBins = versions.map((version) => join(asdfInstallsRoot, version, "bin"));
  const shimsDir = join(home, ".asdf", "shims");
  return {
    dirs: [
      ...asdfInstallBins,
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/home/linuxbrew/.linuxbrew/bin",
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
  return shimsDir.length > 0 && binaryPath === posixPath.join(shimsDir, CODEX_BINARY);
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
    // Normalize to ABSOLUTE: codex-exec spawns from a fresh scratch cwd, so a
    // relative override (e.g. "codex") must be anchored against the app's cwd
    // HERE, at resolution time, not left to resolve against the wrong dir later.
    const path = resolve(options.explicitBin);
    if (await deps.isExecutable(path)) {
      const version = await deps.probeVersion(path);
      if (version !== null) {
        return {
          candidates: [{ path, version, fromKnownLocation: true, locus: HOST_LOCUS }],
          chosen: { path, version },
          health: { state: "ready", version },
        };
      }
    }
  }

  const locus = deps.locus ?? HOST_LOCUS;
  const delimiter = delimiterFor(deps.platform);
  const join = joinFor(deps.platform);
  const { dirs: known, shimsDir } = await codexKnownDirectories(
    deps.home,
    deps.listDir,
    deps.platform,
  );
  const knownSet = new Set(known);
  const harvested = await deps.loginShellPath();
  const directories: string[] = [];
  const seen = new Set<string>();
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

  const candidates: DiscoveredCandidate[] = [];
  const resolved = new Set<string>();
  for (const directory of directories) {
    const entries = await deps.listDir(directory);
    const filename = resolveBinaryFilename(entries, CODEX_BINARY, deps.platform);
    if (filename === null) continue;
    // Host: normalize to ABSOLUTE so a relative PATH entry (e.g. ".") never yields a
    // relative `chosen.path` that codex-exec would resolve against its scratch cwd.
    // WSL: keep the distro-native POSIX path (resolve would corrupt it on a Windows host).
    const joined = join(directory, filename);
    const path = locus.kind === "host" ? resolve(joined) : joined;
    if (resolved.has(path)) continue;
    if (!(await deps.isExecutable(path))) continue;
    resolved.add(path);
    const version = await deps.probeVersion(path);
    candidates.push({ path, version, fromKnownLocation: knownSet.has(directory), locus });
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
    const where = locus.kind === "wsl" ? ` inside the ${locus.distro} distro` : "";
    return {
      candidates,
      chosen: null,
      health: {
        state: "unavailable",
        reason: candidates.length > 0 ? "spawn-failed" : "not-found",
        detail:
          candidates.length > 0
            ? `A codex binary was found${where} but did not report a version.`
            : `No codex binary found on PATH or in any known location${where}.`,
      },
    };
  }

  return {
    candidates,
    chosen: { path: best.path, version: best.version },
    health: { state: "ready", version: best.version },
  };
}
